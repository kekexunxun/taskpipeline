import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIDialogOptions,
  type ExtensionUIContext
} from '@earendil-works/pi-coding-agent'
import {
  TaskStore,
  LocalFileKeyStore,
  boardColumnFor,
  transitionTask,
  type AgentEvent,
  type AgentProfile,
  type Memory,
  type SettingResolver,
  type Task,
  type TaskEventSink,
  type TaskRepository,
  type TaskStartMode,
  type TaskState,
  type TraceKind
} from '@coding-agent/core'
import {
  AtlassianClientFactory,
  DeliveryService,
  fetchJiraTasks,
  GitService,
  importJiraIssue,
  MergeStatusRefresher,
  openTaskEditor,
  OpenCodeReviewService,
  OpenAICompatReviewer,
  redactSecrets,
  ReviewOrchestrator,
  TaskCompleter,
  TaskWorkflow,
  testAtlassianConnection,
  asReviewer,
  type RepositoryCommandMap
} from '@coding-agent/integrations'
import {
  accessToken,
  query,
  type AccountInfo,
  type ModelInfo,
  type Query,
  type UsageInfo
} from '@qoder-ai/qoder-agent-sdk'
import { TraceService } from './trace/trace-service.js'
import { QoderTraceSink } from './trace/qoder-trace.js'
import { resolveBundledOcrBinary, resolveOcrBinary, createOcrRunner } from './ocr.js'
import { parsePlanDecision } from './plan-content.js'
import { ChatService } from './chat/chat-service.js'
import { ChatDriverRegistry } from './chat/drivers/driver-registry.js'
import { QoderChatDriver } from './chat/drivers/qoder-chat-driver.js'
import { OpenAIChatDriver } from './chat/drivers/openai-chat-driver.js'
import { JiraTaskCreationBackend } from './chat/task-backends/jira.js'
import type { ChatDriverId, ChatConversation } from './chat/chat-types.js'
import { MemoryService, renderMemoryContext } from './memory/memory-service.js'
import { extractMemories } from './memory/memory-extractor.js'
import {
  implementationOutcomeInstruction,
  isExplicitNoChangeCompletionRequest,
  nextStepForImplementation,
  nextStepForPlan,
  parseImplementationDecision
} from './task-readiness.js'
import { QoderTaskAgentDriver } from './task-agent/qoder-task-agent.js'
import { describeToolAction, isDangerousTool } from './task-agent/dangerous-tools.js'
import { closeQoderQuerySafely, recordQoderMessage } from './task-agent/log.js'
import { parseTestCaseGeneration } from './task-agent/parsers/test-case-parser.js'
import { AgentService, type OperationKind } from './agents/agent-service.js'
import { AGENT_TEMPLATES } from './agents/templates.js'
import {
  buildAgentGenerationPrompt,
  formatAgentGenerationDetail,
  formatRepoContext,
  parseAgentGenerationResult,
  type AgentGenerationRepository,
  type RepoContextEntry
} from './agents/agent-generator.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
/**
 * 「AI 生成 Agent 模板」用的一次性哨兵 taskId。
 * 这类调用不挂任何任务 —— events 表对 task_id 有 FK 约束，
 * `callQoderReviewer` 内部会读 `store.getTask(taskId)` 识别哨兵，跳过 `recordQoderMessage`
 * （包含 addEvent / updateTask / emitPi），避免外键异常。
 */
const AGENT_GENERATOR_TASK_ID = '__agent_generator__'
let mainWindow: BrowserWindow | undefined
let piSession: AgentSession | undefined
let unsubscribePi: (() => void) | undefined
const pendingUi = new Map<string, (response: Record<string, unknown>) => void>()
const dataDir = process.env.CODING_AGENT_DATA_DIR ?? join(app.getPath('userData'), 'data')
process.env.CODING_AGENT_DATA_DIR = dataDir
mkdirSync(dataDir, { recursive: true })
const store = new TaskStore(join(dataDir, 'coding-agent.db'))
const keyStore = new LocalFileKeyStore(dataDir)
const memoryService = new MemoryService(store)
// Agent 体系：可配置多 Agent + 仓库白名单绑定 + 模型路由（配置存 settings key `agentProfiles`）。
const agentService = new AgentService(
  (key) => store.getSetting(key),
  (key, value) => store.setSetting(key, value),
  (repositoryId) => memoryService.listRepoWikiDocs(repositoryId)
)
let activeTaskId: string | undefined
let activeQoderQuery: Query | undefined
let activeQoderAbort: AbortController | undefined
let activePlanningTaskId: string | undefined
let activePlanText = ''
type ActiveTaskOperation = { controller: AbortController; promise: Promise<unknown> }
const activeTaskOperations = new Map<string, ActiveTaskOperation>()

type ModelProfile = { provider?: string; baseUrl?: string; model?: string; apiKeyEnv?: string }
type QoderStatus = {
  enabled: boolean
  connected: boolean
  running: boolean
  account?: AccountInfo
  usage?: UsageInfo | null
  models: Array<
    Pick<
      ModelInfo,
      'value' | 'displayName' | 'description' | 'isDefault' | 'isEnabled' | 'isReasoning' | 'isVl' | 'priceFactor'
    >
  >
  error?: string
}

const taskStateLabels: Record<Task['state'], string> = {
  draft: '待处理',
  confirmed: '已确认',
  preparing: '准备环境',
  implementing: '实现中',
  planning: '计划中',
  awaiting_plan_approval: '等待计划确认',
  paused: '已暂停',
  awaiting_input: '等待补充',
  generating_tests: '生成测试用例中',
  validating: '校验中',
  validation_failed: '校验失败',
  awaiting_review: '等待 Review',
  reviewing: 'Review 中',
  review_blocked: 'Review 阻断',
  awaiting_commit: '等待提交 MR',
  delivering: '提交 MR 中',
  await_merge: '等待合并',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消'
}

// === 抽象层宿主实现 ===========================================================

class DesktopEventSink implements TaskEventSink {
  addEvent(input: Omit<AgentEvent, 'id' | 'createdAt'>): AgentEvent {
    const event = store.addEvent(input)
    emitTaskChanged(input.taskId)
    return event
  }
  emitChanged(taskId: string): void {
    emitTaskChanged(taskId)
  }
}

class DesktopSettingResolver implements SettingResolver {
  get(key: string): string | undefined {
    return store.getSetting(key)
  }
  getSecret(key: string, envName?: string): string | undefined {
    if (envName && process.env[envName]) return process.env[envName]
    return keyStore.resolve(store.getSetting(key), key)
  }
}

const desktopSink = new DesktopEventSink()
const desktopResolver = new DesktopSettingResolver()

// === 通用工具 =================================================================

function protectedValue(key: string): string | undefined {
  return keyStore.resolve(store.getSetting(key), key)
}
function taskWorkspace(taskId: string): string {
  return join(dataDir, 'workspaces', taskId)
}
function sendTaskEvent(event: Record<string, unknown>): void {
  const json = JSON.stringify(event, (_key, value) => (typeof value === 'string' ? redactSecrets(value) : value))
  mainWindow?.webContents.send('task:event', JSON.parse(json) as unknown)
}
function emitTaskChanged(taskId: string): void {
  sendTaskEvent({ type: 'task_changed', taskId })
}
function addTaskEvent(event: Parameters<TaskStore['addEvent']>[0]): void {
  store.addEvent(event)
  emitTaskChanged(event.taskId)
}
function updatePiUsage(taskId: string): void {
  if (!piSession) return
  const stats = piSession.getSessionStats()
  store.updateTask(taskId, {
    sessionUsage: {
      provider: 'openai',
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
      totalTokens: stats.tokens.total,
      costUsd: stats.cost,
      turns: stats.assistantMessages
    }
  })
  emitTaskChanged(taskId)
}
function updateState(task: Task, state: Task['state']): Task {
  if (task.state !== state) transitionTask(task.state, state)
  const updated = store.updateTask(task.id, { state })
  addTaskEvent({ taskId: task.id, kind: 'status', title: `状态更新为 ${taskStateLabels[state]}` })
  return updated
}

// 把 Atlassian MCP 调用失败包装成"操作名 + 原因"的中文错误，渲染端会直接展示这条消息。
// 原始堆栈写到主进程日志，便于排查；避免把 "MCP request timeout: initialize" 这种无操作意义的
// 内部消息直接给到用户。
async function safeAtlassianCall<T>(action: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[atlassian] ${action} failed:`, error)
    throw new Error(`${action}失败：${reason}`)
  }
}

function runTaskOperation<T>(taskId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  activeTaskOperations.get(taskId)?.controller.abort(new Error('新的任务操作已开始'))
  const controller = new AbortController()
  const promise = Promise.resolve().then(() => action(controller.signal))
  const operation: ActiveTaskOperation = { controller, promise }
  activeTaskOperations.set(taskId, operation)
  void promise
    .finally(() => {
      if (activeTaskOperations.get(taskId) === operation) activeTaskOperations.delete(taskId)
    })
    .catch(() => undefined)
  return promise
}

function modelProvider(): 'qoder' | 'openai' {
  const raw = store.getSetting('modelProfile')
  if (!raw) return 'qoder'
  try {
    return JSON.parse(raw).provider === 'qoder' ? 'qoder' : 'openai'
  } catch {
    return 'qoder'
  }
}

/**
 * 任务级执行路径：primary 仓库 Agent 的 preferredProvider 优先，未配置时跟随系统 modelProfile。
 * 优先级链：任务显式 task.qoderModel > Agent.preferredProvider > 系统全局。
 */
function runtimeProvider(task: Task): 'qoder' | 'openai' {
  const runtime = agentService.resolveRuntime(task, store.listTaskRepositories(task.id))
  return runtime.provider ?? modelProvider()
}

/** 任务级 provider（usage 统计等场景）；任务不存在时跟随系统。 */
function providerForTask(taskId: string | undefined): 'qoder' | 'openai' {
  const task = taskId ? store.getTask(taskId) : undefined
  return task ? runtimeProvider(task) : modelProvider()
}

/**
 * piSession 路径的完整 prompt 组装：Agent 指引段在最前，其次 memoryContext，最后任务正文。
 * OpenAI 路径的 resume 是重新 prompt（新会话无原上下文），因此与 Qoder 路径不同，需要注入。
 */
async function buildAgentPrompt(task: Task, body: string): Promise<string> {
  const repos = store.listTaskRepositories(task.id)
  const [agentContext, memoryContext] = await Promise.all([
    agentService.resolveAgentContext(task, repos),
    taskMemoryContext(task, repos)
  ])
  const sections = agentContext.sections
  if (sections.length)
    addTaskEvent({ taskId: task.id, kind: 'status', title: '注入 Agent 上下文', detail: sections.join('\n\n') })
  return `${sections.length ? `${sections.join('\n\n')}\n\n` : ''}${memoryContext ? `${memoryContext}\n\n` : ''}${body}`
}

/** 启动校验：路由到 qoder 但未配置 Token 时明确报错，不静默切换执行路径。 */
function qoderTokenGuard(task: Task): void {
  if (runtimeProvider(task) !== 'qoder' || protectedValue('qoderToken')) return
  const agent = agentService.resolveAgentFor(
    store.listTaskRepositories(task.id)[0]?.repositoryId ?? '',
    task.agentProfileId,
    task.repoAgentIds?.[store.listTaskRepositories(task.id)[0]?.repositoryId ?? '']
  )
  throw new Error(
    agent
      ? `Agent「${agent.name}」指定了 Qoder 模型，请先配置 Qoder Token`
      : '任务路由到 Qoder 路径，请先配置 Qoder Token'
  )
}

// === 下沉模块实例(整个进程单例) ===============================================

const ocrService = new OpenCodeReviewService(resolveOcrBinary(), createOcrRunner())
const gitService = new GitService()
const openAIReviewer = new OpenAICompatReviewer(desktopResolver)
function buildReviewOrchestrator(): ReviewOrchestrator {
  return new ReviewOrchestrator(
    { ocr: ocrService, git: gitService, reviewer: asReviewer(callQoderOrOpenAIReviewer) },
    desktopSink
  )
}
const taskWorkflow = new TaskWorkflow(store, desktopResolver, desktopSink, taskWorkspace)

/**
 * 交付确认点（commit / push / 建 MR）：HITL 的核心拦截。
 *
 * 每次提交前弹 UI 确认框，用户拒绝则 DeliveryService 不执行该步骤并退到 awaiting_commit。
 * 确认请求与结果都会写入 Approval 表，形成可审计的审批记录。
 */
const deliveryStepLabels: Record<'commit' | 'push' | 'merge_request', string> = {
  commit: '提交代码',
  push: '推送分支',
  merge_request: '创建 Merge Request'
}
async function deliveryApprover(
  task: Task,
  kind: 'commit' | 'push' | 'merge_request',
  context: string
): Promise<boolean> {
  const label = deliveryStepLabels[kind]
  const approval = store.addApproval({ taskId: task.id, kind, context })
  const ok =
    (await requestUi<boolean>(
      'confirm',
      { title: `确认${label}`, message: context, taskId: task.id },
      { timeout: 10 * 60_000 } // 超时默认拒绝（安全兜底），用户仍可手动重试提交
    )) ?? false
  store.resolveApproval(approval.id, ok ? 'approved' : 'rejected')
  addTaskEvent({
    taskId: task.id,
    kind: 'permission',
    title: ok ? `已确认${label}` : `已拒绝${label}`,
    detail: context
  })
  return ok
}

const deliveryService = new DeliveryService(store, gitService, desktopResolver, desktopSink, {
  approver: deliveryApprover,
  describeMergeRequest: async (task, repo, signal) => {
    // const repos = store.listTaskRepositories(task.id)
    const body = [
      `## 任务信息\n${task.title}\n${task.description}`,
      `## 仓库\n${repo.name}`,
      `## 变更文件统计\n${repo.featureBranch ? `分支: ${repo.featureBranch} -> ${repo.baseBranch}` : ''}`,
      '请根据任务信息与变更内容生成清晰的 Merge Request 描述。',
      '输出严格 JSON：',
      '{"commitMessage":"<可选>如果未达 commit 标准可以不填","title":"<MR 标题，简洁概括>","description":"<MR 描述，说明改动背景、内容与影响>"}',
      'description 使用中文。'
    ].join('\n\n')
    const text = await runOperationAgent(task.id, 'mr', body, signal)
    if (!text) throw new Error('MR 描述生成返回空')
    return JSON.parse(text)
  }
})
const mergeRefresher = new MergeStatusRefresher(store, desktopResolver, desktopSink)
const taskCompleter = new TaskCompleter(store, desktopSink)
const atlassianFactory = new AtlassianClientFactory(desktopResolver)

// Chat driver registry — 统一装 Qoder / OpenAI 两份 driver；后续接入更多 driver 仅需改此处。
const chatDriverRegistry = new ChatDriverRegistry()
chatDriverRegistry.register(new QoderChatDriver(() => protectedValue('qoderToken'), getQoderStatus))
chatDriverRegistry.register(new OpenAIChatDriver(store, () => protectedValue('modelApiKey')))

const chatService = new ChatService(
  store,
  dataDir,
  chatDriverRegistry,
  () => mainWindow,
  () => {
    // 任务创建 Agent：按 system setting 选 backend；目前仅 Jira 后端可用。
    // 未来接入 GitHub / Linear 时这里按 backendId 分发。
    if (resolveDefaultBackend() === 'jira') return new JiraTaskCreationBackend(atlassianFactory)
    return undefined
  },
  async ({ conversationId, query }) =>
    memoryService.buildSystemPrompt({ userId: memoryService.ensureUserId(), conversationId, query }),
  consolidateChatMemory
)

// Trace 服务：聚合任务 / 对话 / Pi 会话执行轨迹（Trace 页面数据源）。
// ④ pi-trace-extension 的 traces 目录默认在 ~/.pi/agent/traces，可用 settings `piAgentDir` 覆盖。
const traceService = new TraceService(store, chatService, dataDir, join(homedir(), '.pi', 'agent'))
// Qoder 执行 trace：任务消息流落盘为 dataDir/traces/qoder/<taskId>.jsonl（Trace 页 step 级展示）。
const qoderTraceSink = new QoderTraceSink(dataDir)

// Task agent driver — 负责"任务执行"路径(plan / implementation / test_generation)。
// 当前只注册 Qoder；接口已经摆好，后续接入其它 agent 运行时仅需 add() 一行。
function createQoderTaskAgent(): QoderTaskAgentDriver {
  return new QoderTaskAgentDriver({
    store,
    qoderTokenProvider: () => protectedValue('qoderToken'),
    dataDir,
    addTaskEvent,
    emitPi,
    emit: (event) => {
      // TaskAgentEvent 透传给 UI 通道(以及失败后续接 session id 持久化)。
      if (event.type === 'agent_session' && activeTaskId) {
        store.updateTask(activeTaskId, { qoderSessionId: event.sessionId })
      }
      // agent_start / agent_end 仍走 emitPi,让 task:event 通道能识别阶段。
      if (event.type === 'agent_start' || event.type === 'agent_end') {
        emitPi({ type: event.type, provider: 'qoder', taskId: activeTaskId, phase: event.phase })
        return
      }
      if (event.type === 'agent_text' && activeTaskId) {
        addTaskEvent({ taskId: activeTaskId, kind: 'message', title: 'Qoder Agent', detail: event.text })
        return
      }
      if (event.type === 'agent_error' && activeTaskId) {
        addTaskEvent({ taskId: activeTaskId, kind: 'error', title: 'Qoder Agent 错误', detail: event.message })
        return
      }
    },
    resolveMemoryContext: taskMemoryContext,
    // Agent 指引段：非 resume 场景注入 prompt 最前；Qoder 真实续接时由 runImplementation 不调用。
    resolveAgentContext: async (task, repos) => {
      const context = await agentService.resolveAgentContext(task, repos)
      if (context.sections.length)
        addTaskEvent({
          taskId: task.id,
          kind: 'status',
          title: '注入 Agent 上下文',
          detail: context.sections.join('\n\n')
        })
      return context
    },
    resolveModel: (task) => agentService.resolveModelForTask(task, store.listTaskRepositories(task.id)),
    // 测试用例生成阶段注入 Test Writer Agent 角色定义 + 上下文
    resolveTestContext: async (task, repos) => {
      const { roleBody, contextBody } = agentService.resolveOperationAgent('test', task, repos)
      const sections: string[] = []
      if (roleBody) sections.push(roleBody)
      if (contextBody) sections.push(contextBody)
      if (sections.length)
        addTaskEvent({ taskId: task.id, kind: 'status', title: '注入测试 Agent 上下文', detail: sections.join('\n\n') })
      return { sections }
    },
    onQueryStarted: (q, abort) => {
      // 把 driver 起的 query 暴露给顶层 abort 流程(stopTaskOperations 仍能 interrupt)。
      activeQoderQuery = q
      activeQoderAbort = abort
    },
    onQueryFinished: (q) => {
      if (activeQoderQuery === q) activeQoderQuery = undefined
      if (activeQoderAbort?.signal === undefined) activeQoderAbort = undefined
    },
    // Phase 2 HITL：危险工具调用确认（shell / git 写操作 / 删除类）。
    onPermissionRequest: async (taskId, toolName, toolInput, signal) => {
      if (!isDangerousTool(toolName, toolInput)) return 'allow'
      const detail = describeToolAction(toolName, toolInput)
      const approval = store.addApproval({ taskId, kind: 'permission', context: detail })
      addTaskEvent({ taskId, kind: 'permission', title: `请求执行危险操作:${toolName}`, detail })
      const ok =
        (await requestUi<boolean>(
          'confirm',
          { title: `允许执行 ${toolName}?`, message: detail, taskId },
          { timeout: 10 * 60_000, signal } // 会话中止/超时默认拒绝（安全兜底）
        )) ?? false
      store.resolveApproval(approval.id, ok ? 'approved' : 'rejected')
      return ok ? 'allow' : 'deny'
    }
  })
}

// === Review 实现(Qoder / OpenAI 兼容) =========================================

async function callQoderReviewer(
  prompt: string,
  taskId: string,
  model?: string,
  signal?: AbortSignal
): Promise<string> {
  const token = protectedValue('qoderToken')
  if (!token) throw new Error('请先配置 Qoder Token')
  const abort = new AbortController()
  const abortFromTask = () => abort.abort(signal?.reason)
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abortFromTask, { once: true })
  const q = query({
    prompt,
    options: {
      auth: accessToken(token),
      cwd: process.cwd(),
      abortController: abort,
      persistSession: false,
      permissionMode: 'default',
      controlRequestTimeoutMs: 15_000,
      ...(model ? { model } : {})
    }
  })
  const REVIEW_LLM_TIMEOUT_MS = 3 * 60_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort(new Error(`qoder review 在 ${REVIEW_LLM_TIMEOUT_MS / 1000}s 内未返回,主动 abort`))
      reject(new Error(`qoder review 在 ${REVIEW_LLM_TIMEOUT_MS / 1000}s 内未返回,主动 abort`))
    }, REVIEW_LLM_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      (async () => {
        let text = ''
        for await (const message of q) {
          // 哨兵 taskId（如 AI 生成 Agent 模板的 `__agent_generator__`）不挂任务 —— recordQoderMessage 内部
          // 会识别（任务不存在时早返），不会触发 events 表 FK 异常或 updateTask 'Task not found' 异常。
          recordQoderMessage(store, taskId, message, { recordText: true, addTaskEvent, emitPi })
          if (message.type === 'assistant') {
            const content = (message as unknown as { message?: { content?: Array<{ type: string; text?: string }> } })
              .message?.content
            if (Array.isArray(content))
              text += content
                .filter((c) => c?.type === 'text' && c.text)
                .map((c) => c.text)
                .join('\n')
          } else if (message.type === 'result') {
            const result = (message as unknown as { result?: string }).result
            if (result) text += result
          }
        }
        return text
      })(),
      timeoutPromise
    ])
  } finally {
    signal?.removeEventListener('abort', abortFromTask)
    if (timer) clearTimeout(timer)
    if (!abort.signal.aborted) abort.abort()
    try {
      await q.close()
    } catch {
      /* ignore */
    }
  }
}

function callQoderOrOpenAIReviewer(
  input: Parameters<OpenAICompatReviewer['call']>[0],
  taskId: string,
  model?: string,
  signal?: AbortSignal
): Promise<string> {
  // 取 CodeReview 角色 Agent 的 systemPrompt 替换固定角色段落
  const task = store.getTask(taskId)
  const repos = task ? store.listTaskRepositories(taskId) : []
  const { roleBody } = agentService.resolveOperationAgent('review', task ?? undefined, repos)
  const prompt = buildReviewPromptForQoder(input, roleBody)
  if (providerForTask(taskId) !== 'qoder') return openAIReviewer.call(input, taskId, model, signal, prompt)
  // Review 逐仓库执行：按 input.repo 匹配仓库，注入该仓库 Agent 的指引（领域约定）。
  let finalPrompt = prompt
  if (task) {
    const target = repos.find((repo) => repo.name === input.repo)
    const agent = target
      ? agentService.resolveAgentFor(target.repositoryId, task.agentProfileId, task.repoAgentIds?.[target.repositoryId])
      : undefined
    const body = [agent?.systemPrompt, agent?.engineeringGuidelines].filter(Boolean).join('\n\n')
    if (body) finalPrompt = `## Agent 指引 — 仓库 ${input.repo}\n${body}\n\n${prompt}`
  }
  return callQoderReviewer(finalPrompt, taskId, model, signal)
}

/**
 * 「AI 生成 Agent 模板」专用 Qoder 调用：与 `callQoderReviewer` 共享 token / abort 机制，
 * 但明显轻量化 —— 一次性返回 JSON，不需要 review 路径的 16 个工具栈 / 长超时。
 *
 * 工具策略（与 review 不同）：
 *  - 仅启用只读工具 `Read` / `Glob` / `Grep`：模型可自己读仓库的 `.qoder/repowiki/` /
 *    `agents.md` / `README.md` 补充 `repoContext` 注入之外的细节；
 *  - 显式禁用写工具（`Edit` / `Write` / `Bash` / `NotebookEdit`）：生成过程是只读语义，
 *    防止模型误改仓库或 Electron app 目录。
 *  - `additionalDirectories` 把选中的仓库路径加进 qodercli 沙箱白名单，让 Read 工具可达。
 *
 * 轮次与超时：
 *  - `maxTurns: 3`：允许模型先 Read 几次补充细节再输出 JSON（1 轮经常信息不足）；
 *  - 超时 120s：3 轮 Read + 1 轮 JSON 输出的预算；超出后给可读的中文错误。
 */
const AGENT_GENERATION_TIMEOUT_MS = 120_000
async function callQoderForAgentGeneration(
  prompt: string,
  model: string,
  options: { additionalDirectories?: string[]; signal?: AbortSignal } = {}
): Promise<string> {
  const { additionalDirectories = [], signal } = options
  const token = protectedValue('qoderToken')
  if (!token) throw new Error('请先配置 Qoder Token')
  const abort = new AbortController()
  const abortFromTask = () => abort.abort(signal?.reason)
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abortFromTask, { once: true })
  const q = query({
    prompt,
    options: {
      auth: accessToken(token),
      cwd: process.cwd(),
      abortController: abort,
      persistSession: false,
      permissionMode: 'default',
      controlRequestTimeoutMs: 15_000,
      // 只允许只读工具：模型可以用 Read / Glob / Grep 进一步探索仓库补充细节，
      // 但不能修改任何文件或执行 shell 指令。
      allowedTools: ['Read', 'Glob', 'Grep'],
      // maxTurns=3：先 Read 0~2 次补充细节，再输出 JSON；1 轮经常信息不足。
      maxTurns: 3,
      // 把选中的仓库路径加进沙箱白名单，让 Read 工具能读到这些目录。
      // 空数组不传，避免给 qodercli 一个空的可选项。
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
      ...(model ? { model } : {})
    }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort(new Error(`qoder agent-generation 在 ${AGENT_GENERATION_TIMEOUT_MS / 1000}s 内未返回,主动 abort`))
      reject(
        new Error(
          `Qoder 模型在 ${AGENT_GENERATION_TIMEOUT_MS / 1000}s 内未返回。可能原因：Qoder 后端拥塞 / 网络问题 / 当前模型不在线。建议：稍后重试，或在「模型」下拉中切到 OpenAI 兼容模型。`
        )
      )
    }, AGENT_GENERATION_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      (async () => {
        let text = ''
        for await (const message of q) {
          if (message.type === 'assistant') {
            const content = (message as unknown as { message?: { content?: Array<{ type: string; text?: string }> } })
              .message?.content
            if (Array.isArray(content))
              text += content
                .filter((c) => c?.type === 'text' && c.text)
                .map((c) => c.text)
                .join('\n')
          } else if (message.type === 'result') {
            const result = (message as unknown as { result?: string }).result
            if (result) text += result
          }
        }
        return text
      })(),
      timeoutPromise
    ])
  } finally {
    signal?.removeEventListener('abort', abortFromTask)
    if (timer) clearTimeout(timer)
    if (!abort.signal.aborted) abort.abort()
    try {
      await q.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 「AI 生成 Agent 模板」专用：把选中的仓库的本地背景（repowiki / agents.md / README.md）
 * 读出来并渲染为 prompt 片段。
 *
 * 设计动机：
 *  - 用户勾选仓库是希望模型能基于仓库真实约定生成 systemPrompt，而不是凭空写"使用 Spring Boot"；
 *  - 仓库背景注入 prompt 后，无论 Qoder（带只读工具）还是 OpenAI 兼容模型都能拿到一致上下文；
 *  - 注入与工具互补：Qoder 路径还会用 Read 工具按需补充细节；OpenAI 路径则完全靠注入。
 *
 * 错误处理：单条仓库读 IO 失败（不存在 / 权限拒绝）不抛错；只跳过该仓库。整体失败时
 * 返回空串，调用方会走「无仓库本地背景」占位 —— 不让局部 IO 错误打断整个生成流程。
 */
async function loadRepoContext(repositories: AgentGenerationRepository[]): Promise<string> {
  if (repositories.length === 0) return ''
  const entries = await Promise.all(
    repositories.map(async (repo): Promise<RepoContextEntry | null> => {
      try {
        // repowiki：主进程内已有索引，直接取（不需要重新读盘）。
        let wikiDocs: RepoContextEntry['wikiDocs'] = []
        try {
          wikiDocs = memoryService
            .listRepoWikiDocs(repo.id)
            .map((doc) => ({ path: doc.path, title: doc.title, content: doc.content }))
        } catch {
          wikiDocs = []
        }
        // agents.md / README.md：按 AGENTS.md → agents.md 顺序尝试；任一存在即用。
        const agentsMd = tryReadRootFile(repo.localPath, ['AGENTS.md', 'agents.md'])
        const readme = tryReadRootFile(repo.localPath, ['README.md', 'readme.md'])
        return { repositoryName: repo.name, localPath: repo.localPath, wikiDocs, agentsMd, readme }
      } catch {
        return null
      }
    })
  )
  return formatRepoContext(entries.filter((entry): entry is RepoContextEntry => entry !== null))
}

/** 读仓库根目录的文件（按候选名顺序），失败 / 全部不存在返回 undefined。 */
function tryReadRootFile(localPath: string, candidates: string[]): string | undefined {
  for (const name of candidates) {
    const full = join(localPath, name)
    if (existsSync(full)) {
      try {
        return readFileSync(full, 'utf8')
      } catch {
        // 继续尝试下一个候选名
      }
    }
  }
  return undefined
}

function buildReviewPromptForQoder(input: Parameters<OpenAICompatReviewer['call']>[0], roleBody?: string): string {
  return [
    roleBody || 'You are a code reviewer. Follow the rules below as a checklist.',
    'Review the diff carefully. Report only actionable findings.',
    'Severity: critical (data loss / security / crash) | high (bug) | medium (perf / missing error handling) | low (style).',
    'Drop low unless genuinely valuable.',
    '',
    `Repository: ${input.repo}`,
    `Task: ${input.task}`,
    `Changed files: ${input.files.join(', ')}`,
    '',
    '## Review rules (from ocr)',
    input.rules || '(no rule.json configured, apply general code review heuristics)',
    '',
    '## Diff',
    '```diff',
    input.diff,
    '```',
    '',
    'Respond with strict JSON only (no prose, no code fence). Write each `message` value in Chinese (zh-CN):',
    '{"status":"completed","comments":[{"path":"...","line":<number|null>,"severity":"critical|high|medium|low","message":"..."}],"summary":{"files":<number>,"comments":<number>}}'
  ].join('\n')
}

/**
 * OpenAI 兼容路径的纯 prompt 调用（无 DelegateReviewerInput 包装）。
 * 用于 runOperationAgent 等不需要 Review 输入结构的场景。
 *
 * 超时：默认 180s（其他场景通常需要多轮 / 长 prompt）；Agent 生成的轻量路径
 * 传 60s 以加快失败反馈——具体见 `agents:generate-content` handler。
 */
async function callOpenAIForPrompt(
  prompt: string,
  _taskId: string,
  model?: string,
  signal?: AbortSignal,
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const { timeoutMs = 180_000 } = options
  const raw = store.getSetting('modelProfile')
  if (!raw) throw new Error('未配置 modelProfile')
  const profile = JSON.parse(raw) as ModelProfile
  if (!profile.baseUrl || !profile.model) throw new Error('modelProfile 缺少 baseUrl 或 model')
  const apiKey =
    (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined) ?? desktopResolver.getSecret('modelApiKey')
  if (!apiKey) throw new Error('未配置 modelApiKey')
  const url = `${profile.baseUrl.replace(/\/$/, '')}/chat/completions`
  const abort = new AbortController()
  const timer = setTimeout(
    () =>
      abort.abort(
        new Error(
          `OpenAI 兼容请求在 ${timeoutMs / 1000}s 内未返回。可能原因：modelProfile 后端拥塞 / 网络问题 / 模型名不在线。建议：稍后重试，或在「设置 → 模型」中检查 baseUrl 与 model。`
        )
      ),
    timeoutMs
  )
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model ?? profile.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0
      })
    })
    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenAI 兼容请求失败 ${response.status}：${errText.slice(0, 300)}`)
    }
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return json.choices?.[0]?.message?.content ?? ''
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 统一操作子 agent 执行器。
 * 取角色 Agent 的 systemPrompt + 领域指引 + body，按 providerForTask 路由到 Qoder SDK 或 OpenAI 兼容路径。
 * 角色 Agent 禁用/不存在时返回空字符串。
 */
async function runOperationAgent(
  taskId: string,
  operation: OperationKind,
  body: string,
  signal?: AbortSignal
): Promise<string> {
  const task = store.getTask(taskId)
  if (!task) return ''
  const repos = store.listTaskRepositories(taskId)
  const { roleAgent, roleBody, contextBody } = agentService.resolveOperationAgent(operation, task, repos)
  if (!roleAgent || !roleBody) return ''
  const prompt = [roleBody, contextBody, body].filter(Boolean).join('\n\n')
  if (providerForTask(taskId) !== 'qoder') {
    return callOpenAIForPrompt(prompt, taskId, roleAgent.preferredModel, signal)
  }
  return callQoderReviewer(prompt, taskId, roleAgent.preferredModel, signal)
}

// === Qoder 集成(留在 desktop) ==================================================

async function savePlanDecision(taskId: string, texts: string[]): Promise<Task> {
  const decision = parsePlanDecision(texts)
  if (decision.outcome === 'changes_required') return taskWorkflow.setPlan(taskId, decision.content)

  let changedFiles: Awaited<ReturnType<typeof taskChangedFiles>>
  try {
    changedFiles = await taskChangedFiles(taskId, false)
  } catch (error) {
    const pending = taskWorkflow.setPlan(
      taskId,
      [
        '## 需要人工确认',
        '',
        'Agent 判断当前代码已满足任务要求，但系统无法确认工作区是否存在文件变化，因此任务未自动完成。',
        '',
        decision.content
      ].join('\n')
    )
    store.updateTask(taskId, { summary: '无法确认文件状态，等待计划确认' })
    addTaskEvent({
      taskId,
      kind: 'error',
      title: '无法确认计划阶段的文件改动',
      detail: error instanceof Error ? error.message : String(error)
    })
    return pending
  }

  if (nextStepForPlan(decision.outcome, changedFiles.length) === 'complete_without_changes') {
    return taskWorkflow.completeWithoutChanges(taskId, decision.content)
  }

  const changedList = changedFiles.map((file) => `- ${file.repositoryName}: ${file.path} (${file.status})`).join('\n')
  const pending = taskWorkflow.setPlan(
    taskId,
    [
      '## 需要人工确认',
      '',
      `Agent 判断当前代码已满足任务要求，但系统检测到 ${changedFiles.length} 个文件变化，因此任务未自动完成。`,
      '',
      decision.content,
      '',
      '## 检测到的文件变化',
      '',
      changedList
    ].join('\n')
  )
  store.updateTask(taskId, { summary: '计划结论与文件变化不一致，等待确认' })
  addTaskEvent({
    taskId,
    kind: 'status',
    title: '计划结论与文件变化不一致',
    detail: `Agent 返回无需修改，但系统检测到 ${changedFiles.length} 个文件变化，任务不会自动完成。`
  })
  return pending
}

async function runQoder(
  taskId: string,
  extraPrompt?: string,
  signal?: AbortSignal,
  resumeSessionId?: string
): Promise<void> {
  const task = await taskWorkflow.prepare(taskId, signal)
  const repos = store.listTaskRepositories(task.id)
  if (repos.length === 0) throw new Error('任务未关联代码仓库')
  activeTaskId = task.id
  activeQoderAbort?.abort()
  const qoderAbort = new AbortController()
  activeQoderAbort = qoderAbort
  const abortFromTask = () => qoderAbort.abort(signal?.reason)
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abortFromTask, { once: true })
  addTaskEvent({
    taskId,
    kind: 'status',
    title: '执行环境:Qoder Agent SDK',
    detail: '使用应用随附运行时,并在已配置仓库目录中执行'
  })
  const agent = createQoderTaskAgent()
  try {
    await agent.runImplementation({
      task,
      repos,
      signal,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(extraPrompt ? { extraPrompt } : {})
    })
    const { responseTexts } = agent.collectResult('implementation')
    await finishImplementation(task.id, responseTexts, signal)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const current = store.getTask(task.id)
    // 用户主动暂停（pauseTask）导致的中断不算执行失败：只保留 paused 状态，不写 error 事件。
    if (current?.state === 'paused') return
    addTaskEvent({ taskId, kind: 'error', title: 'Qoder 执行失败', detail })
    if (['implementing', 'validating'].includes(current?.state ?? '')) updateState(current!, 'failed')
    emitPi({ type: 'agent_error', taskId, message: detail })
  } finally {
    signal?.removeEventListener('abort', abortFromTask)
    activeQoderAbort = undefined
    activeQoderQuery = undefined
  }
}

type TestCaseGenerationResult = { files: string[]; commitSha?: string; summary: string }

async function runQoderTestCases(taskId: string, signal?: AbortSignal): Promise<TestCaseGenerationResult> {
  const task = store.getTask(taskId)
  if (!task || task.state !== 'generating_tests') throw new Error('当前任务不能生成测试用例')
  const repos = store.listTaskRepositories(task.id)
  if (repos.length === 0) throw new Error('任务未关联代码仓库')
  activeTaskId = task.id
  addTaskEvent({ taskId, kind: 'status', title: '正在生成测试用例' })
  activeQoderAbort?.abort()
  const qoderAbort = new AbortController()
  activeQoderAbort = qoderAbort
  const abortFromTask = () => qoderAbort.abort(signal?.reason)
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abortFromTask, { once: true })
  const agent = createQoderTaskAgent()
  try {
    await agent.runTestGeneration({ task, repos, signal })
    const { responseTexts } = agent.collectResult('test')
    return parseTestCaseGeneration(responseTexts)
  } finally {
    signal?.removeEventListener('abort', abortFromTask)
    activeQoderAbort = undefined
    activeQoderQuery = undefined
  }
}

async function runQoderPlan(taskId: string, feedback?: string, signal?: AbortSignal): Promise<void> {
  const task = store.getTask(taskId)
  if (!task || task.state !== 'planning') throw new Error('当前任务不能生成计划')
  const repos = store.listTaskRepositories(task.id)
  if (repos.length === 0) throw new Error('任务未关联代码仓库')

  // === 二次执行计划卡死的关键修复 ============================
  // 1) 把上一个 activeQoderQuery 立即释放(最多等 5s),避免 SDK 内部残留会话;
  // 2) 上一轮的 AbortController 先 abort,保证旧 for-await 能退出;
  // 3) 新 AbortController 在旧资源完全释放后再替换 activeQoderAbort。
  const previousQuery = activeQoderQuery
  const previousAbort = activeQoderAbort
  activeQoderQuery = undefined
  activeQoderAbort = undefined
  previousAbort?.abort()
  if (previousQuery) {
    try {
      await previousQuery.interrupt()
    } catch {
      /* may already be closed */
    }
    await closeQoderQuerySafely(previousQuery, 5_000)
  }
  // ============================================================

  activeTaskId = task.id
  activePlanningTaskId = task.id
  activePlanText = ''
  const abort = new AbortController()
  const abortFromTask = () => abort.abort(signal?.reason)
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abortFromTask, { once: true })
  activeQoderAbort = abort
  const agent = createQoderTaskAgent()
  try {
    await agent.runPlan({ task, repos, signal, ...(feedback ? { feedback } : {}) })
    const { responseTexts } = agent.collectResult('plan')
    await savePlanDecision(taskId, responseTexts)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    addTaskEvent({ taskId, kind: 'error', title: '计划生成失败', detail })
    abort.abort()
    const current = store.getTask(taskId)
    if (current?.state === 'planning') {
      store.updateTask(taskId, { failureStage: 'planning' })
      updateState(current, 'failed')
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', abortFromTask)
    if (activeQoderAbort === abort) activeQoderAbort = undefined
    activeQoderQuery = undefined
    activePlanningTaskId = undefined
  }
}

async function advanceAfterValidation(taskId: string, state: TaskState, signal?: AbortSignal): Promise<void> {
  if (state !== 'awaiting_review') return
  signal?.throwIfAborted()
  const task = store.getTask(taskId)
  // 任务级覆盖优先于系统级设置。
  if (taskWorkflow.isReviewEnabledFor(task)) {
    await runReviewWithAutoFix(taskId, signal)
  } else {
    store.updateTask(taskId, { reviewStatus: 'waived' })
    updateState(store.getTask(taskId)!, 'awaiting_commit')
    addTaskEvent({ taskId, kind: 'status', title: '已跳过 Review,等待提交 MR' })
  }
  const updated = store.getTask(taskId)
  if (updated?.state === 'awaiting_commit' && taskWorkflow.shouldAutoCreateMergeRequestsFor(updated)) {
    await deliveryService.submitMergeRequests(taskId, signal)
  }
}

// === Phase 4: Review 自动修订闭环 =============================================

/** 系统设置：Review 阻断后是否自动按意见修订（默认关闭，由用户在设置里开启）。 */
function reviewAutoFixEnabled(): boolean {
  return store.getSetting('reviewAutoFix') === 'true'
}
/** 系统设置：自动修订最大轮数（默认 2）。 */
function reviewAutoFixMaxRounds(): number {
  const raw = Number(store.getSetting('reviewAutoFixMaxRounds'))
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 10) : 2
}

/** 从最近的 review 事件里收集意见（含阻断级别），用于自动修订 prompt。 */
function collectReviewComments(
  taskId: string,
  blockingOnly: boolean
): Array<{ severity?: string; path?: string; line?: number; message?: string }> {
  const events = store.listEvents(taskId)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.kind !== 'review') continue
    const payload = event.payload as
      | { comments?: Array<{ severity?: string; path?: string; line?: number; message?: string }> }
      | undefined
    const comments = payload?.comments ?? []
    if (!blockingOnly) return comments
    const blocking = comments.filter((comment) =>
      ['critical', 'high', 'error'].includes(String(comment.severity ?? '').toLowerCase())
    )
    if (blocking.length) return blocking
  }
  return []
}

/** 把 review 意见渲染成修订 prompt（追加给实现阶段的指令）。 */
function buildReviewFixPrompt(
  task: Task,
  comments: Array<{ severity?: string; path?: string; line?: number; message?: string }>
): string {
  const lines = comments.map((comment, index) => {
    const loc = comment.path
      ? `${comment.path}${typeof comment.line === 'number' ? `:${comment.line}` : ''}`
      : '（全局）'
    return `${index + 1}. [${comment.severity ?? 'high'}] ${loc} — ${comment.message ?? '(无描述)'}`
  })
  return [
    'Code review 未通过，以下是需要修复的问题。请逐一修复，不要遗漏；不要引入与这些问题无关的改动。',
    '',
    ...lines,
    '',
    implementationOutcomeInstruction
  ].join('\n')
}

/**
 * Review + 自动修订闭环：
 * 1. 跑 review；2. 阻断且开启自动修订且未达上限 → 把意见拼进 prompt 重跑实现；
 * 3. 实现完成后经 finishImplementation → advanceAfterValidation 再次进入本函数，形成循环，
 *    直到 Review 通过、达到轮数上限或用户手动介入。
 */
async function runReviewWithAutoFix(taskId: string, signal?: AbortSignal): Promise<void> {
  await taskWorkflow.runReview(taskId, buildReviewOrchestrator(), signal)
  const task = store.getTask(taskId)
  if (!task || task.state !== 'review_blocked') return
  if (!reviewAutoFixEnabled()) return
  const used = task.reviewFixCount ?? 0
  const maxRounds = reviewAutoFixMaxRounds()
  const comments = collectReviewComments(taskId, true)
  if (comments.length === 0) return
  if (used >= maxRounds) {
    addTaskEvent({
      taskId,
      kind: 'status',
      title: '已到达 Review 自动修订上限',
      detail: `已自动修订 ${used} 轮，剩余 ${comments.length} 条阻断意见需人工处理`
    })
    return
  }
  const fixPrompt = buildReviewFixPrompt(task, comments)
  store.updateTask(taskId, { reviewFixCount: used + 1 })
  updateState(store.getTask(taskId)!, 'implementing')
  addTaskEvent({
    taskId,
    kind: 'status',
    title: `按 Review 意见自动修订(第 ${used + 1}/${maxRounds} 轮)`,
    detail: comments
      .map(
        (comment) =>
          `[${comment.severity ?? 'high'}] ${comment.path ?? ''}${typeof comment.line === 'number' ? `:${comment.line}` : ''} ${comment.message ?? ''}`
      )
      .join('\n')
  })
  // 注意：修订分支直接用传入 signal 跑 runQoder，不能再嵌套 runTaskOperation——
  // 嵌套会 abort 当前 operation 的 signal，导致修订后 review 通过时旧 advanceAfterValidation
  // 用已 abort 的 signal 调 submitMergeRequests，git 操作被立即取消、自动提交失败一次。
  if (runtimeProvider(task) === 'qoder') {
    await runQoder(taskId, fixPrompt, signal).catch((error) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  signal?.throwIfAborted()
  await startPi(taskId)
  if (!piSession) throw new Error('OpenAI agent session is unavailable')
  await piSession!.prompt(
    await buildAgentPrompt(
      task,
      `${fixPrompt}\n\n${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ''}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`
    ),
    { source: 'rpc' }
  )
}

/**
 * LLM 驱动的测试覆盖检测：在生成测试用例之前，先让 Test Writer Agent 判断当前改动是否已有测试覆盖。
 * 检测调用失败或返回 false 时不跳过（保守：照常生成测试）。
 */
async function runTestCoverageCheck(taskId: string, signal?: AbortSignal): Promise<boolean> {
  const task = store.getTask(taskId)
  if (!task) return false
  let changedFiles: Awaited<ReturnType<typeof taskChangedFiles>>
  try {
    changedFiles = await taskChangedFiles(taskId, true)
  } catch {
    return false
  }
  if (changedFiles.length === 0) return false
  const fileList = changedFiles.map((f) => `${f.path} (${f.status})`).join('\n')
  const body = [
    `## 任务信息\n${task.title}\n${task.description}`,
    `## 改动文件\n${fileList}`,
    '请判断当前改动是否已有充分的测试覆盖。',
    '输出严格 JSON（不要额外说明）：',
    '{"covered": true|false, "reason": "..."}',
    'covered=true 表示已有测试覆盖，无需生成新测试；covered=false 表示需要生成测试。'
  ].join('\n\n')
  try {
    const text = await runOperationAgent(taskId, 'test', body, signal)
    if (!text) return false
    const json = JSON.parse(text.trim())
    if (json.covered === true) {
      addTaskEvent({ taskId, kind: 'status', title: '检测到已有测试覆盖，跳过生成', detail: json.reason || '' })
      return true
    }
    return false
  } catch (error) {
    addTaskEvent({
      taskId,
      kind: 'error',
      title: '测试覆盖检测失败，将继续生成测试用例',
      detail: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

async function finishImplementation(taskId: string, responseTexts: string[], signal?: AbortSignal): Promise<void> {
  const task = store.getTask(taskId)
  if (!task || task.state !== 'implementing') return
  const decision = parseImplementationDecision(responseTexts)
  if (decision.outcome === 'needs_input') {
    taskWorkflow.awaitInput(taskId, decision.content || 'Agent 表示当前信息不足或实现尚未完成，请补充后继续。')
    return
  }
  // 实现已结束（成功 / 结论待确认等），异步整理任务执行记录为记忆，不阻塞后续校验流程。
  void consolidateTaskMemory(taskId, responseTexts)
  let changedFiles: Awaited<ReturnType<typeof taskChangedFiles>>
  try {
    changedFiles = await taskChangedFiles(taskId, false)
  } catch (error) {
    addTaskEvent({
      taskId,
      kind: 'error',
      title: '无法确认文件改动',
      detail: `${error instanceof Error ? error.message : String(error)}\n任务不会自动进入校验、Review 或完成状态。`
    })
    return
  }
  const nextStep = nextStepForImplementation(decision.outcome, changedFiles.length)
  if (nextStep === 'complete_without_changes') {
    taskWorkflow.completeImplementationWithoutChanges(
      taskId,
      decision.content || 'Agent 已确认当前仓库满足任务要求。无需修改代码。'
    )
    return
  }
  if (nextStep === 'await_confirmation') {
    addTaskEvent({
      taskId,
      kind: 'status',
      title: '等待确认执行结果',
      detail:
        decision.outcome === 'unknown'
          ? 'Agent 未明确说明实现是否完成，任务不会自动进入校验或 Review。'
          : 'Agent 结论与文件改动状态不一致，任务不会自动推进。'
    })
    return
  }
  // 若任务级/系统级开关打开，则在实现完成后、runValidation 之前先检测测试覆盖。
  if (taskWorkflow.shouldGenerateTestCases(task)) {
    const covered = await runTestCoverageCheck(taskId, signal)
    if (covered) {
      // 已有测试覆盖，跳过生成，直接进入校验
      const validated = await taskWorkflow.runValidation(taskId, signal)
      await advanceAfterValidation(taskId, validated.state, signal)
    } else {
      await runTestCaseGenerationThenValidate(taskId, signal)
    }
    return
  }
  const validated = await taskWorkflow.runValidation(taskId, signal)
  await advanceAfterValidation(taskId, validated.state, signal)
}

async function runTestCaseGenerationThenValidate(taskId: string, signal?: AbortSignal): Promise<void> {
  try {
    taskWorkflow.beginTestCaseGeneration(taskId)
    const result = await runQoderTestCases(taskId, signal)
    taskWorkflow.finishTestCaseGeneration(taskId, result)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    addTaskEvent({ taskId, kind: 'error', title: '测试用例生成失败', detail })
    // 回退到 implementing 让用户可以重试，而不是直接失败整个任务。
    const current = store.getTask(taskId)
    if (current?.state === 'generating_tests') updateState(current, 'implementing')
    return
  }
  const validated = await taskWorkflow.runValidation(taskId, signal)
  await advanceAfterValidation(taskId, validated.state, signal)
}

// === Pi Session 集成(留在 desktop) ============================================

function syncPiModelConfig(raw: string): void {
  const profile = JSON.parse(raw) as ModelProfile
  if (!profile.baseUrl || !profile.model) return
  const agentDir = store.getSetting('piAgentDir') ?? getAgentDir()
  mkdirSync(agentDir, { recursive: true })
  const modelsPath = join(agentDir, 'models.json')
  const current = existsSync(modelsPath)
    ? (JSON.parse(readFileSync(modelsPath, 'utf8')) as Record<string, unknown>)
    : {}
  const providers =
    current.providers && typeof current.providers === 'object' && !Array.isArray(current.providers)
      ? (current.providers as Record<string, unknown>)
      : {}
  const provider = profile.provider ?? 'company-openai'
  const next = {
    ...current,
    providers: {
      ...providers,
      [provider]: {
        baseUrl: profile.baseUrl,
        api: 'openai-completions',
        apiKey: `$${profile.apiKeyEnv ?? 'OPENAI_API_KEY'}`,
        models: [
          {
            id: profile.model,
            name: profile.model,
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 128000,
            maxTokens: 32768
          }
        ]
      }
    }
  }
  const temporaryPath = `${modelsPath}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporaryPath, modelsPath)
}

function emitPi(event: unknown): void {
  const json = JSON.stringify(event, (_key, value) => (typeof value === 'string' ? redactSecrets(value) : value))
  const record = JSON.parse(json) as Record<string, unknown>
  if (activePlanningTaskId && record.type === 'message_update') {
    const update = record.assistantMessageEvent as { type?: string; delta?: string } | undefined
    if (update?.type === 'text_delta' && update.delta) activePlanText += update.delta
  }
  if (activePlanningTaskId) record.phase = 'planning'
  if (
    activeTaskId &&
    providerForTask(activeTaskId) === 'openai' &&
    ['message_end', 'agent_end'].includes(String(record.type))
  )
    updatePiUsage(activeTaskId)
  if (activeTaskId && record.type === 'tool_execution_end') emitTaskChanged(activeTaskId)
  // Qoder 任务消息流 → 本地 trace 文件（thinking / 工具 / 文本 / result 汇总）。
  if (record.type === 'qoder_event' && typeof record.taskId === 'string')
    qoderTraceSink.append(record.taskId, record.message)
  sendTaskEvent(typeof record.taskId === 'string' || !activeTaskId ? record : { ...record, taskId: activeTaskId })
  if (
    record.type === 'agent_end' &&
    activeTaskId &&
    !activePlanningTaskId &&
    providerForTask(activeTaskId) === 'openai'
  ) {
    const taskId = activeTaskId
    const responseTexts = Array.isArray(record.messages)
      ? record.messages.flatMap((message: any) =>
          message?.role === 'assistant' && Array.isArray(message.content)
            ? message.content
                .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
                .map((block: any) => block.text)
            : []
        )
      : []
    void runTaskOperation(taskId, (signal) => finishImplementation(taskId, responseTexts, signal)).catch((error) =>
      emitPi({ type: 'agent_error', message: error instanceof Error ? error.message : String(error) })
    )
  }
}

function requestUi<T>(
  method: string,
  payload: Record<string, unknown>,
  options?: ExtensionUIDialogOptions
): Promise<T | undefined> {
  const id = randomUUID()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: () => void = () => undefined
    const finish = (response: Record<string, unknown>) => {
      if (timer) clearTimeout(timer)
      if (options?.signal) options.signal.removeEventListener('abort', abortListener)
      pendingUi.delete(id)
      if (response.cancelled) resolve(undefined)
      else if (method === 'confirm') resolve(Boolean(response.confirmed) as T)
      else resolve(response.value as T | undefined)
    }
    pendingUi.set(id, finish)
    emitPi({ type: 'extension_ui_request', id, method, ...payload, timeout: options?.timeout })
    if (options?.timeout) timer = setTimeout(() => finish({ cancelled: true }), options.timeout)
    abortListener = () => finish({ cancelled: true })
    options?.signal?.addEventListener('abort', abortListener, { once: true })
  })
}

function createGuiUI(): ExtensionUIContext {
  const ui = {
    select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
      requestUi<string>('select', { title, options }, opts),
    confirm: async (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
      (await requestUi<boolean>('confirm', { title, message }, opts)) ?? false,
    input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
      requestUi<string>('input', { title, placeholder }, opts),
    editor: (title: string, prefill?: string) => requestUi<string>('editor', { title, prefill }),
    notify: (message: string, type = 'info') =>
      emitPi({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', message, notificationType: type }),
    setStatus: (key: string, text?: string) =>
      emitPi({ type: 'extension_ui_request', id: randomUUID(), method: 'setStatus', statusKey: key, statusText: text }),
    setTitle: (title: string) => emitPi({ type: 'extension_ui_request', id: randomUUID(), method: 'setTitle', title }),
    setEditorText: (text: string) =>
      emitPi({ type: 'extension_ui_request', id: randomUUID(), method: 'set_editor_text', text }),
    pasteToEditor: (text: string) =>
      emitPi({ type: 'extension_ui_request', id: randomUUID(), method: 'set_editor_text', text }),
    getEditorText: () => '',
    onTerminalInput: () => () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    custom: async () => undefined,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Theme switching is managed by the desktop application' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined
  }
  return ui as unknown as ExtensionUIContext
}

async function stopPi(): Promise<void> {
  unsubscribePi?.()
  unsubscribePi = undefined
  if (piSession) {
    if (!piSession.isIdle) await piSession.abort()
    piSession.dispose()
    piSession = undefined
  }
  for (const resolve of pendingUi.values()) resolve({ cancelled: true })
  pendingUi.clear()
}

async function startPi(taskId: string): Promise<void> {
  await stopPi()
  const task = store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  activeTaskId = taskId
  store.setSetting('activeTaskId', taskId)
  const repo = store.listTaskRepositories(taskId)[0]
  const cwd = repo?.worktreePath ?? repo?.localPath ?? process.cwd()
  const agentDir = store.getSetting('piAgentDir') ?? getAgentDir()
  const sessionDir = join(dataDir, 'pi-sessions')
  const sessionManager = task.piSessionPath
    ? SessionManager.open(task.piSessionPath, sessionDir, cwd)
    : SessionManager.create(cwd, sessionDir)
  const settingsManager = SettingsManager.create(cwd, agentDir)
  const extension = join(__dirname, '../../../packages/pi-package/dist/index.js')
  const additionalExtensionPaths = [extension]
  // 若用户已通过 `pi install npm:pi-trace-extension` 安装，追加加载（提供执行视角 trace 数据源）。
  // 缺失时静默降级：仅数据源④不可用，任务 / 对话 / 官方 session 三路 trace 不受影响。
  // `pi install` 的实际落盘是 `<agentDir>/npm/node_modules/pi-trace-extension`（npm 标准布局），
  // 兼容旧式 `<agentDir>/npm/pi-trace-extension` 两种路径。
  const traceExtensionCandidates = [
    join(agentDir, 'npm', 'node_modules', 'pi-trace-extension', 'extensions', 'trace', 'index.ts'),
    join(agentDir, 'npm', 'pi-trace-extension', 'extensions', 'trace', 'index.ts')
  ]
  const traceExtension = traceExtensionCandidates.find((candidate) => existsSync(candidate))
  if (traceExtension) additionalExtensionPaths.push(traceExtension)
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths })
  await resourceLoader.reload({
    resolveProjectTrust: async () => {
      if (!hasTrustRequiringProjectResources(cwd)) return true
      const trustStore = new ProjectTrustStore(agentDir)
      const saved = trustStore.get(cwd)
      if (saved !== null) return saved
      const choice = await requestUi<string>('select', {
        title: '信任项目配置',
        options: ['信任并记住', '仅本次信任', '不信任'],
        message: `仓库 ${cwd} 包含项目级 Pi Extension、Skill 或配置。仅信任你确认过的代码仓库。`
      })
      if (choice === '信任并记住') {
        trustStore.set(cwd, true)
        return true
      }
      return choice === '仅本次信任'
    }
  })
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json')
  })
  const modelRaw = store.getSetting('modelProfile')
  if (modelRaw) {
    const profile = JSON.parse(modelRaw) as ModelProfile
    const localKey = keyStore.resolve(store.getSetting('modelApiKey'), 'modelApiKey')
    const apiKey = (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined) ?? localKey
    if (apiKey) await modelRuntime.setRuntimeApiKey(profile.provider ?? 'company-openai', apiKey)
  }
  const created = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    sessionManager,
    settingsManager,
    modelRuntime
  })
  piSession = created.session
  const session = piSession
  await session.bindExtensions({
    uiContext: createGuiUI(),
    mode: 'rpc',
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: (targetId, options) => session.navigateTree(targetId, options),
      switchSession: async () => ({ cancelled: true }),
      reload: () => session.reload()
    },
    abortHandler: () => {
      void session.abort()
    },
    shutdownHandler: () => {
      void stopPi()
    },
    onError: (error) => emitPi({ type: 'extension_error', ...error })
  })
  unsubscribePi = session.subscribe(emitPi)
  store.updateTask(task.id, { piSessionPath: session.sessionFile })
  emitPi({
    type: 'session_ready',
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    diagnostics: created.extensionsResult.errors
  })
}

async function startTask(
  taskId: string,
  options: {
    mode?: TaskStartMode
    repositoryCommands?: RepositoryCommandMap
    useAllRepositories?: boolean
    repoAgentIds?: Record<string, string>
  } = {}
): Promise<void> {
  const current = store.getTask(taskId)
  if (current) qoderTokenGuard(current)
  // 任务启动时可空选仓库：若 `useAllRepositories=true` 且任务当前没有 attach 任何仓库，
  // 先把 system 配的全部仓库 attach 上去，再走原来的 begin 路径。
  if (options.useAllRepositories && current) {
    const existing = store.listTaskRepositories(taskId)
    if (existing.length === 0) {
      const all = store.listRepositoryProfiles()
      for (const profile of all) {
        const exists = existing.find((repo) => repo.repositoryId === profile.id)
        if (!exists) store.attachRepository(taskId, profile.id)
      }
    }
  }
  if (options.repoAgentIds && Object.keys(options.repoAgentIds).length > 0) {
    store.updateTask(taskId, { repoAgentIds: options.repoAgentIds })
  }
  if (current && ['draft', 'failed'].includes(current.state) && runtimeProvider(current) === 'qoder')
    store.updateTask(taskId, { sessionUsage: undefined })
  const mode = options.mode ?? 'direct'
  // 新的实现流程开始：清零 Review 自动修订计数。
  store.updateTask(taskId, { reviewFixCount: 0 })
  const task = await runTaskOperation(taskId, (signal) =>
    taskWorkflow.begin(taskId, mode, options.repositoryCommands, signal)
  )
  if (mode === 'plan') {
    if (runtimeProvider(task) === 'qoder')
      void runTaskOperation(taskId, (signal) => runQoderPlan(taskId, undefined, signal)).catch((error) =>
        emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
      )
    else {
      await runTaskOperation(taskId, async (signal) => {
        signal.throwIfAborted()
        activePlanningTaskId = taskId
        activePlanText = ''
        await startPi(taskId)
        await piSession!.prompt(
          await buildAgentPrompt(
            task,
            `你处于只读计划模式。禁止修改文件、安装依赖或运行会改变工作区的命令。最终只输出 JSON：代码已满足要求时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n${task.title}\n${task.description}`
          ),
          { source: 'rpc' }
        )
        signal.throwIfAborted()
        const plan = activePlanText.trim()
        activePlanningTaskId = undefined
        if (plan) await savePlanDecision(taskId, [plan])
      })
    }
    return
  }
  if (runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) => runQoder(taskId, undefined, signal)).catch((error) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    await startPi(taskId)
    if (!piSession) throw new Error('OpenAI agent session is unavailable')
    await piSession!.prompt(
      await buildAgentPrompt(
        task,
        `${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ''}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\n${implementationOutcomeInstruction}`
      ),
      { source: 'rpc' }
    )
  })
}

/** 任务失败/中断后续接继续执行时,追加给 Agent 的指令:保留已完成改动,定位失败原因后继续。 */
const resumeImplementationInstruction =
  '任务此前执行失败/中断。请先检查当前工作区与代码状态（已完成的改动应保留），定位失败原因后继续完成剩余工作；不要重新执行已完成的部分，也不要重复安装依赖或重建环境。'

async function resumeTask(taskId: string): Promise<void> {
  const current = store.getTask(taskId)
  if (!current || current.state !== 'failed') throw new Error('只有失败的任务可以继续执行')
  qoderTokenGuard(current)
  store.updateTask(taskId, { sessionUsage: undefined })
  // 计划阶段失败(计划尚未生成成功)时继续生成计划;其它失败继续实现流程。
  // `failureStage === "planning"` 由 runQoderPlan 失败路径标记;`startMode === "plan" && !planContent` 兼容历史存量数据。
  const failedDuringPlanning =
    current.failureStage === 'planning' || (current.startMode === 'plan' && !current.planContent)
  store.updateTask(taskId, { failureStage: undefined })
  if (failedDuringPlanning) {
    const task = await runTaskOperation(taskId, (signal) => taskWorkflow.begin(taskId, 'plan', undefined, signal))
    if (runtimeProvider(task) === 'qoder') {
      void runTaskOperation(taskId, (signal) => runQoderPlan(taskId, undefined, signal)).catch((error) =>
        emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
      )
      return
    }
    await runTaskOperation(taskId, async (signal) => {
      signal.throwIfAborted()
      activePlanningTaskId = taskId
      activePlanText = ''
      await startPi(taskId)
      if (!piSession) throw new Error('OpenAI agent session is unavailable')
      await piSession!.prompt(
        await buildAgentPrompt(
          task,
          `你处于只读计划模式。禁止修改文件、安装依赖或运行会改变工作区的命令。最终只输出 JSON：代码已满足要求时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n${task.title}\n${task.description}`
        ),
        { source: 'rpc' }
      )
      signal.throwIfAborted()
      const plan = activePlanText.trim()
      activePlanningTaskId = undefined
      if (plan) await savePlanDecision(taskId, [plan])
    })
    return
  }
  // 实现阶段失败:复用 prepare 的失败恢复路径(worktree 缺失时补建,已完整时直接回到 implementing,不重跑 setup 命令)。
  const task = await runTaskOperation(taskId, (signal) => taskWorkflow.prepare(taskId, signal))
  if (runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) =>
      runQoder(taskId, resumeImplementationInstruction, signal, task.qoderSessionId)
    ).catch((error) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    await startPi(taskId)
    if (!piSession) throw new Error('OpenAI agent session is unavailable')
    await piSession!.prompt(
      await buildAgentPrompt(
        task,
        `${resumeImplementationInstruction}\n\n${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ''}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\n${implementationOutcomeInstruction}`
      ),
      { source: 'rpc' }
    )
  })
}

/**
 * Phase 3 HITL：暂停正在运行的任务。
 * 先切到 paused 再中断 in-flight 操作——runQoder 的失败处理看到 paused 不会标 failed；
 * Qoder 会话保留（qoderSessionId），恢复时按会话续接。
 */
async function pauseTask(taskId: string): Promise<void> {
  const task = store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  if (!['implementing', 'awaiting_input'].includes(task.state)) throw new Error('当前状态不能暂停')
  updateState(task, 'paused')
  const operation = activeTaskOperations.get(taskId)
  operation?.controller.abort(new Error('任务已暂停'))
  if (activeTaskId === taskId) {
    activeQoderAbort?.abort(new Error('任务已暂停'))
    const qoderQuery = activeQoderQuery
    activeQoderQuery = undefined
    if (qoderQuery) {
      try {
        await qoderQuery.interrupt()
      } catch {
        /* may already be closed */
      }
      await closeQoderQuerySafely(qoderQuery, 5_000)
    }
    await stopPi()
    activeTaskId = undefined
    store.setSetting('activeTaskId', '')
  }
  addTaskEvent({ taskId, kind: 'status', title: '任务已暂停', detail: '可通过「继续执行」从当前进度续跑' })
}

/** Phase 3 HITL：恢复已暂停的任务（paused -> implementing，Qoder 按会话续接）。 */
async function resumePausedTask(taskId: string): Promise<void> {
  const current = store.getTask(taskId)
  if (!current || current.state !== 'paused') throw new Error('只有暂停的任务可以继续执行')
  qoderTokenGuard(current)
  const task = updateState(current, 'implementing')
  addTaskEvent({ taskId, kind: 'status', title: '任务已恢复执行' })
  if (runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) =>
      runQoder(taskId, resumeImplementationInstruction, signal, task.qoderSessionId)
    ).catch((error) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    await startPi(taskId)
    if (!piSession) throw new Error('OpenAI agent session is unavailable')
    await piSession!.prompt(
      await buildAgentPrompt(
        task,
        `${resumeImplementationInstruction}\n\n${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ''}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\n${implementationOutcomeInstruction}`
      ),
      { source: 'rpc' }
    )
  })
}

/** Phase 3 HITL：手动编辑计划内容（计划确认阶段直接改 planContent，不走重新生成）。 */
async function updateTaskPlan(taskId: string, planContent: string): Promise<void> {
  const task = store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  if (!['awaiting_plan_approval', 'planning'].includes(task.state)) throw new Error('当前状态不能编辑计划')
  const content = planContent.trim()
  if (!content) throw new Error('计划内容不能为空')
  const revision = (task.planRevision ?? 0) + 1
  store.updateTask(taskId, { planContent: content, planRevision: revision })
  addTaskEvent({ taskId, kind: 'status', title: '计划已手动编辑', detail: `第 ${revision} 版` })
}

async function approveTaskPlan(taskId: string): Promise<void> {
  const before = store.getTask(taskId)
  if (!before?.planContent) throw new Error('当前任务没有可批准的计划')
  store.updateTask(taskId, { reviewFixCount: 0 })
  const approval = store.addApproval({ taskId, kind: 'plan', context: before.planContent })
  store.resolveApproval(approval.id, 'approved')
  const task = await runTaskOperation(taskId, (signal) => taskWorkflow.approvePlan(taskId, signal))
  if (runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) => runQoder(taskId, undefined, signal)).catch((error) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    await startPi(taskId)
    await piSession!.prompt(
      await buildAgentPrompt(
        task,
        `${task.title}\n\n${task.description}\n\nApproved implementation plan:\n${task.planContent}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\n${implementationOutcomeInstruction}`
      ),
      { source: 'rpc' }
    )
  })
}

async function reviseTaskPlan(taskId: string, feedback: string): Promise<void> {
  const task = taskWorkflow.revisePlan(taskId)
  addTaskEvent({ taskId, kind: 'message', title: '计划调整意见', detail: feedback })
  if (runtimeProvider(task) === 'qoder') {
    try {
      await runTaskOperation(taskId, (signal) => runQoderPlan(taskId, feedback, signal))
    } catch (error) {
      // 错误已在 runQoderPlan 内部写 event + 推 failed，这里只把消息转发给 UI 通道。
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    activePlanningTaskId = taskId
    activePlanText = ''
    await startPi(taskId)
    await piSession!.prompt(
      await buildAgentPrompt(
        task,
        `你处于只读计划模式。根据调整意见重新判断，禁止修改文件。最终只输出 JSON：无需修改时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n任务：${task.title}\n${task.description}\n\n上一版计划：\n${task.planContent ?? ''}\n\n调整意见：\n${feedback}`
      ),
      { source: 'rpc' }
    )
    signal.throwIfAborted()
    const plan = activePlanText.trim()
    activePlanningTaskId = undefined
    if (!plan) throw new Error('Agent 未返回有效计划')
    await savePlanDecision(taskId, [plan])
  })
}

async function retryTaskValidation(taskId: string): Promise<void> {
  await runTaskOperation(taskId, async (signal) => {
    const validated = await taskWorkflow.runValidation(taskId, signal)
    await advanceAfterValidation(taskId, validated.state, signal)
  })
}

async function sendTaskMessage(taskId: string, message: string): Promise<void> {
  let task = store.getTask(taskId)
  if (
    !task ||
    ![
      'implementing',
      'awaiting_input',
      'awaiting_review',
      'reviewing',
      'review_blocked',
      'awaiting_commit',
      'await_merge',
      'validation_failed'
    ].includes(task.state)
  )
    throw new Error('当前任务不能继续 AI 对话')
  addTaskEvent({ taskId, kind: 'message', title: '你', detail: message })
  if (task.state === 'awaiting_input' && isExplicitNoChangeCompletionRequest(message)) {
    taskWorkflow.completeAtUserRequest(taskId)
    return
  }
  if (task.state === 'awaiting_input') task = taskWorkflow.resumeImplementation(taskId)
  else if (task.state !== 'implementing') task = updateState(task, 'implementing')
  store.updateTask(task.id, { reviewStatus: 'pending' })
  if (runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) => runQoder(taskId, message, signal)).catch((error) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    if (!piSession || activeTaskId !== taskId) await startPi(taskId)
    await piSession!.prompt(`${message}\n\n${implementationOutcomeInstruction}`, {
      source: 'rpc',
      ...(piSession!.isStreaming ? { streamingBehavior: 'followUp' as const } : {})
    })
  })
}

async function stopTaskOperations(taskId: string, markFailed: boolean): Promise<void> {
  const operation = activeTaskOperations.get(taskId)
  operation?.controller.abort(new Error(markFailed ? '任务已停止' : '任务已删除'))
  const task = store.getTask(taskId)
  if (markFailed && task && ['planning', 'implementing', 'validating', 'generating_tests'].includes(task.state))
    updateState(task, 'failed')

  if (activeTaskId === taskId) {
    const qoderAbort = activeQoderAbort
    const qoderQuery = activeQoderQuery
    activeTaskId = undefined
    activePlanningTaskId = undefined
    activePlanText = ''
    activeQoderAbort = undefined
    activeQoderQuery = undefined
    store.setSetting('activeTaskId', '')

    qoderAbort?.abort(new Error(markFailed ? '任务已停止' : '任务已删除'))
    try {
      await qoderQuery?.interrupt()
    } catch {
      /* The query may already be closed. */
    }
    // close 自身在 Qoder SDK 内部可能因为子进程/会话未释放而卡死，加 5s 超时。
    if (qoderQuery) await closeQoderQuerySafely(qoderQuery, 5_000)
    await stopPi()
  }
  try {
    await operation?.promise
  } catch {
    /* Cancellation is expected while removing a task. */
  }
}

/**
 * 安全关闭 Qoder query：5 秒内未完成则放弃等待。
 *
 * 背景：pi-coding-agent / qoder-agent-sdk 的 query.close() 在子进程未完全退出时
 *  会无限阻塞，进而导致二次执行计划（runQoderPlan 复用同一个 session）时
 *  整个主流程卡在 finally 块。强制超时并清理 activeQoderQuery 至少能保证
 *  下一次执行能正常启动新的 query。
 */

type TaskRemovalMode = 'workspace' | 'all'

async function removeTaskWorkspace(taskId: string, repositories: TaskRepository[]): Promise<void> {
  const git = gitService
  for (const repo of repositories) {
    if (!repo.worktreePath) continue
    try {
      await git.removeWorktree(repo.localPath, repo.worktreePath)
    } catch {
      rmSync(repo.worktreePath, { recursive: true, force: true })
    }
  }
  rmSync(taskWorkspace(taskId), { recursive: true, force: true })
  rmSync(join(dataDir, 'worktrees', taskId), { recursive: true, force: true })
  for (const localPath of new Set(repositories.map((repo) => repo.localPath))) {
    try {
      await git.pruneWorktrees(localPath)
    } catch {
      /* The source repository may no longer exist. */
    }
  }
}

async function deleteTask(taskId: string, mode: TaskRemovalMode = 'all'): Promise<void> {
  if (mode !== 'workspace' && mode !== 'all') throw new Error('不支持的任务清理方式')
  const task = store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  await stopTaskOperations(taskId, false)
  const repositories = store.listTaskRepositories(taskId)
  await removeTaskWorkspace(taskId, repositories)

  if (mode === 'workspace') {
    for (const repo of repositories) {
      store.updateTaskRepository(repo.id, {
        worktreePath: undefined,
        featureBranch: undefined,
        deliveryStatus: 'workspace_removed'
      })
    }
    const preservedStates = new Set<TaskState>(['draft', 'failed', 'completed', 'await_merge', 'cancelled'])
    if (!preservedStates.has(task.state)) {
      store.updateTask(taskId, { state: 'cancelled', failureStage: undefined })
    }
    addTaskEvent({
      taskId,
      kind: 'status',
      title: '任务工作区已清理',
      detail: '已停止任务操作并删除 Worktree；任务、计划、执行记录和交付信息继续保留'
    })
    return
  }

  store.deleteTask(taskId)
  memoryService.deleteConversationMemories(`task:${taskId}`)
  if (activeTaskId === taskId) activeTaskId = undefined
}

async function taskChangedFiles(
  taskId: string,
  ignoreErrors = true
): Promise<Array<{ repositoryId: string; repositoryName: string; path: string; status: string }>> {
  const git = gitService
  const groups = await Promise.all(
    store.listTaskRepositories(taskId).map(async (repo) => {
      if (repo.deliveryStatus === 'workspace_removed') return []
      try {
        const files = await git.changedFiles(repo.worktreePath ?? repo.localPath, repo.baseBranch)
        return files.map((file) => ({ repositoryId: repo.repositoryId, repositoryName: repo.name, ...file }))
      } catch (error) {
        if (!ignoreErrors) throw error
        return []
      }
    })
  )
  return groups.flat()
}

async function taskCardsWithCurrentChanges() {
  return Promise.all(
    store.listCards().map(async (card) => {
      const repositories = new Map(store.listTaskRepositories(card.id).map((repo) => [repo.id, repo]))
      return {
        ...card,
        repositories: await Promise.all(
          card.repositories.map(async (repository) => {
            const repo = repositories.get(repository.id)
            if (!repo) return repository
            if (repo.deliveryStatus === 'workspace_removed') return repository
            try {
              const changedFiles = await gitService.changedFiles(repo.worktreePath ?? repo.localPath, repo.baseBranch)
              return { ...repository, changedFileCount: changedFiles.length }
            } catch {
              return repository
            }
          })
        )
      }
    })
  )
}

async function openEditorForTask(taskId: string, editor: 'vscode' | 'qoder'): Promise<void> {
  if (!(['vscode', 'qoder'] as const).includes(editor)) throw new Error('不支持的编辑器')
  const paths = store.listTaskRepositories(taskId).map((repo) => repo.worktreePath ?? repo.localPath)
  await openTaskEditor(editor, paths)
}

/**
 * 手动把任务的 feature 分支合并到本地 base 分支（不推送远端、不建 MR）。
 *
 * 触发：用户在任务详情点击「合并到 base」按钮。
 * 行为（每个仓库顺序执行）：
 *   1) 在 worktree 中 `git status --porcelain` 检查是否有未提交改动；
 *      有则拒绝并提示先 commit 或 stash。
 *   2) `git checkout <baseBranch>`。
 *   3) `git merge --no-ff <featureBranch> -m "merge: <taskId> <title>"`。
 *   4) 成功后 `git checkout <featureBranch>`，保持 worktree 习惯。
 *   5) 任何步骤失败：把 stderr 写入 task event；回滚到 feature 分支；抛错给 UI。
 *
 * 安全约束：
 *   - 任一仓库的 worktree 路径未设置或未生成 feature branch 时拒绝。
 */
async function mergeBackToBase(taskId: string, signal?: AbortSignal): Promise<void> {
  const task = store.getTask(taskId)
  if (!task) throw new Error('任务不存在')
  const repos = store.listTaskRepositories(taskId)
  if (repos.length === 0) throw new Error('任务未关联代码仓库')
  addTaskEvent({ taskId, kind: 'status', title: '开始合并 feature 分支到 base' })
  for (const repo of repos) {
    if (!repo.worktreePath) {
      addTaskEvent({
        taskId,
        kind: 'error',
        title: `仓库 ${repo.name} 缺少 worktree 路径`,
        detail: '请先完成「准备工作」创建 worktree。'
      })
      throw new Error(`仓库 ${repo.name} 缺少 worktree 路径`)
    }
    if (!repo.featureBranch) {
      addTaskEvent({
        taskId,
        kind: 'error',
        title: `仓库 ${repo.name} 未生成 feature 分支`,
        detail: '请先完成实现再合并。'
      })
      throw new Error(`仓库 ${repo.name} 未生成 feature 分支`)
    }
    const cwd = repo.worktreePath
    signal?.throwIfAborted()
    try {
      const status = (await gitService.status(cwd)).trim()
      if (status) {
        addTaskEvent({
          taskId,
          kind: 'error',
          title: `仓库 ${repo.name} 工作区不干净`,
          detail: `请先 commit 或 stash 当前改动。\n${status}`
        })
        throw new Error(`仓库 ${repo.name} 工作区存在未提交改动`)
      }
      addTaskEvent({ taskId, kind: 'command', title: `git checkout ${repo.baseBranch}`, detail: `工作目录: ${cwd}` })
      await gitService.checkout(cwd, repo.baseBranch, signal)
      const message = `merge: ${task.taskKey ?? task.id} ${task.title.slice(0, 60)}`
      addTaskEvent({ taskId, kind: 'command', title: `git merge --no-ff ${repo.featureBranch}`, detail: message })
      await gitService.mergeNoFF(cwd, repo.featureBranch, message, signal)
      addTaskEvent({
        taskId,
        kind: 'status',
        title: `仓库 ${repo.name} 已合并 ${repo.featureBranch} -> ${repo.baseBranch}`
      })
      addTaskEvent({
        taskId,
        kind: 'command',
        title: `git checkout ${repo.featureBranch}`,
        detail: '合并完成后切回 feature 分支，保持 worktree 习惯'
      })
      await gitService.checkout(cwd, repo.featureBranch, signal)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // 失败时尝试切回 feature 分支，避免把 worktree 留在 base。
      try {
        await gitService.checkout(cwd, repo.featureBranch, signal)
      } catch {
        /* 静默：原始错误更重要 */
      }
      addTaskEvent({ taskId, kind: 'error', title: `仓库 ${repo.name} 合并失败`, detail })
      throw error
    }
  }
  addTaskEvent({ taskId, kind: 'status', title: '已合并所有仓库的 feature 分支到 base（未推送远端）' })
}

type TaskBackendId = 'jira' | 'github' | 'linear'
type TaskBackendInfo = { id: TaskBackendId; displayName: string; configured: boolean }

/**
 * 列出所有可用的「任务创建」后端。
 *
 * - Jira 后端的"configured" 取决于 JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN 是否齐全。
 * - GitHub / Linear 后端本期未实现，显示但 configured=false，方便 UI 提示用户。
 */
function listTaskBackends(): TaskBackendInfo[] {
  const jiraConfigured = !!(
    desktopResolver.get('jiraBaseUrl') &&
    desktopResolver.get('jiraEmail') &&
    desktopResolver.get('jiraApiToken')
  )
  // 计划内的占位项：实际接入由后续任务负责。
  return [
    { id: 'jira', displayName: 'Jira', configured: jiraConfigured },
    { id: 'github', displayName: 'GitHub Issues', configured: false },
    { id: 'linear', displayName: 'Linear', configured: false }
  ]
}

/**
 * 根据系统设置解析当前默认后端。任务创建 Agent 在 `chat-service` 启动时使用。
 */
function resolveDefaultBackend(): TaskBackendId {
  const hint = desktopResolver.get('taskCreationBackend')
  if (hint === 'jira' || hint === 'github' || hint === 'linear') return hint
  // 默认回退到 Jira（保持现有行为）。
  return 'jira'
}

async function* holdQoderProbe(signal: AbortSignal): AsyncGenerator<never> {
  if (signal.aborted) return
  // 该生成器仅作为 query() 的占位 prompt 使用，目的是让 SDK 走 AsyncIterable 分支以保持会话在线，
  // 供 getQoderStatus() 读取 initialization/usage/models，无需产生任何用户消息。
  // `yield` 出一个 `never` 值（abort 后才解析），既满足 require-yield，又保持会话直到 abort。
  yield (await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true })
  )) as never
}

async function getQoderStatus(): Promise<QoderStatus> {
  const token = protectedValue('qoderToken')
  if (!token) return { enabled: false, connected: false, running: false, models: [] }
  const probeAbort = activeQoderQuery ? undefined : new AbortController()
  const q =
    activeQoderQuery ??
    query({
      prompt: holdQoderProbe(probeAbort!.signal),
      options: {
        auth: accessToken(token),
        cwd: process.cwd(),
        abortController: probeAbort,
        persistSession: false,
        controlRequestTimeoutMs: 15_000
      }
    })
  try {
    const initialization = await q.initializationResult()
    const usage = await q.getUsageInfo()
    let models = initialization.models
    try {
      models = await q.getAvailableModels({ fetchStrategy: 'cache' })
    } catch {
      /* Initialization models are a valid fallback for older runtimes. */
    }
    return {
      enabled: true,
      connected: true,
      running: Boolean(activeQoderQuery),
      account: initialization.account,
      usage,
      models: models
        .filter((model) => model.isEnabled !== false)
        .map(({ value, displayName, description, isDefault, isEnabled, isReasoning, isVl, priceFactor }) => ({
          value,
          displayName,
          description,
          isDefault,
          isEnabled,
          isReasoning,
          isVl,
          priceFactor
        }))
    }
  } catch (error) {
    console.error('[qoder:status] probe failed:', error instanceof Error ? error.message : String(error))
    return {
      enabled: true,
      connected: false,
      running: Boolean(activeQoderQuery),
      models: [],
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (probeAbort) {
      probeAbort.abort()
      try {
        await q.close()
      } catch {
        /* The probe may already be closed after an initialization failure. */
      }
    }
  }
}

// === Memory 任务上下文(检索/注入/整理) ========================================

/**
 * 选择当前任务执行(consolidate memory)用的 chat 模型:固定跟随系统 modelProfile 决定 driver。
 * - driverId = "qoder" / "openai"
 * - model 是 OpenAI 协议下的具体模型名(Qoder 模式下不使用,driver 内部自己拿默认)
 */
function resolveTaskChatModel(): { driverId: ChatDriverId; model: string } {
  if (modelProvider() === 'openai') {
    return { driverId: 'openai', model: store.getSetting('defaultOpenAIModel') ?? 'gpt-4o' }
  }
  return { driverId: 'qoder', model: store.getSetting('defaultModel') ?? 'claude-sonnet-4.5' }
}

async function taskMemoryContext(task: Task, repos: TaskRepository[]): Promise<string | undefined> {
  try {
    const { memories, wikiDocs } = await memoryService.search({
      userId: memoryService.ensureUserId(),
      repositoryIds: repos.map((repo) => repo.repositoryId),
      conversationId: `task:${task.id}`,
      query: `${task.title}\n${task.description}`
    })
    addTaskEvent({
      taskId: task.id,
      kind: 'status',
      title: '检索记忆上下文',
      detail: `用户级 ${memories.filter((m) => m.scope === 'user').length} 条、仓库级 ${memories.filter((m) => m.scope === 'repo').length} 条、对话级 ${memories.filter((m) => m.scope === 'conversation').length} 条、repowiki 文档 ${wikiDocs.length} 篇${memories.length + wikiDocs.length ? '' : '（未命中）'}`
    })
    return renderMemoryContext(memories, wikiDocs)
  } catch (error) {
    console.warn('[memory] task context failed:', error)
    return undefined
  }
}

async function consolidateTaskMemory(taskId: string, responseTexts: string[]): Promise<void> {
  try {
    const task = store.getTask(taskId)
    if (!task) return
    const repos = store.listTaskRepositories(taskId)
    const events = store.listEvents(taskId)
    const transcript = [
      `任务：${task.title}\n${task.description}`,
      task.planContent ? `计划：\n${task.planContent}` : '',
      ...events.slice(-80).map((event) => `[${event.kind}] ${event.title}${event.detail ? `\n${event.detail}` : ''}`),
      ...responseTexts.slice(-5).map((text) => `AI 输出：\n${text}`)
    ].join('\n\n')
    const { driverId, model } = resolveTaskChatModel()
    const driver = chatDriverRegistry.tryGet(driverId)
    if (!driver) return
    const extracted = await extractMemories({
      driver,
      driverId,
      model,
      text: transcript,
      context: 'task',
      allowedScopes: ['user', 'repo']
    })
    if (!extracted.length) return
    const saved = memoryService.consolidateMemories(
      extracted,
      repos.map((repo) => repo.repositoryId),
      `task:${taskId}`
    )
    if (saved > 0) {
      addTaskEvent({
        taskId,
        kind: 'status',
        title: '记忆整理完成',
        detail: `从任务执行记录中整理并保存 ${saved} 条记忆`
      })
    }
  } catch (error) {
    console.warn('[memory] task consolidate failed:', error)
  }
}

/**
 * 把会话文本喂给 memory extraction,提取长期记忆。
 *
 * 协议:
 *  - conversation 来自 ChatService,messages 是 StoredMessageRecord(无 parts),
 *    所以这里直接用 driver.deserializeMessage 拼出 parts,提取 text。
 *  - driverId 由 conversation.driverId 决定(单会话切换 driver 时仍用最后选定的 driver 来 extract)。
 */
async function consolidateChatMemory(input: {
  conversation: ChatConversation
  signal: AbortSignal
  driverId: ChatDriverId
  model: string
}): Promise<void> {
  try {
    const driver = chatDriverRegistry.tryGet(input.driverId)
    const text = input.conversation.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        const record = message
        const parts = driver ? driver.deserializeMessage(record).parts : []
        const messageText = parts
          .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
          .map((part) => part.text)
          .join('')
        return `${message.role === 'user' ? '用户' : '助手'}：${messageText}`
      })
      .join('\n\n')
    if (!text.trim()) return
    if (!driver) return
    const extracted = await extractMemories({
      driver,
      driverId: input.driverId,
      model: input.model,
      text,
      context: 'chat',
      allowedScopes: ['user', 'conversation'],
      signal: input.signal
    })
    if (!extracted.length) return
    memoryService.consolidateMemories(extracted, [], input.conversation.id)
  } catch (error) {
    console.warn('[memory] chat consolidate failed:', error)
  }
}

// === IPC 路由(全部保留) =======================================================

function registerIpc(): void {
  // Trace 页面：聚合四路数据源（tasks+events / chats-v3 / pi-sessions / pi-trace events.jsonl）。
  ipcMain.handle('trace:list', () => traceService.listSummaries())
  ipcMain.handle('trace:get', (_event, kind: string, traceId: string) =>
    traceService.getTrace(traceId, kind as TraceKind)
  )
  ipcMain.handle('tasks:list', async () => {
    await mergeRefresher.refresh()
    return taskCardsWithCurrentChanges()
  })
  ipcMain.handle('tasks:get', async (_event, id: string) => {
    await mergeRefresher.refresh()
    return {
      task: store.getTask(id),
      repositories: store.listTaskRepositories(id),
      events: store.listEvents(id),
      approvals: store.listApprovals(id),
      changedFiles: await taskChangedFiles(id)
    }
  })
  ipcMain.handle(
    'tasks:create',
    (_event, input: Pick<Task, 'title' | 'description'> & Partial<Pick<Task, 'keywords' | 'acceptanceCriteria'>>) =>
      store.createTask(input)
  )
  ipcMain.handle('tasks:update', (_event, id: string, patch: Record<string, unknown>) => store.updateTask(id, patch))
  ipcMain.handle('tasks:delete', (_event, id: string, mode?: TaskRemovalMode) => deleteTask(id, mode))
  ipcMain.handle('repos:list', () => store.listRepositoryProfiles())
  ipcMain.handle('repos:save', async (_event, profile) => {
    store.saveRepositoryProfile(profile)
    try {
      await memoryService.refreshRepoWiki(profile.id, profile.localPath)
    } catch (error) {
      console.warn('[repowiki] index failed:', error)
    }
  })
  ipcMain.handle('repos:delete', (_event, id: string) => {
    store.deleteRepositoryProfile(id)
    memoryService.deleteRepoMemories(id)
    // 同步解绑所有绑定该仓库的 Agent，避免 repositoryIds 残留死引用
    const removedAgents = agentService.detachRepository(id)
    return { removedAgents }
  })
  ipcMain.handle('repos:choose-folder', async () => {
    const localPath = (await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })).filePaths[0]
    if (!localPath) return undefined
    try {
      const info = await gitService.inspectRepository(localPath)
      return {
        name: basename(info.rootPath),
        localPath: info.rootPath,
        remoteUrl: info.remoteUrl,
        defaultBranch: info.currentBranch
      }
    } catch {
      throw new Error('仓库异常:所选目录不是有效的 Git 仓库,或当前未检出分支')
    }
  })
  ipcMain.handle('tasks:attach-repo', (_event, taskId: string, repositoryId: string) =>
    store.attachRepository(taskId, repositoryId)
  )
  ipcMain.handle('tasks:detach-repo', (_event, taskId: string, repositoryId: string) =>
    store.detachRepository(taskId, repositoryId)
  )
  // 编辑任务时持久化每个已关联仓库的命令配置（setup / lint / test / build）。
  ipcMain.handle(
    'tasks:update-repo-commands',
    (
      _event,
      taskId: string,
      repositoryId: string,
      commands: Partial<Pick<TaskRepository, 'setupCommand' | 'lintCommand' | 'testCommand' | 'buildCommand'>>
    ) => {
      const repo = store.listTaskRepositories(taskId).find((item) => item.repositoryId === repositoryId)
      if (!repo) throw new Error(`任务仓库不存在: ${repositoryId}`)
      return store.updateTaskRepository(repo.id, commands)
    }
  )
  ipcMain.handle('settings:get', (_event, key: string) =>
    ['jiraToken', 'confluenceToken', 'qoderToken', 'modelApiKey', 'gitlabToken'].includes(key)
      ? store.getSetting(key)
        ? '__configured__'
        : undefined
      : store.getSetting(key)
  )
  ipcMain.handle('settings:set', (_event, key: string, value: string, secret = false) => {
    store.setSetting(key, secret ? keyStore.protect(value, key) : value)
    if (key === 'modelProfile') syncPiModelConfig(value)
  })
  ipcMain.handle(
    'tasks:start',
    (
      _event,
      taskId: string,
      options?: {
        mode?: TaskStartMode
        repositoryCommands?: RepositoryCommandMap
        useAllRepositories?: boolean
        repoAgentIds?: Record<string, string>
      }
    ) => startTask(taskId, options)
  )
  ipcMain.handle('tasks:reimplement', (_event, taskId: string) => taskWorkflow.reimplement(taskId))
  ipcMain.handle('tasks:resume', (_event, taskId: string) => resumeTask(taskId))
  ipcMain.handle('tasks:pause', (_event, taskId: string) => pauseTask(taskId))
  ipcMain.handle('tasks:resume-paused', (_event, taskId: string) => resumePausedTask(taskId))
  ipcMain.handle('tasks:update-plan', (_event, taskId: string, planContent: string) =>
    updateTaskPlan(taskId, planContent)
  )
  ipcMain.handle('tasks:approve-plan', (_event, taskId: string) => approveTaskPlan(taskId))
  ipcMain.handle('tasks:revise-plan', (_event, taskId: string, feedback: string) => reviseTaskPlan(taskId, feedback))
  ipcMain.handle('tasks:retry-validation', (_event, taskId: string) => retryTaskValidation(taskId))
  ipcMain.handle('tasks:message', (_event, taskId: string, message: string) => sendTaskMessage(taskId, message))
  ipcMain.handle('tasks:abort', () => (activeTaskId ? stopTaskOperations(activeTaskId, true) : undefined))
  ipcMain.handle('tasks:review', (_event, taskId: string) =>
    runTaskOperation(taskId, (signal) => runReviewWithAutoFix(taskId, signal))
  )
  ipcMain.handle('tasks:reset-review', (_event, taskId: string) => taskWorkflow.resetReview(taskId))
  ipcMain.handle('tasks:reset-delivery', (_event, taskId: string) => deliveryService.resetDelivery(taskId))
  ipcMain.handle('tasks:submit-mrs', (_event, taskId: string) =>
    runTaskOperation(taskId, (signal) => deliveryService.submitMergeRequests(taskId, signal))
  )
  ipcMain.handle('tasks:refresh-merge-status', () => mergeRefresher.refresh())
  ipcMain.handle('tasks:manual-complete', (_event, taskId: string) => taskCompleter.manualComplete(taskId))
  ipcMain.handle('tasks:open-editor', (_event, taskId: string, editor: 'vscode' | 'qoder') =>
    openEditorForTask(taskId, editor)
  )
  ipcMain.handle('tasks:merge-back-to-base', (_event, taskId: string) =>
    runTaskOperation(taskId, (signal) => mergeBackToBase(taskId, signal))
  )
  // 在系统文件管理器打开任务 workspace（所有仓库 worktree 的父目录），不区分单/多仓库。
  ipcMain.handle('tasks:reveal-workspace', (_event, taskId: string) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('taskId 不能为空')
    const workspace = taskWorkspace(taskId)
    if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true })
    shell.showItemInFolder(workspace)
  })
  ipcMain.handle('tasks:list-backends', () => listTaskBackends())
  ipcMain.handle('qoder:status', () => getQoderStatus())
  // 用系统默认浏览器打开 URL(避免在 Electron 内嵌窗口中 target=_blank 开新 BrowserWindow)。
  // 只放行 http(s),防止被注入 file:// / 命令协议等本地 scheme。
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (typeof url !== 'string') throw new Error('url 必须是字符串')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('无效的 URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http(s) 链接')
    await shell.openExternal(parsed.toString())
  })
  ipcMain.handle('jira:import', async (_event, keyOrUrl: string) =>
    safeAtlassianCall('导入 Jira Issue', () => importJiraIssue(atlassianFactory.create('jira'), keyOrUrl, store))
  )
  ipcMain.handle('jira:sync', async () =>
    safeAtlassianCall('同步 Jira 任务', async () => {
      const candidates = await fetchJiraTasks(atlassianFactory.create('jira'))
      // 标注每个候选项在本地系统中的状态:已存在(existing)且不在 TODO 列(conflict)时,
      // 前端导入需要用户确认覆盖。
      return candidates.map((candidate) => {
        const existing = candidate.taskKey ? store.getTaskBySourceKey('jira', candidate.taskKey) : undefined
        return {
          ...candidate,
          existing: Boolean(existing),
          conflict: Boolean(existing && boardColumnFor(existing.state) !== 'todo')
        }
      })
    })
  )
  ipcMain.handle('jira:import-many', (_event, candidates: Array<Record<string, unknown>>) => {
    const tasks = candidates.flatMap((candidate) => {
      const taskKey = typeof candidate.taskKey === 'string' ? candidate.taskKey.trim().toUpperCase() : ''
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
      if (!taskKey || !title) return []
      return [
        store.upsertJiraTask({
          taskKey,
          source: 'jira',
          sourceUrl: typeof candidate.sourceUrl === 'string' ? candidate.sourceUrl : undefined,
          title,
          description: typeof candidate.description === 'string' ? candidate.description : '',
          keywords: Array.isArray(candidate.keywords) ? candidate.keywords.map(String) : [],
          acceptanceCriteria: Array.isArray(candidate.acceptanceCriteria)
            ? candidate.acceptanceCriteria.map(String)
            : [],
          state: 'draft',
          reviewStatus: 'pending'
        })
      ]
    })
    if (tasks.length > 0) store.setSetting('lastJiraSync', new Date().toISOString())
    return tasks
  })
  ipcMain.handle('atlassian:test', async (_event, kind: 'jira' | 'confluence') =>
    testAtlassianConnection(atlassianFactory.create(kind))
  )
  ipcMain.handle('task:ui-response', (_event, response: Record<string, unknown>) =>
    pendingUi.get(String(response.id))?.(response)
  )
  // === Memory 系统(仓库级 / 用户级 / 对话级 + repowiki 文档) ==================
  ipcMain.handle(
    'memory:list',
    (
      _event,
      filter?: { scope?: Memory['scope']; scopes?: Memory['scope'][]; repositoryId?: string; conversationId?: string }
    ) => memoryService.listMemories(filter)
  )
  ipcMain.handle('memory:upsert', (_event, input: Parameters<MemoryService['upsertMemory']>[0]) =>
    memoryService.upsertMemory(input)
  )
  ipcMain.handle(
    'memory:update',
    (_event, id: string, patch: Partial<Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>>) =>
      memoryService.updateMemory(id, patch)
  )
  ipcMain.handle('memory:delete', (_event, id: string) => memoryService.deleteMemory(id))
  ipcMain.handle(
    'memory:search',
    (_event, query: string, options?: { repositoryIds?: string[]; conversationId?: string; limit?: number }) =>
      memoryService.search({ userId: memoryService.ensureUserId(), query, ...options })
  )
  ipcMain.handle('repowiki:index', async (_event, repositoryId: string) => {
    const profile = store.listRepositoryProfiles().find((repo) => repo.id === repositoryId)
    if (!profile) throw new Error('仓库不存在')
    return memoryService.refreshRepoWiki(profile.id, profile.localPath)
  })
  ipcMain.handle('repowiki:list', (_event, repositoryId: string) => memoryService.listRepoWikiDocs(repositoryId))
  ipcMain.handle('repowiki:search', (_event, repositoryId: string, query: string) =>
    memoryService.searchRepoWikiDocs(repositoryId, query)
  )
  // === Agent 配置 =========================================================
  ipcMain.handle('agents:list', () => agentService.list())
  ipcMain.handle('agents:save', (_event, profile: AgentProfile) => {
    agentService.save(profile)
    return agentService.list()
  })
  ipcMain.handle('agents:delete', (_event, id: string) => {
    agentService.delete(id)
    return agentService.list()
  })
  ipcMain.handle('agents:templates', () => AGENT_TEMPLATES)
  ipcMain.handle('agents:export', async () => {
    const window = mainWindow
    if (!window) throw new Error('窗口不可用')
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: '导出 Agent 配置',
      defaultPath: join(app.getPath('downloads'), `agents-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return undefined
    writeFileSync(filePath, `${JSON.stringify(agentService.list(), null, 2)}\n`, 'utf8')
    return filePath
  })
  ipcMain.handle('agents:import', async () => {
    const window = mainWindow
    if (!window) throw new Error('窗口不可用')
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: '导入 Agent 配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || filePaths.length === 0) return undefined
    const parsed = JSON.parse(readFileSync(filePaths[0]!, 'utf8')) as unknown
    if (!Array.isArray(parsed)) throw new Error('导入文件必须是 Agent 数组（导出的 JSON 可直接导入）')
    return agentService.importAll(parsed as AgentProfile[])
  })
  /**
   * 新增 Agent 弹窗中的"AI 生成"按钮：按用户选定的模型（驱动 + 模型名）一次性调 LLM，
   * 根据用户描述 + 选中仓库生成 systemPrompt / engineeringGuidelines。
   * 入口由前端保证模型已选；此处再做一次前置校验（防御编程）。
   *
   * 成功后会在 trace_events 写一条 "其它" 事件，让 Trace 页能看到该次生成。
   */
  ipcMain.handle(
    'agents:generate-content',
    async (
      _event,
      input: {
        model: string
        description: string
        repositories: AgentGenerationRepository[]
      }
    ) => {
      const model = input?.model?.trim()
      if (!model) throw new Error('请先在 Agent 弹窗中选择一个模型')
      const description = input?.description ?? ''
      const repositories = input?.repositories ?? []
      // 先读仓库本地背景（repowiki / agents.md / README.md）注入 prompt，
      // 这样无论 Qoder 还是 OpenAI 兼容模型都能拿到一致上下文；Qoder 路径还会另外
      // 启用只读工具（Read / Glob / Grep）让模型按需补充细节。
      const repoContext = await loadRepoContext(repositories)
      const prompt = buildAgentGenerationPrompt({ description, repositories, repoContext })
      // model 形如 `qoder:xxx` / `openai:default` / 其它自由字符串；按 `qoder:` 前缀判定驱动。
      // qoder 路径走专用轻量调用（只读工具 / maxTurns=3 / 120s 超时）——见 callQoderForAgentGeneration 注释。
      // openai 路径走纯 prompt fetch（不启工具，超时也压到 120s 与 Qoder 对齐）。
      const isQoder = model.startsWith('qoder:')
      const raw = isQoder
        ? await callQoderForAgentGeneration(prompt, model.slice('qoder:'.length), {
            additionalDirectories: repositories.map((repo) => repo.localPath)
          })
        : await callOpenAIForPrompt(prompt, AGENT_GENERATOR_TASK_ID, model, undefined, { timeoutMs: 120_000 })
      const result = parseAgentGenerationResult(raw)
      // 记录"其它"trace 事件：仅在生成成功后写入，失败不入库。
      // - `detail`：Timeline 直接以 `<pre>` 渲染给用户看，必须包含 4 个生成字段的实际内容
      //   （名称 / 说明 / 系统提示词 / 工程约定），同时在顶部保留用户输入上下文。
      // - `payload`：结构化字段（4 个字段实际文本 + 长度 + 模型 + 仓库 ID / 名）供后续统计 / 筛选 / 详情展开。
      const repositoryNames = repositories.map((repository) => repository.name).join('、')
      const detail = formatAgentGenerationDetail({
        description: description.trim(),
        repositoryNames,
        result
      })
      try {
        store.addTraceEvent({
          category: 'other',
          subType: 'agent_template_generation',
          title: 'AI 生成 Agent 模板',
          detail,
          payload: {
            model,
            description: description.trim(),
            repositoryIds: repositories.map((repository) => repository.id),
            repositoryNames: repositories.map((repository) => repository.name),
            // 4 个生成字段：完整内容 + 长度同时存，避免详情面板需要重读库。
            title: result.title,
            generatedDescription: result.description,
            systemPrompt: result.systemPrompt,
            engineeringGuidelines: result.engineeringGuidelines,
            titleLength: result.title.length,
            descriptionLength: result.description.length,
            systemPromptLength: result.systemPrompt.length,
            engineeringGuidelinesLength: result.engineeringGuidelines.length
          }
        })
      } catch (reason) {
        // trace 写入失败不影响主功能：只输出错误，不向用户抛错。
        console.error('[agents] 写入 trace 事件失败', reason)
      }
      return result
    }
  )
  // === Chat 对话(Codex 样式) =================================================
  ipcMain.handle('chats:list', () => chatService.listChats())
  ipcMain.handle('chats:get', (_event, id: string) => chatService.getChat(id))
  ipcMain.handle('chats:create', (_event, input?: { driverId?: ChatDriverId; model?: string }) =>
    chatService.createChat(input?.driverId, input?.model)
  )
  ipcMain.handle('chats:delete', (_event, id: string) => {
    chatService.deleteChat(id)
    memoryService.deleteConversationMemories(id)
  })
  ipcMain.handle('chats:list-models', () => chatService.listModels())
  ipcMain.handle('chats:start-stream', (_event, input) => {
    void chatService.startChatStream(input).catch((reason) => console.error('[chat] stream failed', reason))
  })
  ipcMain.handle('chats:abort', (_event, input) => chatService.abortChat(input))
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#111210',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  })
  if (process.env.VITE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  else await mainWindow.loadFile(join(__dirname, '../dist/index.html'))
}

app.whenReady().then(() => {
  if (!resolveBundledOcrBinary()) {
    console.warn(
      '[ocr] @alibaba-group/open-code-review not found in node_modules; reviews will fall back to PATH lookup and may fail in packaged builds.'
    )
  }
  registerIpc()
  void createWindow()
  for (const repo of store.listRepositoryProfiles()) {
    void memoryService
      .refreshRepoWiki(repo.id, repo.localPath)
      .catch((error) => console.warn('[repowiki] startup index failed:', error))
  }
  const mergeTimer = setInterval(() => {
    void mergeRefresher.refresh()
  }, 60_000)
  mergeTimer.unref()
  app.on('browser-window-focus', () => {
    void mergeRefresher.refresh()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  void stopPi()
  store.close()
})
