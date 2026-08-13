import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
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
  JsonlTraceStorage,
  summarizeTrace,
  traceEventsDir,
  traceInfoFile,
  lookupCostRate,
  type AgentEvent,
  type AgentProfile,
  type AgentSpan,
  type AgentSpanUsage,
  type Memory,
  type MemoryScope,
  type MemorySearchHit,
  type RepoWikiSearchHit,
  type SettingResolver,
  type Task,
  type TaskEventSink,
  type TaskRepository,
  type TaskStartMode,
  type TaskState
} from '@task-pipeline/core'
import {
  AtlassianClientFactory,
  DeliveryService,
  fetchJiraTasks,
  GitService,
  importJiraIssue,
  McpClient,
  MergeStatusRefresher,
  openTaskEditor,
  OpenCodeReviewService,
  OpenAICompatReviewer,
  parseGitLabRemote,
  redactSecrets,
  ReviewOrchestrator,
  TaskCompleter,
  TaskWorkflow,
  testAtlassianConnectionRest,
  asReviewer,
  type RepositoryCommandMap
} from '@task-pipeline/integrations'
import {
  accessToken,
  query,
  QoderCliProcessError,
  type AccountInfo,
  type ModelInfo,
  type Query,
  type UsageInfo
} from '@qoder-ai/qoder-agent-sdk'
import { TraceService } from './trace/trace-service.js'
import { TracePipeline } from './trace/bus/trace-pipeline.js'
import { PiTraceBuilder } from './trace/instrument/pi-trace-builder.js'
import { QoderTraceBuilder } from './trace/instrument/qoder-trace-builder.js'
import { resolveBundledOcrBinary, resolveOcrBinary, createOcrRunner } from './ocr.js'
import { parsePlanDecision } from './plan-content.js'
import { ChatService, type ChatTraceManager } from './chat/chat-service.js'
import { LITE_MODEL_PATTERN } from './chat/system-default-model.js'
import { ChatDriverRegistry } from './chat/drivers/driver-registry.js'
import { QoderChatDriver } from './chat/drivers/qoder-chat-driver.js'
import { OpenAIChatDriver } from './chat/drivers/openai-chat-driver.js'
import { isOpenAIModelValue, prefixOfVendor, stripModelPrefix } from './chat/drivers/model-value.js'
import { detectVendor } from './chat/drivers/model-providers.js'
import { createMcpServiceResolver } from './chat/mcp-services.js'
import {
  loadMcpServers,
  saveMcpServers,
  validateMcpServerEntry,
  BUILTIN_MCP_IDS,
  type McpServerEntry
} from './chat/mcp-config.js'
import { listSkills, importSkillZip, importSkillFolder, deleteSkill, readSkillContent } from './chat/skill-store.js'
import { JiraTaskCreationBackend } from './chat/task-backends/jira.js'
import type { ChatDriverId, ChatConversation } from './chat/chat-types.js'
import { MemoryService, renderMemoryContext, type KeywordRewriter } from './memory/memory-service.js'
import { extractMemories } from './memory/memory-extractor.js'
import { extractKeywords } from './memory/memory-keyword-extractor.js'
import {
  implementationOutcomeInstruction,
  isExplicitNoChangeCompletionRequest,
  nextStepForImplementation,
  nextStepForPlan,
  parseImplementationDecision
} from './task-readiness.js'
import { QoderTaskAgentDriver, stripQoderModelPrefix } from './task-agent/qoder-task-agent.js'
import { describeToolAction, isDangerousTool, isWriteTool } from './task-agent/dangerous-tools.js'
import { closeQoderQuerySafely, recordQoderMessage } from './task-agent/log.js'
import { parseTestCaseGeneration } from './task-agent/parsers/test-case-parser.js'
import { AgentService, type OperationKind } from './agents/agent-service.js'
import { AGENT_TEMPLATES } from './agents/templates.js'
import {
  buildAgentGenerationPrompt,
  formatRepoContext,
  parseAgentGenerationResult,
  type AgentGenerationRepository,
  type RepoContextEntry
} from './agents/agent-generator.js'

/**
 * 修复 Qoder Agent SDK 在 Electron asar 打包下的 qodercli 路径解析问题。
 *
 * SDK 内部通过 `import.meta.url` 拼接 `<sdk>/dist/_bundled/qodercli` 定位 CLI:
 *
 *   function Tt() {
 *     if (process.env.QODERCLI_PATH) return process.env.QODERCLI_PATH;
 *     let s = vr(); // 走 import.meta.url 解析
 *     ...
 *   }
 *
 * Electron 打包后,SDK 的 dist/index.js 仍位于 app.asar 内,import.meta.url
 * 指向虚拟路径。asar 透明层让 existsSync 误判 qodercli "存在",但 spawn 一个
 * asar 内的二进制(无真实 inode)会失败 `ENOTDIR`,表现是 Qoder 连接状态一直
 * 报 "未连接" + `spawn ENOTDIR`。
 *
 * prepackage 阶段已把 qodercli 复制到 `qoder-bin/qodercli`(同步进入
 * asarUnpack),我们显式设置 QODERCLI_PATH,让 SDK 在第一行短路返回,
 * 跳过自己的 import.meta.url 解析链。dev 模式下 qoder-bin 不存在时
 * 不设该环境变量,SDK 会走默认的 node_modules 路径解析。
 */
if (!process.env.QODERCLI_PATH) {
  const binaryName = process.platform === 'win32' ? 'qodercli.exe' : 'qodercli'
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'qoder-bin', binaryName)
    : join(app.getAppPath(), 'qoder-bin', binaryName)
  if (existsSync(candidate)) {
    process.env.QODERCLI_PATH = candidate
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
/**
 * 「AI 生成 Agent 模板」用的一次性哨兵 taskId。
 * 这类调用不挂任何任务 —— events 表对 task_id 有 FK 约束，
 * `callQoderReviewer` 内部会读 `store.getTask(taskId)` 识别哨兵，跳过 `recordQoderMessage`
 * （包含 addEvent / updateTask / emitPi），避免外键异常。
 */
const AGENT_GENERATOR_TASK_ID = '__agent_generator__'
// 开发环境下 Electron 默认按 package.json 的 name(@task-pipeline/desktop)生成 userData 目录,
// 这里显式固定为产品名,保证 dev 与打包版都落在 ~/Library/Application Support/TaskPipeline
app.setName('TaskPipeline')
let mainWindow: BrowserWindow | undefined
let piSession: AgentSession | undefined
let unsubscribePi: (() => void) | undefined
const pendingUi = new Map<string, (response: Record<string, unknown>) => void>()
const dataDir = process.env.TASK_PIPELINE_DATA_DIR ?? join(app.getPath('userData'), 'data')
process.env.TASK_PIPELINE_DATA_DIR = dataDir
mkdirSync(dataDir, { recursive: true })
// Skill 根目录（dataDir/skills）：设置页管理 + 对话注入（Qoder 走 QODER_CONFIG_DIR，OpenAI 走 system 拼接）。
const skillsRoot = join(dataDir, 'skills')
const store = new (class extends TaskStore {
  /**
   * 任务终态统一收尾：任何路径（workflow / completer / merge-refresher / IPC / updateState）
   * 把任务置为终态都会经过这里，收尾任务 Trace（endTrace 幂等），避免「任务已完成但 Trace
   * 仍显示进行中」。tracePipeline / qoderTaskAgent 在模块后段初始化，运行时已就绪。
   */
  override updateTask(id: string, patch: Parameters<TaskStore['updateTask']>[1]): Task {
    const updated = super.updateTask(id, patch)
    if (updated.state === 'completed' || updated.state === 'failed' || updated.state === 'cancelled') {
      finalizeTaskTrace(id)
    }
    return updated
  }

  override deleteTask(id: string): void {
    finalizeTaskTrace(id)
    super.deleteTask(id)
  }
})(join(dataDir, 'task-pipeline.db'))
const keyStore = new LocalFileKeyStore(dataDir)

/**
 * 在途的任务记忆整理 promise（finishImplementation 异步触发时登记）。
 * finalizeTaskTrace 发现 pending 时把 endTrace 链到整理完成之后——endTrace 会强制收尾
 * 所有未关 span，直接收尾会把正在执行的整理 LLM 调用截断（endTrace 幂等，重复触发安全）。
 */
const taskMemoryPending = new Map<string, Promise<void>>()

/**
 * 任务终态统一收尾（唯一出口）：
 * - Finish 终端标记：endTrace 前写入完结 span（meta.finalState 承载最终业务状态
 *   completed/failed/cancelled——两态模型下 trace status 只有「进行中/已结束」，
 *   业务成败由 Finish span 与任务状态机承载，不由 trace status 表达）；
 * - qoder 路径：QoderTraceBuilder 关闭未收尾 span 并清理 taskId 状态；
 * - pi 路径：丢弃 PiTraceBuilder（未收尾 span 由 endTrace 兜底关闭）；
 * - TracePipeline.endTrace：聚合摘要 + 写 info 摘要文件，幂等（已结束的 trace 直接忽略）。
 */
function finalizeTaskTrace(taskId: string): void {
  qoderTaskAgent?.finishTrace(taskId)
  piTraceBuilders.delete(taskId)
  if (tracePipeline.isActive(taskId)) {
    const task = store.getTask(taskId)
    const finalState = task?.state
    if (finalState === 'completed' || finalState === 'failed' || finalState === 'cancelled') {
      try {
        const finishSpan = tracePipeline.startSpan(taskId, {
          type: 'agent.run',
          name: 'Finish',
          meta: { source: providerForTask(taskId) === 'qoder' ? 'qoder' : 'pi', phase: 'finish', finalState }
        })
        tracePipeline.endSpan(taskId, finishSpan)
      } catch {
        /* trace 收尾失败不影响任务 */
      }
    }
  }
  const memoryPending = taskMemoryPending.get(taskId)
  if (memoryPending) {
    void memoryPending.then(() => tracePipeline.endTrace(taskId))
    return
  }
  tracePipeline.endTrace(taskId)
}
const memoryService = new MemoryService(store)
// Agent 体系：可配置多 Agent + 仓库白名单绑定 + 模型路由（配置存 settings key `agentProfiles`）。
// 第 4/5 个参数：系统默认模型运行时动态回填（不落盘）+ 存储模型值的存在性校验（失效回落默认）。
const agentService = new AgentService(
  (key) => store.getSetting(key),
  (key, value) => store.setSetting(key, value),
  (repositoryId) => memoryService.listRepoWikiDocs(repositoryId),
  () => syncSystemDefaultModel(),
  (model) => isModelValueAvailable(model)
)
let activeTaskId: string | undefined
let activeQoderQuery: Query | undefined
let activeQoderAbort: AbortController | undefined
let activePlanningTaskId: string | undefined
let activePlanText = ''
/**
 * planning 期间最近一次 assistant 错误消息（pi 在模型流式错误如
 * `Stream ended without finish_reason` 时不抛异常，而是生成 stopReason=error
 * 的 assistant 消息正常返回；这里由 emitPi 检测 message_end 记录，runOpenAIPlan
 * 在 prompt 返回后读取并显式抛错，避免任务静默卡在 planning）。
 */
let activePlanError: string | undefined
type ActiveTaskOperation = { controller: AbortController; promise: Promise<unknown> }
const activeTaskOperations = new Map<string, ActiveTaskOperation>()

type ModelProfile = {
  id?: string
  provider?: string
  /** ai-sdk 厂商类型（deepseek / openai / openai-compatible），缺省时按 baseUrl 自动识别。 */
  vendor?: string
  baseUrl?: string
  model?: string
  displayName?: string
  apiKeyEnv?: string
  isDefault?: boolean
}

/**
 * 读取全部 OpenAI-Compatible 配置。
 * - 新格式 `modelProfiles`：JSON 数组 `[{ id, provider, vendor, baseUrl, model, displayName, isDefault }]`；
 * - 兼容旧格式 `modelProfile`：单个对象 → 视为单元素列表（惰性迁移，首次保存 modelProfiles 后旧值废弃）。
 */
function readOpenAIProfiles(): ModelProfile[] {
  const raw = store.getSetting('modelProfiles')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is ModelProfile =>
            Boolean(item) && typeof item === 'object' && typeof (item as ModelProfile).baseUrl === 'string'
        )
      }
    } catch {
      /* 忽略脏数据，走旧格式兼容 */
    }
  }
  const legacy = store.getSetting('modelProfile')
  if (legacy) {
    try {
      const profile = JSON.parse(legacy) as ModelProfile
      if (profile.baseUrl && profile.model) return [{ ...profile, isDefault: true }]
    } catch {
      /* 忽略历史脏数据 */
    }
  }
  return []
}

/** 系统级调用使用的默认 OpenAI 配置：显式 isDefault 优先，否则取第一个。 */
function defaultOpenAIProfile(): ModelProfile | undefined {
  const profiles = readOpenAIProfiles()
  if (profiles.length === 0) return undefined
  return profiles.find((profile) => profile.isDefault) ?? profiles[0]
}

/**
 * 取某个 profile 的 API Key（apiKeyEnv 优先，其次 keyStore）。
 * 读取顺序：`modelApiKey:<id>` → （默认或历史无 id 配置）`modelApiKey` 兼容回退。
 * 这样切换默认 profile 时无需迁移 key —— key 始终跟 profile id 走。
 */
function openAIApiKeyFor(profile: ModelProfile): string | undefined {
  if (profile.apiKeyEnv && process.env[profile.apiKeyEnv]) return process.env[profile.apiKeyEnv]
  if (profile.id) {
    const scoped = protectedValue(`modelApiKey:${profile.id}`)
    if (scoped) return scoped
  }
  if (profile.isDefault || !profile.id) return protectedValue('modelApiKey')
  return undefined
}
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
  // 全量替换：不再写 events 表（看板执行 Tab 改读任务 trace span 树，见 getTaskEvents）。
  // 保留 live 通知驱动前端刷新。
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
  // 任务进入终态:释放该任务常驻的 Qoder 会话(qodercli 进程),避免悬挂到应用退出。
  // Trace 收尾由 store.updateTask 包装统一处理（覆盖 workflow/completer/merge-refresher 等全部路径）。
  if (['failed', 'completed', 'cancelled'].includes(state)) {
    qoderTaskAgent?.closeSession(task.id)
  }
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

/**
 * 系统级 provider 兜底：Qoder 优先 —— 配置了 Qoder Token 即默认走 Qoder，
 * 仅当 Qoder 未配置时才落到 OpenAI（与模型选择器默认值规则一致）。
 */
function modelProvider(): 'qoder' | 'openai' {
  return protectedValue('qoderToken') ? 'qoder' : 'openai'
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
 * piSession 路径的完整 prompt 组装：Agent 指引段在最前，最后任务正文。
 * 不注入记忆上下文（不调 taskMemoryContext）：pi 路径每次 startPi 都重建全新会话，
 * 且每次开辟的可能是新任务——记忆检索/关键词提取的收益有限、成本却是一次 LLM 调用，
 * 故省去（Qoder 路径有常驻会话与 keyword 阶段容器，按每任务首次提取注入）。
 */
async function buildAgentPrompt(task: Task, body: string): Promise<string> {
  const repos = store.listTaskRepositories(task.id)
  const sections = (await agentService.resolveAgentContext(task, repos)).sections
  if (sections.length)
    addTaskEvent({ taskId: task.id, kind: 'status', title: '注入 Agent 上下文', detail: sections.join('\n\n') })
  return `${sections.length ? `${sections.join('\n\n')}\n\n` : ''}${body}`
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
 * 交付确认点（commit / push / 建 MR）。
 *
 * 默认"常规可行"：不弹确认框直接放行（保持任务自动提交的流畅性）。
 * 系统设置 `deliveryConfirm=true` 时开启逐步骤确认——用户拒绝则 DeliveryService
 * 不执行该步骤并退到 awaiting_commit，确认请求与结果写入 Approval 表。
 *
 * 该 approver 始终接在 DeliveryService 上（不拆掉），设置开关切换行为，
 * 为后续任务执行模式改造（并行任务归属、逐任务确认策略等）保留扩展点。
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
  // 默认不确认（常规可行）；仅在设置开启时逐步骤弹窗。
  if (store.getSetting('deliveryConfirm') !== 'true') return true
  const label = deliveryStepLabels[kind]
  const approval = store.addApproval({ taskId: task.id, kind, context })
  // 消息带任务标题与仓库信息，避免并行任务时混淆确认归属。
  const ok =
    (await requestUi<boolean>(
      'confirm',
      { title: `确认${label}：${task.title}`, message: `${task.title}\n\n${context}`, taskId: task.id },
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

// 埋点管线：span 写入（脱敏/预计算/持久化）+ live 推送（前端实时刷新）。
const tracePipeline = new TracePipeline(new JsonlTraceStorage(dataDir), (event) => sendTaskEvent(event))
/** taskId → Pi 任务 span 转换器（OpenAI 任务路径）。 */
const piTraceBuilders = new Map<string, PiTraceBuilder>()
/** chatId → 对话回合 traceId（对话级：一个对话 = 一个 Trace，跨回合重开续接）。 */
const chatTurnTraceIds = new Map<string, string>()
/** chatId → 回合隔离序号（beginTurn 递增，endTurn 据此判断自己是否仍是最新回合）。 */
const chatTurnSeq = new Map<string, number>()
/** turnKey（`${chatId}:${seq}`）→ 当前阶段容器 agent.run span（keyword/chat/memory，endStage 收尾）。 */
const chatStageSpans = new Map<string, AgentSpan>()
/** chatId → 本回合 driver source（阶段容器 meta.source 用，与任务路径阶段同构）。 */
const chatStageSources = new Map<string, 'qoder' | 'openai'>()
/** 对话阶段 phase → 阶段名（与 stage-label 的 agentStageLabel 映射保持一致）。 */
const chatStageNames: Record<'keyword' | 'chat' | 'memory', string> = {
  keyword: '关键词提取并注入',
  chat: '对话生成',
  memory: '记忆整理'
}
/** 对话回合 trace 管理器：注入 ChatService，回合 begin/end + 辅助 LLM 调用 join。 */
const chatTraceManager: ChatTraceManager = {
  beginTurn(chatId, messageId, text, driverId, model, extras) {
    // 对话级 trace：同一对话的所有回合共用一个 traceId。回合之间靠 beginTrace 的
    // 「重开恢复」机制续接（seq 水位、历史根复用、摘要累计），一个 Trace 里显示多条
    // 「对话生成」记录，而不是每回合一条孤立 trace。跨模型切换（qoder/openai）也
    // 续接同一 trace，只更新 source/agentName 归属。
    // turnKey 是回合隔离令牌（per-chat 递增序号）：endTurn / 阶段容器按它识别
    // 「自己回合」，被新回合接管（连发/打断）时不会误关新回合的 trace 或误收其阶段。
    const traceId = `chat-${chatId}`
    const seq = (chatTurnSeq.get(chatId) ?? 0) + 1
    chatTurnSeq.set(chatId, seq)
    const turnKey = `${chatId}:${seq}`
    tracePipeline.ensureActive({
      traceId,
      kind: 'chat',
      title: text.slice(0, 80),
      source: driverId === 'qoder' ? 'qoder' : 'openai',
      agentName: driverId === 'qoder' ? 'Qoder' : 'OpenAI',
      model
    })
    // ensureRootSpan：重开回合复用历史 session.start 根，执行树跨回合不断裂。
    // 本回合 MCP / Agent 选择态写入根 meta（PayloadInspector 按 meta 展示，自然可见）。
    tracePipeline.ensureRootSpan(traceId, {
      type: 'session.start',
      name: '对话',
      meta: {
        source: driverId,
        ...(extras?.mcpServices?.length ? { mcpServices: extras.mcpServices } : {}),
        ...(extras?.agentId ? { agentId: extras.agentId } : {})
      }
    })
    chatTurnTraceIds.set(chatId, traceId)
    chatStageSources.set(chatId, driverId === 'qoder' ? 'qoder' : 'openai')
    return { traceId, turnKey }
  },
  endTurn(chatId, turnKey) {
    if (!turnKey) return
    // 只收尾自己回合的阶段容器（stage 按 turnKey 隔离，不误收新回合的）。
    const stage = chatStageSpans.get(turnKey)
    if (stage) {
      chatStageSpans.delete(turnKey)
      try {
        tracePipeline.endSpan(stage.traceId, stage)
      } catch {
        /* trace 已结束时忽略 */
      }
    }
    // 仅当自己仍是该对话的当前回合（序号最新）才 endTrace：被新回合接管（连发/打断）时，
    // 对话级 trace 由最新回合的 endTurn 统一 finalize —— 数据不丢、不被提前截断。
    const mySeq = Number(turnKey.slice(turnKey.lastIndexOf(':') + 1))
    if (chatTurnSeq.get(chatId) === mySeq) {
      const traceId = chatTurnTraceIds.get(chatId)
      if (traceId) {
        tracePipeline.endTrace(traceId)
        chatTurnTraceIds.delete(chatId)
        chatStageSources.delete(chatId)
      }
    }
  },
  traceIdForChat(chatId) {
    return chatTurnTraceIds.get(chatId)
  },
  beginStage(chatId, phase, turnKey) {
    const traceId = chatTurnTraceIds.get(chatId)
    if (!turnKey || !traceId || !tracePipeline.isActive(traceId)) return
    // 与任务路径阶段容器同构：agent.run + meta.phase，期间的 span 按栈自动挂入。
    const span = tracePipeline.startSpan(traceId, {
      type: 'agent.run',
      name: chatStageNames[phase],
      meta: { source: chatStageSources.get(chatId) ?? 'openai', phase }
    })
    chatStageSpans.set(turnKey, span)
  },
  endStage(chatId, turnKey, status) {
    const span = turnKey ? chatStageSpans.get(turnKey) : undefined
    if (turnKey) chatStageSpans.delete(turnKey)
    if (!turnKey || !span || !tracePipeline.isActive(span.traceId)) return
    tracePipeline.endSpan(
      span.traceId,
      span,
      status === 'error' ? { status: 'error', error: { message: '阶段执行失败' } } : undefined
    )
  }
}

// Chat driver registry — 统一装 Qoder / OpenAI 两份 driver；后续接入更多 driver 仅需改此处。
// MCP 配置唯一真相：dataDir/mcp.json（内置 gitlab/jira/confluence + 自定义，见 chat/mcp-config.ts）。
const mcpConfigPath = join(dataDir, 'mcp.json')
// MCP 服务解析器：每次调用实时读 mcp.json（配置修改立即生效）；凭据复用 store + protectedValue。
const chatMcpResolver = createMcpServiceResolver(() => loadMcpServers(mcpConfigPath), {
  getSetting: (key) => store.getSetting(key),
  getSecret: (key) => protectedValue(key)
})
// 对话注入用的技能正文解析器（OpenAI driver：选中技能拼进 system；读 dataDir/skills/<name>/SKILL.md）。
const resolveSkillContent = (names: string[]): string | undefined => {
  const parts = names.map((name) => readSkillContent(skillsRoot, name)).filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join('\n\n') : undefined
}
const chatDriverRegistry = new ChatDriverRegistry()
chatDriverRegistry.register(
  new QoderChatDriver(
    () => protectedValue('qoderToken'),
    getQoderStatus,
    tracePipeline,
    chatMcpResolver,
    // 工具调用 HITL：Qoder CLI 需要用户决策时弹 UI 确认(不自动 allow，用户显式同意才执行)。
    // - MCP 工具(mcp__*，如 jira/gitlab/confluence)：仅写操作(create/update/delete/move 等)弹窗确认，
    //   读操作(get/search/list 等)直接放行 —— 用户勾选的外部服务访问中，只有修改类操作需要把关；
    // - 内置工具沿用任务板块策略：仅删除/移动等危险操作弹窗，其余放行(避免对话频繁打断)。
    async (toolName, toolInput, { signal, conversationId, title, displayName, description }) => {
      const needsConfirm = toolName.startsWith('mcp__') ? isWriteTool(toolName) : isDangerousTool(toolName, toolInput)
      if (!needsConfirm) return 'allow'
      // 弹窗文案截断：避免 Write/Edit 等工具把整段文件内容塞进确认框（敏感内容不落地 UI）。
      const detail = describeToolAction(toolName, toolInput)
      const trimmed = detail.length > 500 ? `${detail.slice(0, 500)}…(已截断)` : detail
      // description 是 SDK 提供的工具用途说明(如"创建 Jira Issue")，放正文首行；具体入参随后。
      const descLine = description ? (description.length > 300 ? `${description.slice(0, 300)}…` : description) : ''
      const lines = [descLine, conversationId ? `对话 ${conversationId}` : '', trimmed].filter(Boolean)
      const ok =
        (await requestUi<boolean>(
          'confirm',
          {
            title: `允许执行 ${prettyToolName(displayName ?? title ?? toolName)}?`,
            message: lines.join('\n\n'),
            conversationId
          },
          { timeout: 10 * 60_000, signal } // 会话中止/超时默认拒绝（安全兜底）
        )) ?? false
      return ok ? 'allow' : 'deny'
    },
    // 选中 Skill 时切 QODER_CONFIG_DIR 指向 dataDir（其下 skills/ 即 CLI 技能根，实测定案）。
    dataDir
  )
)
chatDriverRegistry.register(
  new OpenAIChatDriver(
    store,
    (profile) => {
      if (profile?.id) {
        const scoped = protectedValue(`modelApiKey:${profile.id}`)
        if (scoped) return scoped
      }
      if (profile?.isDefault || !profile?.id) return protectedValue('modelApiKey')
      return undefined
    },
    tracePipeline,
    chatMcpResolver,
    resolveSkillContent
  )
)

/**
 * 生产环境下的关键词改写器：按当前 system model 选 driver，调 LLM 提取。
 * driver 不可用 / 抽错时由 MemoryService.resolveKeywords 内部走 fallbackKeywords 兑底，
 * 不会拖垃检索链路。任务上下文 / 会话上下文 / dev probe 共用这一个实例。
 *
 * 模型选择：关键词提取只是几行 JSON，Qoder 走 lite 模型节省 credits，
 * OpenAI 跟随用户配置的 modelProfile（`<厂商前缀>:<model>`）。
 */
const keywordRewriter: KeywordRewriter = (query) => keywordRewriterWithTrace(query)

/**
 * 带 trace 归属的关键词提取：辅助 LLM 调用显式 join 所属回合/任务 trace
 * （一次用户提问 = 一个 Trace），避免关键词提取产生独立 trace 记录。
 * 传 task 时模型驱动跟随任务 runtime provider（Qoder 任务走 qoder-lite，不跟全局 OpenAI profile）。
 */
async function keywordRewriterWithTrace(query: string, traceId?: string, task?: Task): Promise<string[]> {
  const { driverId } = await resolveTaskChatModel(task)
  const driver = chatDriverRegistry.tryGet(driverId)
  if (!driver) return []
  const model = await resolveLiteModel(driverId)
  return extractKeywords({ driver, driverId, model, text: query, traceId })
}

/**
 * 轻量任务的模型选择策略（关键词提取 / MR 描述生成等短输出场景共用）：
 * - Qoder: 从 getQoderStatus() 拉模型列表，直接找名字含 lite 的免费模型；
 *   找不到或 Qoder 未连接时回落到系统 defaultModel。
 * - OpenAI: 跟随用户配置的 modelProfile（`<厂商前缀>:<model>` 形态）。
 */
async function resolveLiteModel(driverId: ChatDriverId): Promise<string> {
  if (driverId === 'qoder') {
    try {
      const status = await getQoderStatus()
      const enabled = status.models.filter((m) => m.isEnabled !== false)
      // 轻量任务直接用 lite 免费模型：Qoder 无 credit 时可用列表只剩 lite，
      // 直接按名字找（不做 lite/haiku/flash/mini 多词匹配，避免 MiniMax 等误命中）。
      const free = enabled.find((m) => {
        const name = `${m.value} ${m.displayName ?? ''}`.toLowerCase()
        return m.priceFactor === 0 || name.includes('lite')
      })
      if (free?.value) return free.value
      // 没有 lite 模型时回落 Qoder 默认模型（isDefault 优先），避免硬编码。
      const pick = enabled.find((m) => m.isDefault) ?? enabled[0]
      if (pick?.value) return pick.value
    } catch {
      /* 静默回落到默认 */
    }
    const legacy = store.getSetting('defaultModel')
    if (legacy) return legacy
    // 兜底跟随系统默认解析（Qoder 段返回 `qoder:<model>`，这里去前缀保持裸模型形态）。
    const system = syncSystemDefaultModel()
    if (system?.provider === 'qoder') return system.model.replace(/^qoder:/, '')
    return 'claude-sonnet-4.5'
  }
  return resolveOpenAIModelValue()
}

/** 去掉 model value 上的 `<厂商前缀>:`（deepseek: / openai: / openai-compatible:），让 /chat/completions 能识别真实模型名。 */
function stripOpenAIModelPrefix(model: string | undefined): string | undefined {
  if (!model) return undefined
  return isOpenAIModelValue(model) ? stripModelPrefix(model) : model
}

/**
 * OpenAI 兼容模型当前的 value 形态：`<厂商前缀>:<model>`（前缀 = profile.vendor）。
 * 关键词提取 / 记忆整理等轻量 LLM 调用统一用它 —— 之前这里固定回退到
 * `defaultOpenAIModel ?? 'gpt-4o'`，与用户实际选择的模型脱节，且 `gpt-4o` 不是
 * 带前缀的 value，OpenAIChatDriver 会直接拒绝（关键词提取永远走不到 LLM）。
 * 多个配置时取默认 profile（isDefault 优先，否则第一个）。
 * 未配置时返回兼容占位 `openai:default`（driver 内部映射到 profile.model）。
 */
function resolveOpenAIModelValue(): string {
  const profile = defaultOpenAIProfile()
  if (profile?.model) return `${prefixOfVendor(profile.vendor ?? detectVendor(profile.baseUrl))}:${profile.model}`
  return 'openai:default'
}

/**
 * 系统默认模型（同步版，基于 Qoder 状态探测缓存）：
 *  - Qoder 已连接且有模型 → 取 isDefault 模型（否则第一个），value 形如 `qoder:<model>`；
 *  - 否则 OpenAI profiles 非空 → 取默认 profile，value 形如 `<厂商前缀>:<model>`；
 *  - 都没有 → undefined。
 * 缓存尚未建立（启动后未探测过）时 Qoder 段跳过，不误判；
 * AgentService / 任务路径的运行时回填用它，默认变更后自动跟随（不落盘）。
 */
function syncSystemDefaultModel(): { provider: 'qoder' | 'openai'; model: string } | undefined {
  const status = qoderStatusCache?.status
  if (status && status.enabled && status.connected && status.models.length > 0) {
    const enabled = status.models.filter((m) => m.isEnabled !== false)
    // Qoder 组内规则：isDefault → lite（priceFactor===0 或名字含 lite/haiku/flash/mini）→ 第一个。
    // Qoder 无 credit 时可用列表只剩免费模型，回落稳定落在 lite，不依赖列表顺序。
    const pick =
      enabled.find((m) => m.isDefault) ??
      enabled.find((m) => m.priceFactor === 0 || LITE_MODEL_PATTERN.test(`${m.value} ${m.displayName ?? ''}`)) ??
      enabled[0]
    if (pick?.value) return { provider: 'qoder', model: `qoder:${pick.value}` }
  }
  const profile = defaultOpenAIProfile()
  if (profile?.model)
    return {
      provider: 'openai',
      model: `${prefixOfVendor(profile.vendor ?? detectVendor(profile.baseUrl))}:${profile.model}`
    }
  return undefined
}

/**
 * 模型 value 存在性校验（对话/任务/Agent 存储值的失效判定）。
 * - OpenAI 兼容组（`<厂商前缀>:<model>[@id]`，含历史 `openai:` 前缀）：按当前 profiles 匹配；
 *   无任何 profile 时视为失效；`openai:default` 历史占位恒有效（只要存在 profile）；
 * - Qoder 模型：按最近一次状态探测的模型列表匹配；缓存未建立时不校验（避免启动早期误判失效）。
 */
function isModelValueAvailable(model: string): boolean {
  if (isOpenAIModelValue(model)) {
    const profiles = readOpenAIProfiles().filter((p) => p.baseUrl && p.model)
    if (profiles.length === 0) return false
    if (model === 'openai:default') return true
    return profiles.some((p) => {
      const prefixed = `${prefixOfVendor(p.vendor ?? detectVendor(p.baseUrl))}:${p.model}`
      return prefixed === model || (p.id ? `${prefixed}@${p.id}` === model : false)
    })
  }
  const status = qoderStatusCache?.status
  if (!status) return true
  if (!status.enabled || !status.connected) return false
  const raw = model.startsWith('qoder:') ? model.slice('qoder:'.length) : model
  return status.models.some((m) => m.value === raw)
}

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
  async ({ conversationId, query }) => {
    // 关键词提取 join 当前对话回合（若在回合内），避免产生独立 trace。
    const turnTraceId = chatTraceManager.traceIdForChat(conversationId)
    const result = await memoryService.search({
      userId: memoryService.ensureUserId(),
      conversationId,
      query,
      keywordRewriter: (q) => keywordRewriterWithTrace(q, turnTraceId)
    })
    // 记忆 / Repowiki 检索结果落 span（keyword 阶段容器窗口内，自动挂入阶段）：
    // input=实际检索关键词，output=命中摘要 —— 此前检索无埋点，Trace 里看不到搜索结果。
    if (turnTraceId && tracePipeline.isActive(turnTraceId)) {
      const span = tracePipeline.startSpan(turnTraceId, {
        type: 'tool.execute',
        name: '记忆与 Repowiki 检索',
        input: { query, keywords: result.keywords }
      })
      tracePipeline.endSpan(turnTraceId, span, {
        output: {
          memories: result.memories.map((m) => ({
            scope: m.scope,
            title: m.title,
            snippet: m.content.slice(0, 200)
          })),
          wikiDocs: result.wikiDocs.map((doc) => ({
            path: doc.path,
            title: doc.title,
            snippet: doc.content.slice(0, 200)
          }))
        }
      })
    }
    return renderMemoryContext(result.memories, result.wikiDocs)
  },
  consolidateChatMemory,
  chatTraceManager
)

// Trace 服务 v2：新 trace 管道查询（Trace 页面数据源）。埋点/写入见 electron/trace/（Bus + 两路适配器）。
const traceService = new TraceService(dataDir)

/**
 * 孤儿 trace 启动收口：应用崩溃/强杀会留下只有 events、没有 info 摘要的 trace，
 * 列表页永远显示「进行中」。启动时扫描 events/：mtime 超过阈值（10 分钟，进行中的
 * 任务/对话仍在写文件不会命中）且不在活跃 pipeline → 按全量快照 finalize 为
 * 「已结束 + interrupted」。kind 从根 span 类型推断；title 无法从 events 复原
 * （ctx 只在内存），退化为 traceId —— 后续同 traceId 恢复执行时会以真实 ctx 重写摘要。
 */
function sweepInterruptedTraces(): void {
  const ORPHAN_STALE_MS = 10 * 60_000
  const storage = new JsonlTraceStorage(dataDir)
  let names: string[] = []
  try {
    names = readdirSync(traceEventsDir(dataDir)).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    const traceId = name.replace(/\.jsonl$/, '')
    try {
      if (existsSync(traceInfoFile(dataDir, traceId))) continue
      if (tracePipeline.isActive(traceId)) continue
      if (now - statSync(join(traceEventsDir(dataDir), name)).mtimeMs < ORPHAN_STALE_MS) continue
      const spans = storage.loadSpans(traceId)
      if (!spans?.length) continue
      const root = spans.find((span) => span.type === 'task.run' || span.type === 'session.start')
      const summary = summarizeTrace(traceId, root?.type === 'session.start' ? 'chat' : 'task', traceId, spans)
      storage.finalize(traceId, { ...summary, interrupted: true })
    } catch {
      /* 单个文件收口失败不影响其它 */
    }
  }
}

// Task agent driver — 负责"任务执行"路径(plan / implementation / test_generation)。
// 当前只注册 Qoder；接口已经摆好，后续接入其它 agent 运行时仅需 add() 一行。
function createQoderTaskAgent(): QoderTaskAgentDriver {
  return new QoderTaskAgentDriver({
    store,
    qoderTokenProvider: () => protectedValue('qoderToken'),
    dataDir,
    addTaskEvent,
    emitPi,
    tracePipeline,
    emit: (event) => {
      // TaskAgentEvent 透传给 UI 通道(以及失败后续接 session id 持久化)。
      if (event.type === 'agent_session') {
        // 优先用事件自带的 taskId,不依赖全局 activeTaskId(任务串行切换/并发时避免写错任务)。
        const taskId = event.taskId || activeTaskId
        if (taskId) store.updateTask(taskId, { qoderSessionId: event.sessionId })
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
    // 工具调用 HITL：仅删除/重命名/移动等破坏性操作弹确认；其余默认放行（常规可行）。
    onPermissionRequest: async (taskId, toolName, toolInput, signal) => {
      if (!isDangerousTool(toolName, toolInput)) return 'allow'
      const detail = describeToolAction(toolName, toolInput)
      const task = store.getTask(taskId)
      const approval = store.addApproval({ taskId, kind: 'permission', context: detail })
      addTaskEvent({ taskId, kind: 'permission', title: `请求执行破坏性操作:${toolName}`, detail })
      // 消息带任务标题，并行任务时确认框归属清晰。
      const ok =
        (await requestUi<boolean>(
          'confirm',
          { title: `允许执行 ${toolName}?`, message: `${task?.title ?? ''}\n\n${detail}`, taskId },
          { timeout: 10 * 60_000, signal } // 会话中止/超时默认拒绝（安全兜底）
        )) ?? false
      store.resolveApproval(approval.id, ok ? 'approved' : 'rejected')
      return ok ? 'allow' : 'deny'
    }
  })
}

// 任务 agent 单例:内部持有按 taskId 常驻的 Qoder 会话注册表,
// plan / implementation / test_generation 三阶段共享同一会话(多轮执行引擎)。
const qoderTaskAgent = createQoderTaskAgent()

// === Review 实现(Qoder / OpenAI 兼容) =========================================

async function callQoderReviewer(
  prompt: string,
  taskId: string,
  model?: string,
  signal?: AbortSignal,
  onMessage?: (message: unknown) => void
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
      // 非流式 query 默认只发全量 assistant 消息（llm span 在消息到达时才创建即结束，
      // 时序失真为 0~1ms）；开启流式增量让 trace 从首个 stream delta 开始计时。
      includePartialMessages: true,
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
          // review 阶段 trace：消息透传给调用方的 QoderTraceBuilder（CodeReview 容器内产 llm/tool span）。
          onMessage?.(message)
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
 * 工作流阶段容器 span（review 等由 main.ts 工作流驱动的独立阶段）：
 * 确保任务 trace 活跃（begin 幂等 + ensureRootSpan 复用历史根），再开 agent.run 阶段 span。
 * 返回 undefined 表示 trace 不可用（任务不存在），调用方退化为无埋点执行。
 */
function startTaskStageSpan(
  task: Task | undefined,
  taskId: string,
  name: string,
  phase: string
): AgentSpan | undefined {
  if (!task) return undefined
  try {
    const source = providerForTask(taskId) === 'qoder' ? 'qoder' : 'pi'
    tracePipeline.beginTrace({
      traceId: taskId,
      kind: 'task',
      title: task.title,
      source,
      ...(task.qoderModel ? { model: stripQoderModelPrefix(task.qoderModel) } : {})
    })
    tracePipeline.ensureRootSpan(taskId, { type: 'task.run', name: '任务执行', meta: { source } })
    return tracePipeline.startSpan(taskId, { type: 'agent.run', name, meta: { source, phase } })
  } catch {
    return undefined
  }
}

/** OpenAI reviewer：HTTP 一次性调用无 SDK 事件流，手建 llm span（input=review prompt，output=review 结果，usage 取响应）。 */
async function runOpenAIReviewWithSpan(
  input: Parameters<OpenAICompatReviewer['call']>[0],
  taskId: string,
  model: string | undefined,
  signal: AbortSignal | undefined,
  prompt: string,
  stage: AgentSpan | undefined
): Promise<string> {
  const modelName = stripOpenAIModelPrefix(model)
  const llmSpan = stage
    ? tracePipeline.startSpan(taskId, {
        type: 'llm.generate',
        name: modelName ?? 'OpenAI Review',
        ...(modelName ? { model: modelName } : {}),
        input: prompt,
        meta: { source: 'pi' }
      })
    : undefined
  let usage: AgentSpanUsage | undefined
  try {
    const text = await openAIReviewer.call(input, taskId, modelName, signal, prompt, (u) => {
      usage = u
    })
    if (llmSpan) tracePipeline.endSpan(taskId, llmSpan, { output: text, ...(usage ? { usage } : {}) })
    return text
  } catch (error) {
    if (llmSpan) {
      tracePipeline.endSpan(taskId, llmSpan, {
        status: 'error',
        error: { message: error instanceof Error ? error.message : String(error) }
      })
    }
    throw error
  } finally {
    if (stage) {
      try {
        tracePipeline.endSpan(taskId, stage)
      } catch {
        /* trace 收尾失败不影响 review */
      }
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
  // review 阶段容器：CodeReview 进入任务阶段链（关键词提取→Plan→Exec→CodeReview→…），
  // per repo 调用在容器内产 llm/tool span（此前 review 完全没接 trace，阶段链数据缺失）。
  const stage = startTaskStageSpan(task, taskId, 'CodeReview', 'review')
  if (providerForTask(taskId) !== 'qoder') return runOpenAIReviewWithSpan(input, taskId, model, signal, prompt, stage)
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
  // Qoder reviewer：SDK 消息流经 QoderTraceBuilder 转成 llm/tool span（挂栈顶落入 review 容器）。
  const builder = stage
    ? new QoderTraceBuilder(tracePipeline, taskId, 'task', 'qoder', stripQoderModelPrefix(model))
    : undefined
  const onMessage = builder
    ? (message: unknown) => {
        try {
          builder.onMessage(message as never)
        } catch {
          /* trace 采集失败不影响 review */
        }
      }
    : undefined
  return callQoderReviewer(finalPrompt, taskId, model, signal, onMessage).finally(() => {
    try {
      builder?.finish()
    } catch {
      /* ignore */
    }
    if (stage) {
      try {
        tracePipeline.endSpan(taskId, stage)
      } catch {
        /* trace 收尾失败不影响 review */
      }
    }
  })
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
  options: { additionalDirectories?: string[]; signal?: AbortSignal; onMessage?: (message: unknown) => void } = {}
): Promise<string> {
  const { additionalDirectories = [], signal, onMessage } = options
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
      // 同 callQoderReviewer：开启流式增量让 trace 从首个 stream delta 开始计时（时序真实化）。
      includePartialMessages: true,
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
          onMessage?.(message)
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
  const profile = defaultOpenAIProfile()
  if (!profile) throw new Error('未配置 OpenAI-Compatible 模型')
  if (!profile.baseUrl || !profile.model) throw new Error('默认 OpenAI 配置缺少 baseUrl 或 model')
  const apiKey = openAIApiKeyFor(profile)
  if (!apiKey) throw new Error('未配置默认 OpenAI 配置的 API Key')
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
        model: stripOpenAIModelPrefix(model) ?? profile.model,
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
    // OpenAI 路径跟随：preferredModel 未配置时 callOpenAIForPrompt 内部回落系统 modelProfile.model。
    // preferredModel 是 `<厂商前缀>:<model>` 形态的 value，需剥离前缀再传给 /chat/completions。
    return callOpenAIForPrompt(prompt, taskId, stripOpenAIModelPrefix(roleAgent.preferredModel), signal)
  }
  // MR 描述生成只是短文本 JSON 输出，Qoder 走 lite 模型节省 credits（与关键词提取同策略）；
  // 其它操作（review / test）仍尊重角色 Agent 的 preferredModel。
  const model = operation === 'mr' ? await resolveLiteModel('qoder') : roleAgent.preferredModel
  return callQoderReviewer(prompt, taskId, model, signal)
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
  resumeSessionId?: string,
  /** 阶段 span 标记：trigger=恢复/续接来源，round=auto-fix 重跑轮次（渲染层区分 Exec/ReExec/续接）。 */
  traceMark?: { trigger?: 'resume' | 'followup'; round?: number }
): Promise<void> {
  const task = await taskWorkflow.prepare(taskId, signal)
  const repos = store.listTaskRepositories(task.id)
  if (repos.length === 0) throw new Error('任务未关联代码仓库')
  activeTaskId = task.id
  signal?.throwIfAborted()
  addTaskEvent({
    taskId,
    kind: 'status',
    title: '执行环境:Qoder Agent SDK',
    detail: '使用应用随附运行时,并在已配置仓库目录中执行'
  })
  try {
    await qoderTaskAgent.runImplementation({
      task,
      repos,
      signal,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(extraPrompt ? { extraPrompt } : {}),
      ...(traceMark?.trigger ? { trigger: traceMark.trigger } : {}),
      ...(traceMark?.round !== undefined ? { round: traceMark.round } : {})
    })
    const { responseTexts } = qoderTaskAgent.collectResult(taskId, 'implementation')
    await finishImplementation(task.id, responseTexts, signal)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const current = store.getTask(task.id)
    // 用户主动暂停（pauseTask）导致的中断不算执行失败：只保留 paused 状态，不写 error 事件。
    if (current?.state === 'paused') return
    addTaskEvent({ taskId, kind: 'error', title: 'Qoder 执行失败', detail })
    if (['implementing', 'validating'].includes(current?.state ?? '')) updateState(current!, 'failed')
    emitPi({ type: 'agent_error', taskId, message: detail })
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
  signal?.throwIfAborted()
  await qoderTaskAgent.runTestGeneration({ task, repos, signal })
  const { responseTexts } = qoderTaskAgent.collectResult(taskId, 'test')
  return parseTestCaseGeneration(responseTexts)
}

async function runQoderPlan(
  taskId: string,
  feedback?: string,
  signal?: AbortSignal,
  /** 恢复标记：resumeTask 计划失败重跑 Plan 时传 'resume'（阶段 span meta.trigger）。 */
  trigger?: 'resume' | 'followup'
): Promise<void> {
  const task = store.getTask(taskId)
  if (!task || task.state !== 'planning') throw new Error('当前任务不能生成计划')
  const repos = store.listTaskRepositories(task.id)
  if (repos.length === 0) throw new Error('任务未关联代码仓库')

  activeTaskId = task.id
  activePlanningTaskId = task.id
  activePlanText = ''
  signal?.throwIfAborted()
  try {
    await qoderTaskAgent.runPlan({
      task,
      repos,
      signal,
      ...(feedback ? { feedback } : {}),
      ...(trigger ? { trigger } : {})
    })
    const { responseTexts } = qoderTaskAgent.collectResult(taskId, 'plan')
    await savePlanDecision(taskId, responseTexts)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    addTaskEvent({ taskId, kind: 'error', title: '计划生成失败', detail })
    qoderTaskAgent.interruptSession(taskId)
    const current = store.getTask(taskId)
    if (current?.state === 'planning') {
      store.updateTask(taskId, { failureStage: 'planning' })
      updateState(current, 'failed')
    }
    throw error
  } finally {
    activePlanningTaskId = undefined
  }
}

/**
 * OpenAI 路径的计划生成（与 runQoderPlan 对齐的失败语义）。
 *
 * pi 的模型流式错误（如 `Stream ended without finish_reason`、网络中断）**不会**让
 * `piSession.prompt()` 抛异常：pi-agent 会把失败包装成 stopReason=error 的 assistant
 * 消息并正常结束 turn。因此 prompt 返回后必须检查 planning 期间的错误事件
 * （emitPi 已写入 activePlanError）与 plan 文本，显式抛错，让调用方统一走
 * failPlanGeneration（写错误事件 + failureStage=planning + 状态置 failed），
 * 否则任务会静默卡在 planning。
 */
async function runOpenAIPlan(taskId: string, prompt: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  activePlanningTaskId = taskId
  activePlanText = ''
  activePlanError = undefined
  try {
    await startPi(taskId)
    if (!piSession) throw new Error('OpenAI agent session is unavailable')
    await piSession!.prompt(prompt, { source: 'rpc' })
    signal.throwIfAborted()
    const planError = activePlanError
    if (planError) throw new Error(planError)
    const plan = activePlanText.trim()
    if (!plan) throw new Error('Agent 未返回有效计划')
    await savePlanDecision(taskId, [plan])
  } finally {
    activePlanningTaskId = undefined
    activePlanError = undefined
  }
}

/**
 * OpenAI 路径计划生成失败的统一落点：错误事件 + failureStage=planning + 状态置 failed。
 * 用户主动停止/删除时 stopTaskOperations 已把状态置 failed，这里不再覆盖、不重复报错。
 */
function failPlanGeneration(taskId: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  const current = store.getTask(taskId)
  if (current?.state !== 'planning') return
  addTaskEvent({ taskId, kind: 'error', title: '计划生成失败', detail })
  store.updateTask(taskId, { failureStage: 'planning' })
  updateState(current, 'failed')
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
    await submitMergeRequestsWithCredentialWatch(taskId, signal)
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
    await runQoder(taskId, fixPrompt, signal, undefined, { round: used + 1 }).catch((error) =>
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
  // 登记在途 promise：任务终态收尾（finalizeTaskTrace）会等它完成再 endTrace，
  // 避免在途的整理 span 被强制收尾。
  const memoryPending = consolidateTaskMemory(taskId, responseTexts)
  taskMemoryPending.set(taskId, memoryPending)
  void memoryPending.then(() => {
    if (taskMemoryPending.get(taskId) === memoryPending) taskMemoryPending.delete(taskId)
  })
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

function syncPiModelConfig(): void {
  const profiles = readOpenAIProfiles()
  if (profiles.length === 0) return
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
  // 清理旧的 company-openai* provider（含已删除 profile 的残留），再写入当前配置；
  // 其它 provider（用户自装）保留不动。
  const providersNext: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(providers)) {
    if (key.startsWith('company-openai')) continue
    providersNext[key] = value
  }
  let wrote = false
  for (const profile of profiles) {
    if (!profile.baseUrl || !profile.model) continue
    // 每个 profile 一个唯一 provider key：有 id 用 `company-openai:<id>`，无 id（历史）用 `company-openai`。
    const providerKey = profile.id ? `company-openai:${profile.id}` : 'company-openai'
    // 计费：models.json 缺 cost 时 pi 按 0 计费（会话消耗面板成本恒 0）。按内置单价表注入；
    // pi 的 cost 单位是 USD / 1M tokens（单价表是 per 1K，×1000 换算）；
    // cacheRead/cacheWrite 无统一刊例，按行业惯例近似：cacheRead ≈ input × 0.1、cacheWrite ≈ input。
    const rate = lookupCostRate(profile.model)
    providersNext[providerKey] = {
      baseUrl: profile.baseUrl,
      api: 'openai-completions',
      apiKey: `$${profile.apiKeyEnv ?? 'OPENAI_API_KEY'}`,
      models: [
        {
          id: profile.model,
          name: profile.model,
          reasoning: true,
          input: ['text', 'image'],
          ...(rate
            ? {
                cost: {
                  input: rate.inputPer1k * 1000,
                  output: rate.outputPer1k * 1000,
                  cacheRead: rate.inputPer1k * 100,
                  cacheWrite: rate.inputPer1k * 1000
                }
              }
            : {}),
          contextWindow: 128000,
          maxTokens: 32768
        }
      ]
    }
    wrote = true
  }
  if (!wrote) return
  const next = { ...current, providers: providersNext }
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
  // pi 的流式错误（如 `Stream ended without finish_reason`）不会让 prompt() 抛异常：
  // agent 会生成 stopReason=error 的 assistant 消息并正常结束。planning 期间记录它，
  // 由 runOpenAIPlan 在 prompt 返回后读取并显式报错（错误后成功重试的消息会清掉标记）。
  if (activePlanningTaskId && record.type === 'message_end') {
    const message = record.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined
    if (message?.role === 'assistant') {
      if (message.stopReason === 'error') {
        activePlanError = message.errorMessage || '模型流式输出异常结束'
      } else if (activePlanError) {
        activePlanError = undefined
      }
    }
  }
  if (activePlanningTaskId) record.phase = 'planning'
  if (
    activeTaskId &&
    providerForTask(activeTaskId) === 'openai' &&
    ['message_end', 'agent_end'].includes(String(record.type))
  )
    updatePiUsage(activeTaskId)
  if (activeTaskId && record.type === 'tool_execution_end') emitTaskChanged(activeTaskId)
  // OpenAI 任务：Pi 事件 → 执行树 span（一次任务执行 = 一个 Trace）。
  if (
    activeTaskId &&
    providerForTask(activeTaskId) === 'openai' &&
    [
      'agent_start',
      'agent_end',
      'message_start',
      'message_update',
      'message_end',
      'tool_execution_start',
      'tool_execution_end'
    ].includes(String(record.type))
  ) {
    const taskId = activeTaskId
    if (!piTraceBuilders.has(taskId)) {
      const task = store.getTask(taskId)
      if (task) {
        tracePipeline.beginTrace({
          traceId: taskId,
          kind: 'task',
          title: task.title,
          source: 'pi',
          ...(task.qoderModel ? { model: task.qoderModel } : {})
        })
        // ensureRootSpan：任务恢复/续接（finalize 后 builder 被清、应用重启后内存标记丢失）
        // 重新走到这里时复用历史 task.run 根，不再向同一 JSONL 追加第二个根（Bug A）。
        tracePipeline.ensureRootSpan(taskId, { type: 'task.run', name: '任务执行', meta: { source: 'pi' } })
        piTraceBuilders.set(taskId, new PiTraceBuilder(tracePipeline, taskId, 'task'))
      }
    }
    try {
      piTraceBuilders.get(taskId)?.onEvent(record)
    } catch {
      /* 忽略:trace 采集失败不能影响任务 */
    }
  }
  // OpenAI 任务：Pi 事件已转执行树 span，不再写 openai_events 表。
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

/**
 * 工具名美化：`mcp__jira__create_issue` → `Jira: create_issue`。
 * 弹窗标题可读性(原始 mcp__ 前缀 + 下划线太机器味)。非 mcp__ 名原样返回。
 */
function prettyToolName(name: string): string {
  const match = /^mcp__([^_]+)__(.+)$/.exec(name)
  if (!match) return name
  const server = (match[1] ?? '').charAt(0).toUpperCase() + (match[1] ?? '').slice(1)
  return `${server}: ${match[2] ?? ''}`
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
  // 开发期依赖根 `node_modules/@task-pipeline/pi-package` 的符号链接，
  // 打包后依赖 `prepackage` 拷贝到 `apps/desktop/node_modules/@task-pipeline/pi-package`。
  // 使用 `require.resolve` 让两种布局都能解析到 `dist/index.js`。
  const require = createRequire(import.meta.url)
  const extension = require.resolve('@task-pipeline/pi-package')
  // 注意：不再加载 pi-trace-extension（已废弃）。trace 采集由自研埋点层完成（见 electron/trace/）。
  const additionalExtensionPaths = [extension]
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
  const profiles = readOpenAIProfiles()
  if (profiles.length > 0) {
    for (const profile of profiles) {
      const providerKey = profile.id ? `company-openai:${profile.id}` : 'company-openai'
      const apiKey = openAIApiKeyFor(profile)
      if (apiKey) await modelRuntime.setRuntimeApiKey(providerKey, apiKey)
    }
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
      try {
        await runTaskOperation(taskId, async (signal) => {
          signal.throwIfAborted()
          await runOpenAIPlan(
            taskId,
            await buildAgentPrompt(
              task,
              `你处于只读计划模式。禁止修改文件、安装依赖或运行会改变工作区的命令。最终只输出 JSON：代码已满足要求时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n${task.title}\n${task.description}`
            ),
            signal
          )
        })
      } catch (error) {
        failPlanGeneration(taskId, error)
        emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
      }
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
      void runTaskOperation(taskId, (signal) => runQoderPlan(taskId, undefined, signal, 'resume')).catch((error) =>
        emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
      )
      return
    }
    await runTaskOperation(taskId, async (signal) => {
      signal.throwIfAborted()
      await runOpenAIPlan(
        taskId,
        await buildAgentPrompt(
          task,
          `你处于只读计划模式。禁止修改文件、安装依赖或运行会改变工作区的命令。最终只输出 JSON：代码已满足要求时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n${task.title}\n${task.description}`
        ),
        signal
      )
    }).catch((error) => {
      failPlanGeneration(taskId, error)
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    })
    return
  }
  // 实现阶段失败:复用 prepare 的失败恢复路径(worktree 缺失时补建,已完整时直接回到 implementing,不重跑 setup 命令)。
  const task = await runTaskOperation(taskId, (signal) => taskWorkflow.prepare(taskId, signal))
  if (runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) =>
      runQoder(taskId, resumeImplementationInstruction, signal, task.qoderSessionId, { trigger: 'resume' })
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
    // 常驻会话:只中断当前回复、保留会话(上下文不丢),恢复时直接续跑,无需 resume。
    activeQoderAbort?.abort(new Error('任务已暂停'))
    qoderTaskAgent.interruptSession(taskId)
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
      runQoder(taskId, resumeImplementationInstruction, signal, task.qoderSessionId, { trigger: 'resume' })
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
  try {
    await runTaskOperation(taskId, async (signal) => {
      signal.throwIfAborted()
      await runOpenAIPlan(
        taskId,
        await buildAgentPrompt(
          task,
          `你处于只读计划模式。根据调整意见重新判断，禁止修改文件。最终只输出 JSON：无需修改时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n任务：${task.title}\n${task.description}\n\n上一版计划：\n${task.planContent ?? ''}\n\n调整意见：\n${feedback}`
        ),
        signal
      )
    })
  } catch (error) {
    failPlanGeneration(taskId, error)
    emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
  }
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
    void runTaskOperation(taskId, (signal) =>
      runQoder(taskId, message, signal, undefined, { trigger: 'followup' })
    ).catch((error) =>
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
  // 释放该任务常驻的 Qoder 会话(停止/删除都会走到这里;failed 分支 updateState 也会触发,幂等)。
  qoderTaskAgent.closeSession(taskId)

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
 * 用户主动结束任务（等待计划确认等非运行态场景）：
 * 先中止该任务一切进行中的操作并释放常驻会话，再把任务置为 cancelled（终态触发 Trace 收尾）。
 */
async function cancelTask(taskId: string): Promise<void> {
  const task = store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  if (['failed', 'completed', 'cancelled', 'await_merge'].includes(task.state)) {
    throw new Error('当前状态的任务不能结束')
  }
  await stopTaskOperations(taskId, false)
  const current = store.getTask(taskId)
  if (current && !['failed', 'completed', 'cancelled'].includes(current.state)) {
    updateState(current, 'cancelled')
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
  // 任务删除 → 同步删除任务 trace 文件（events/*.jsonl + info/*.json），
  // 避免 Trace 页面残留已删除任务的记录（进行中任务被删时尤其明显：
  // deleteTask 的 finalizeTaskTrace 会把 running trace 收尾成已完成摘要并写 info，
  // 不删文件的话列表会继续显示这条「已完成」trace）。
  // 顺序：先 finalize（收尾活跃态、写摘要）再删文件，避免 endTrace 重建摘要。
  await traceService.deleteTrace(taskId)
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
  const jiraConfigured = !!(desktopResolver.get('jiraBaseUrl') && desktopResolver.get('jiraApiToken'))
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

async function probeQoderStatus(): Promise<QoderStatus> {
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
    // qodercli 进程非 0 退出（常见 exit 42）时，SDK 抛 QoderCliProcessError，
    // 其 .stderr 字段是 qodercli 输出的尾部日志。只取 error.message 会丢掉
    // 真正原因，导致 UI 上「错误信息不全、不好判断」——与 task-agent / plan-mode
    // 的增强写法保持一致，把 stderr 尾部拼进 error 一并上报。
    const message =
      error instanceof QoderCliProcessError && error.stderr
        ? `${error.message}\n\nqodercli stderr (tail):\n${error.stderr.trim().slice(-2000)}`
        : error instanceof Error
          ? error.message
          : String(error)
    return {
      enabled: true,
      connected: false,
      running: Boolean(activeQoderQuery),
      models: [],
      error: message
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

// Qoder 探测并发去重 + 短效缓存：
// 多个调用方（UI 轮询 / 保存后刷新 / 凭据健康检查）同时触发时会各自拉起 qodercli 探针进程，
// 并发进程互相冲突曾导致 "Qoder CLI process exited with code 41" 误报已连接 Token 失效。
let qoderStatusInflight: Promise<QoderStatus> | null = null
let qoderStatusCache: { at: number; token: string; status: QoderStatus } | null = null

async function getQoderStatus(): Promise<QoderStatus> {
  const token = protectedValue('qoderToken')
  if (!token) {
    updateCredential('qoder', { status: 'skipped', message: '未配置', checkedAt: Date.now() })
    // Token 被清除（或尚未配置）：如果之前探测过且连接可用，通知渲染进程刷新模型列表。
    if (qoderStatusCache?.status && (qoderStatusCache.status.enabled || qoderStatusCache.status.connected))
      sendTaskEvent({ type: 'qoder_status_changed' })
    qoderStatusCache = {
      at: Date.now(),
      token: '',
      status: { enabled: false, connected: false, running: false, models: [] }
    }
    return { enabled: false, connected: false, running: false, models: [] }
  }
  if (qoderStatusInflight) return qoderStatusInflight
  qoderStatusInflight = probeQoderStatus().finally(() => {
    qoderStatusInflight = null
  })
  const status = await qoderStatusInflight
  // Qoder 连接/启用状态变化直接影响 listModels 结果（未连接时模型列表为空），
  // 广播给渲染进程刷新模型选择栏，避免用户看到的模型列表一直停留在空态。
  const prev = qoderStatusCache?.status
  if (prev && (prev.connected !== status.connected || prev.enabled !== status.enabled))
    sendTaskEvent({ type: 'qoder_status_changed' })
  qoderStatusCache = { at: Date.now(), token, status }
  // 回写全局凭据状态：UI 轮询 / 各处探测都会自动维持 qoder 项新鲜度。
  updateCredential(
    'qoder',
    status.connected
      ? { status: 'ok', message: undefined, checkedAt: Date.now() }
      : { status: 'failed', message: status.error ?? '连接失败', checkedAt: Date.now() }
  )
  return status
}

/** 凭据健康检查专用：同 Token 的 30s 内新鲜缓存直接复用（UI 刚探过），否则共享单次探针。 */
function getQoderStatusForHealth(): Promise<QoderStatus> {
  const token = protectedValue('qoderToken')
  if (qoderStatusCache && qoderStatusCache.token === token && Date.now() - qoderStatusCache.at < 30_000) {
    return Promise.resolve(qoderStatusCache.status)
  }
  return getQoderStatus()
}

// === 凭据全局状态(单一数据源，进入系统时逐项探测各配置 Token 是否已过期/失效) ==

type CredentialKey = 'qoder' | 'gitlab' | 'jira' | 'confluence'

/** 凭据全局状态条目：主进程维护的唯一数据源，变化时广播快照给渲染进程。 */
type CredentialState = {
  key: CredentialKey
  label: string
  /** unknown=未探测；checking=探测中；ok=连通可用；failed=Token 失效/连接失败；skipped=未配置。 */
  status: 'unknown' | 'checking' | 'ok' | 'failed' | 'skipped'
  message?: string
  checkedAt?: number
}

const CREDENTIAL_LABELS: Record<CredentialKey, string> = {
  qoder: 'Qoder Token',
  gitlab: 'GitLab Token',
  jira: 'Jira Token',
  confluence: 'Confluence Token'
}

const credentialStates = new Map<CredentialKey, CredentialState>(
  (Object.keys(CREDENTIAL_LABELS) as CredentialKey[]).map((key) => [
    key,
    { key, label: CREDENTIAL_LABELS[key], status: 'unknown' as const }
  ])
)

/** 凭据状态快照（固定顺序：qoder / gitlab / jira / confluence）。 */
function credentialStateSnapshot(): CredentialState[] {
  return (Object.keys(CREDENTIAL_LABELS) as CredentialKey[]).map((key) => ({ ...credentialStates.get(key)! }))
}

/** 合并更新一项凭据状态，并向渲染进程广播最新完整快照。 */
function updateCredential(
  key: CredentialKey,
  patch: Partial<Pick<CredentialState, 'status' | 'message' | 'checkedAt'>>
): void {
  const current = credentialStates.get(key)
  if (!current) return
  credentialStates.set(key, { ...current, ...patch })
  mainWindow?.webContents.send('credentials:state-changed', credentialStateSnapshot())
}

/** 运行时失败回写便捷入口（如提交 MR 时 GitLab 返回认证错误），无需等下一轮探测。 */
function markCredentialFailed(key: CredentialKey, message: string): void {
  updateCredential(key, { status: 'failed', message, checkedAt: Date.now() })
}

/** 提交 MR 并观察 GitLab 认证失败：Token 中途过期时立即把 gitlab 项标红。 */
async function submitMergeRequestsWithCredentialWatch(taskId: string, signal?: AbortSignal): Promise<void> {
  try {
    await deliveryService.submitMergeRequests(taskId, signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/401|403|unauthori[sz]ed|forbidden/i.test(message)) markCredentialFailed('gitlab', message)
    throw error
  }
}

/** Promise 超时包装：MCP 探测（uvx 冷启动）可能长时间挂起，需要兜底超时。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** GitLab Token 校验：优先用设置里配置的自建实例地址，其次从仓库 remoteUrl 推实例，最后回落 gitlab.com；调 /api/v4/user 验权。 */
async function checkGitLabCredential(token: string): Promise<Pick<CredentialState, 'status' | 'message'>> {
  const configured = store.getSetting('gitlabUrl')?.trim()
  const remote = store
    .listRepositoryProfiles()
    .map((profile) => (profile.remoteUrl ? parseGitLabRemote(profile.remoteUrl) : undefined))
    .find((parsed) => Boolean(parsed?.baseUrl))
  const baseUrl = (configured || remote?.baseUrl || 'https://gitlab.com').replace(/\/$/, '')
  try {
    const response = await fetch(`${baseUrl}/api/v4/user`, {
      headers: { 'PRIVATE-TOKEN': token },
      signal: AbortSignal.timeout(10_000)
    })
    if (response.ok) return { status: 'ok' }
    if (response.status === 401) return { status: 'failed', message: 'Token 无效或已过期（401），请在设置中重新配置' }
    if (response.status === 403) return { status: 'failed', message: 'Token 已被禁用或权限不足（403）' }
    return { status: 'failed', message: `校验失败：HTTP ${response.status}` }
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 通用 MCP 连接测试：按 id 解析出 profile（统一 mcp.json + 凭据注入），
 * 经 McpClient.listTools() 验证连通并返回工具列表。内置/自定义服务共用。
 */
async function testMcpConnectionById(id: string): Promise<{ ok: boolean; tools: string[]; message: string }> {
  const profile = chatMcpResolver(id)
  if (!profile) return { ok: false, tools: [], message: '未找到该服务，或未启用 / 凭据缺失' }
  const client = new McpClient(profile)
  try {
    // npx/uvx 冷启动可能需下载包，超时放宽到 30s（与 McpClient 内部 request 超时一致）。
    const tools = await withTimeout(client.listTools(), 30_000, 'MCP 连接超时（30s）')
    const names = tools.map((tool) => String((tool as { name?: unknown })?.name ?? '').trim()).filter(Boolean)
    return { ok: true, tools: names, message: `已连接，发现 ${tools.length} 个工具` }
  } catch (error) {
    return { ok: false, tools: [], message: error instanceof Error ? error.message : String(error) }
  } finally {
    client.close()
  }
}

/** GitLab MCP 握手（兼容旧 IPC/UI：复用通用测试，仅映射返回形态）。 */
async function testGitlabMcp(): Promise<{ ok: boolean; message: string }> {
  const result = await testMcpConnectionById('gitlab')
  return { ok: result.ok, message: result.message }
}

/**
 * 汇总探测四类凭据：Qoder Token / GitLab Token / Jira / Confluence。
 * - 各项结果（含未配置的 skipped）统一写入全局凭据状态并广播快照，
 *   前端顶栏指示灯常驻展示，不再弹窗后消失。
 * - 各项互不阻塞，任一失败不影响其他项结果。
 */
async function checkCredentialHealth(): Promise<CredentialState[]> {
  const checks: Array<Promise<void>> = []
  /** 登记一项检查：先置为 checking，完成后把结果写入全局状态并广播。 */
  const start = (key: CredentialKey, probe: Promise<Pick<CredentialState, 'status' | 'message'>>): void => {
    updateCredential(key, { status: 'checking', message: undefined })
    checks.push(
      probe
        .then((result) => updateCredential(key, { ...result, checkedAt: Date.now() }))
        .catch((error) =>
          updateCredential(key, {
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
            checkedAt: Date.now()
          })
        )
    )
  }
  /** 未配置项：静默计为 skipped，同样写入全局状态（供顶栏灰态展示）。 */
  const skip = (key: CredentialKey): void => {
    checks.push(Promise.resolve(updateCredential(key, { status: 'skipped', message: '未配置', checkedAt: Date.now() })))
  }

  // Qoder：复用状态探测，connected 即 Token 有效；探测本身也会回写全局状态。
  if (!protectedValue('qoderToken')) {
    skip('qoder')
  } else {
    start(
      'qoder',
      getQoderStatusForHealth().then((status): Pick<CredentialState, 'status' | 'message'> => {
        if (!status.enabled) return { status: 'skipped', message: '未配置' }
        return status.connected ? { status: 'ok' } : { status: 'failed', message: status.error ?? '连接失败' }
      })
    )
  }

  // GitLab：URL 与 Token 齐全时走 GitLab MCP 握手（/api/v4/mcp）；仅 Token 时回落 REST 验权。
  const gitlabToken = protectedValue('gitlabToken')
  if (!gitlabToken) {
    skip('gitlab')
  } else if (store.getSetting('gitlabUrl')?.trim()) {
    start(
      'gitlab',
      testGitlabMcp().then(
        (result): Pick<CredentialState, 'status' | 'message'> =>
          result.ok ? { status: 'ok' } : { status: 'failed', message: result.message }
      )
    )
  } else {
    start('gitlab', checkGitLabCredential(gitlabToken))
  }

  // Jira / Confluence：走 REST API 直接验权（/myself 等），秒级返回，不拉 MCP / uvx。
  for (const kind of ['jira', 'confluence'] as const) {
    const rest = atlassianFactory.restConfig(kind)
    if (!rest) {
      skip(kind)
      continue
    }
    start(
      kind,
      withTimeout(testAtlassianConnectionRest(kind, rest), 15_000, '连接测试超时（15s）').then(
        (result): Pick<CredentialState, 'status' | 'message'> =>
          result.ok ? { status: 'ok' } : { status: 'failed', message: result.message }
      )
    )
  }

  await Promise.all(checks)
  return credentialStateSnapshot()
}

// === Memory 任务上下文(检索/注入/整理) ========================================

/**
 * 选择任务上下文检索 / 关键词提取用的 chat 模型。
 * - 有 task 时跟随任务 runtime provider（任务显式 qoderModel > Agent preferredProvider > 系统全局），
 *   否则关键词提取会跟全局 modelProfile 走错驱动（用户配了 OpenAI profile 时任务明明是 Qoder 却走 openai）；
 * - 无 task（对话记忆检索等）时跟随系统 modelProfile。
 * - model 是 OpenAI 协议下的具体模型 value（`openai:<model>`，Qoder 模式下不使用,driver 内部自己拿默认）
 */
async function resolveTaskChatModel(task?: Task): Promise<{ driverId: ChatDriverId; model: string }> {
  const provider = task ? runtimeProvider(task) : modelProvider()
  const primary =
    provider === 'openai'
      ? ({ driverId: 'openai', model: resolveOpenAIModelValue() } as const)
      : ({ driverId: 'qoder', model: store.getSetting('defaultModel') ?? 'claude-sonnet-4.5' } as const)
  // 存储值失效（profile 删除 / 模型下线）时回落系统默认，可能换 driver。
  if (isModelValueAvailable(primary.model)) return primary
  const fallback = syncSystemDefaultModel()
  if (!fallback) return primary
  if (fallback.provider === 'qoder') return { driverId: 'qoder', model: fallback.model.replace(/^qoder:/, '') }
  return { driverId: 'openai', model: fallback.model }
}

async function taskMemoryContext(task: Task, repos: TaskRepository[]): Promise<string | undefined> {
  try {
    // 关键词提取走 LLM 同步起调用(Qoder 跳 lite,OpenAI 跟随),需要把这一步单独记
    // 到 trace 里:模型、返回的关键词数组、耗时。生产环境调 OpenAI 关键词提取本身
    // 一次几百毫秒 ~ 几秒,不记会让用户看到“检索”却不知道背后是 LLM 调用,trace 会误导。
    // 驱动跟随任务 runtime provider（Qoder 任务即使全局配了 OpenAI profile 也走 qoder-lite）。
    const { driverId } = await resolveTaskChatModel(task)
    const keywordModel = await resolveLiteModel(driverId)
    const tracedRewriter: KeywordRewriter = async (query) => {
      const start = Date.now()
      try {
        const kw = await keywordRewriterWithTrace(query, task.id, task)
        const ms = Date.now() - start
        addTaskEvent({
          taskId: task.id,
          kind: 'status',
          title: 'LLM 提取检索关键词',
          detail: `模型：${keywordModel}\n驱动：${driverId}\n关键词：${kw.length ? kw.join('、') : '（空，已回退到 fallbackKeywords）'}\n耗时：${ms} ms`
        })
        return kw
      } catch (error) {
        const ms = Date.now() - start
        addTaskEvent({
          taskId: task.id,
          kind: 'error',
          title: 'LLM 提取检索关键词失败',
          detail: `模型：${keywordModel}\n驱动：${driverId}\n耗时：${ms} ms\n${error instanceof Error ? error.message : String(error)}`
        })
        throw error
      }
    }
    const searchResult = await memoryService.search({
      userId: memoryService.ensureUserId(),
      repositoryIds: repos.map((repo) => repo.repositoryId),
      conversationId: `task:${task.id}`,
      query: `${task.title}\n${task.description}`,
      keywordRewriter: tracedRewriter
    })
    const { memories, wikiDocs, keywords } = searchResult
    addTaskEvent({
      taskId: task.id,
      kind: 'status',
      title: '检索记忆上下文',
      // 顶部拼接驱动 + 模型,跟「LLM 提取检索关键词」一致 —— 记忆检索只走 FTS5,
      // 但 FTS5 喂什么词是 LLM 决定的,用户要能看到这条线索。
      detail: formatMemorySearchDetail(memories, wikiDocs, keywords, { driverId, model: keywordModel })
    })
    const memoryContext = renderMemoryContext(memories, wikiDocs)
    // 独立发一条「注入记忆上下文」:与「注入 Agent 上下文」对称,验证检索出的内容真的
    // 进了 prompt。原实现只在「检索」上 addTaskEvent,不告诉调用方拼了什么,trace 上
    // 看不到实际注入的文本(只能去 hooks / driver 里推)。
    if (memoryContext) {
      addTaskEvent({
        taskId: task.id,
        kind: 'status',
        title: '注入记忆上下文',
        detail:
          memoryContext.length > 2000
            ? `${memoryContext.slice(0, 2000)}\n…（已截断，原文 ${memoryContext.length} 字）`
            : memoryContext
      })
    }
    return memoryContext
  } catch (error) {
    console.warn('[memory] task context failed:', error)
    return undefined
  }
}

/**
 * 把 memoryService.search 返回结果格式化为可读的 trace detail。
 * - 按 scope 分组列出（用户 / 仓库 / 对话 / repowiki）；
 * - 每条带标题 + score + 200 字预览；
 * - 顶部拼接驱动 + 模型（与「LLM 提取检索关键词」对齐 + 备注命中总数 / 关键词）。
 */
function formatMemorySearchDetail(
  memories: MemorySearchHit[],
  wikiDocs: RepoWikiSearchHit[],
  keywords: string[],
  meta: { driverId: string; model: string }
): string {
  const scopeLabel: Record<MemoryScope, string> = { user: '用户', repo: '仓库', conversation: '对话' }
  const total = memories.length + wikiDocs.length
  const header = [`驱动：${meta.driverId}`, `模型：${meta.model}`, `命中：${total} 条`]
  if (total === 0) {
    return [
      ...header,
      `未命中任何记忆（用户级 / 仓库级 / 对话级 / repowiki）。`,
      `关键词：${keywords.length ? keywords.join('、') : '（空）'}`
    ].join('\n')
  }
  const lines: string[] = [...header, `关键词：${keywords.join('、')}`]
  const grouped = new Map<MemoryScope, MemorySearchHit[]>()
  for (const m of memories) {
    if (!grouped.has(m.scope)) grouped.set(m.scope, [])
    grouped.get(m.scope)!.push(m)
  }
  for (const scope of ['user', 'repo', 'conversation'] as MemoryScope[]) {
    const list = grouped.get(scope)
    if (!list?.length) continue
    lines.push(`\n[${scopeLabel[scope]}级] ${list.length} 条`)
    for (const hit of list) {
      const preview = hit.content.length > 200 ? `${hit.content.slice(0, 200)}…` : hit.content
      lines.push(`- ${hit.title}（score ${hit.score.toFixed(1)}）\n  ${preview.replace(/\n+/g, ' ')}`)
    }
  }
  if (wikiDocs.length) {
    lines.push(`\n[repowiki] ${wikiDocs.length} 篇`)
    for (const doc of wikiDocs) {
      const preview = doc.content.length > 200 ? `${doc.content.slice(0, 200)}…` : doc.content
      lines.push(`- ${doc.path}（score ${doc.score.toFixed(1)}）\n  ${preview.replace(/\n+/g, ' ')}`)
    }
  }
  return lines.join('\n')
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
    // 复用任务执行模型（任务显式 > Agent 配置 > 系统默认），与任务同路径同模型整理记忆；
    // 缺运行时解析结果时回落任务级 chat 模型解析。
    const runtime = agentService.resolveRuntime(task, repos)
    const { driverId, model } =
      runtime.provider && runtime.model
        ? { driverId: runtime.provider as ChatDriverId, model: runtime.model }
        : await resolveTaskChatModel(task)
    const driver = chatDriverRegistry.tryGet(driverId)
    if (!driver) return
    // 记忆整理并入任务 Trace（不再产生独立 chat trace）：阶段容器（phase: memory）
    // + traceId join 任务执行树。trace 本不活跃（任务已终态）时 beginTrace 重开它，
    // 结束后由这里兜底 endTrace；活跃期 join 的收尾归 finalizeTaskTrace。
    const wasActive = tracePipeline.isActive(taskId)
    const stage = startTaskStageSpan(task, taskId, '记忆整理', 'memory')
    const joined = tracePipeline.isActive(taskId)
    try {
      const extracted = await extractMemories({
        driver,
        driverId,
        model,
        text: transcript,
        context: 'task',
        allowedScopes: ['user', 'repo'],
        ...(joined ? { traceId: taskId } : {})
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
    } finally {
      if (stage) {
        try {
          tracePipeline.endSpan(taskId, stage)
        } catch {
          /* trace 收尾失败不影响整理结果 */
        }
      }
      if (!wasActive && joined) {
        try {
          tracePipeline.endTrace(taskId)
        } catch {
          /* endTrace 幂等，与 finalizeTaskTrace 双触发安全 */
        }
      }
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
  /** 所属对话回合 traceId：记忆整理 LLM 调用 join 同一执行树。 */
  traceId?: string
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
      signal: input.signal,
      // join 当前对话回合：记忆整理 LLM 调用与主对话同树。
      traceId: input.traceId
    })
    if (!extracted.length) return
    memoryService.consolidateMemories(extracted, [], input.conversation.id)
  } catch (error) {
    console.warn('[memory] chat consolidate failed:', error)
  }
}

// === IPC 路由(全部保留) =======================================================

function registerIpc(): void {
  // Trace 页面（v2）：列表 / 详情 / 仪表盘统计。
  ipcMain.handle('trace:list', () => traceService.listSummaries())
  ipcMain.handle('trace:get', (_event, _kind: string, traceId: string) => traceService.getTrace(traceId))
  ipcMain.handle('trace:dashboard', () => traceService.dashboardStats())
  ipcMain.handle('trace:delete', (_event, _kind: string, traceId: string) => traceService.deleteTrace(traceId))
  ipcMain.handle('tasks:list', async () => {
    await mergeRefresher.refresh()
    return taskCardsWithCurrentChanges()
  })
  ipcMain.handle('tasks:get', async (_event, id: string) => {
    await mergeRefresher.refresh()
    return {
      task: store.getTask(id),
      // 运行中标记：前端 running 只由 agent_start/agent_end 事件驱动，应用重启后事件流丢失，
      // 必须用 activeTaskOperations 兜底恢复，否则 planning 中的任务会误显示"继续生成计划"按钮。
      running: activeTaskOperations.has(id),
      repositories: store.listTaskRepositories(id),
      // 看板执行 Tab 数据源：任务 trace span 树（events 表已废弃，历史任务无 span 则为空）。
      events: await traceService.getTaskEvents(id),
      openAiEvents: [],
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
    if (key === 'modelProfiles' || key === 'modelProfile') syncPiModelConfig()
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
  ipcMain.handle('tasks:cancel', (_event, taskId: string) => cancelTask(taskId))
  ipcMain.handle('tasks:review', (_event, taskId: string) =>
    runTaskOperation(taskId, (signal) => runReviewWithAutoFix(taskId, signal))
  )
  ipcMain.handle('tasks:reset-review', (_event, taskId: string) => taskWorkflow.resetReview(taskId))
  ipcMain.handle('tasks:reset-delivery', (_event, taskId: string) => deliveryService.resetDelivery(taskId))
  ipcMain.handle('tasks:submit-mrs', (_event, taskId: string) =>
    runTaskOperation(taskId, (signal) => submitMergeRequestsWithCredentialWatch(taskId, signal))
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
  ipcMain.handle('atlassian:test', (_event, kind: 'jira' | 'confluence') => {
    const rest = atlassianFactory.restConfig(kind)
    if (!rest) return { ok: false, message: `请先配置 ${kind === 'jira' ? 'Jira' : 'Confluence'} URL 与 Token` }
    return testAtlassianConnectionRest(kind, rest)
  })
  ipcMain.handle('gitlab:test-mcp', () => testGitlabMcp())
  ipcMain.handle('settings:check-credentials', () => checkCredentialHealth())
  ipcMain.handle('credentials:state', () => credentialStateSnapshot())
  ipcMain.handle('task:ui-response', (_event, response: Record<string, unknown>) =>
    pendingUi.get(String(response.id))?.(response)
  )
  // === MCP 统一配置（dataDir/mcp.json）：内置只读+启停，自定义可增改删 ==========
  ipcMain.handle('mcp:list', () => ({ servers: loadMcpServers(mcpConfigPath), filePath: mcpConfigPath }))
  ipcMain.handle('mcp:save', (_event, entry: McpServerEntry) => {
    const servers = loadMcpServers(mcpConfigPath)
    const editingId = entry?.id
    if (typeof editingId !== 'string' || !editingId) throw new Error('缺少服务 id')
    const error = validateMcpServerEntry(entry, servers, editingId)
    if (error) throw new Error(error)
    const existing = servers.find((s) => s.id === editingId)
    const next = existing
      ? servers.map((s) =>
          s.id === editingId
            ? // 内置：参数锁定，仅允许切换 enabled；自定义：完整替换
              s.builtin
              ? { ...s, enabled: Boolean(entry.enabled) }
              : { ...s, ...entry, builtin: false, enabled: Boolean(entry.enabled ?? s.enabled) }
            : s
        )
      : [...servers, { ...entry, builtin: false, enabled: entry.enabled !== false }]
    saveMcpServers(mcpConfigPath, next)
    return loadMcpServers(mcpConfigPath)
  })
  ipcMain.handle('mcp:delete', (_event, id: string) => {
    if (BUILTIN_MCP_IDS.has(id)) throw new Error('内置服务不允许删除')
    saveMcpServers(
      mcpConfigPath,
      loadMcpServers(mcpConfigPath).filter((s) => s.id !== id)
    )
    return loadMcpServers(mcpConfigPath)
  })
  ipcMain.handle('mcp:test', (_event, id: string) => testMcpConnectionById(id))
  // === Skill 管理（dataDir/skills）：文件夹 + zip 导入，删除 ==================
  ipcMain.handle('skill:list', () => listSkills(skillsRoot))
  ipcMain.handle('skill:import-zip', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Skill ZIP', extensions: ['zip'] }]
    })
    const zipPath = canceled ? undefined : filePaths[0]
    if (!zipPath) return undefined
    return importSkillZip(skillsRoot, zipPath)
  })
  ipcMain.handle('skill:import-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory']
    })
    const folderPath = canceled ? undefined : filePaths[0]
    if (!folderPath) return undefined
    return importSkillFolder(skillsRoot, folderPath)
  })
  ipcMain.handle('skill:delete', (_event, name: string) => {
    if (typeof name !== 'string' || !name) throw new Error('缺少技能名')
    deleteSkill(skillsRoot, name)
    return listSkills(skillsRoot)
  })
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
    async (
      _event,
      query: string,
      options?: { repositoryIds?: string[]; conversationId?: string; limit?: number; traceSource?: 'dev-probe' }
    ) => {
      const result = await memoryService.search({
        userId: memoryService.ensureUserId(),
        query,
        keywordRewriter,
        ...options
      })
      // trace_events 表已废弃（v2 只走 AgentSpan 管道）：dev probe 不再写"其它" trace 事件。
      return result
    }
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
   * 未显式选择模型时由系统自动选择（与对话/任务默认解析同一规则：Qoder → isDefault → lite）。
   *
   * 成功后会在 trace_events 写一条 "其它" 事件，让 Trace 页能看到该次生成。
   */
  ipcMain.handle(
    'agents:generate-content',
    async (
      _event,
      input: {
        model?: string
        description: string
        repositories: AgentGenerationRepository[]
      }
    ) => {
      const model = input?.model?.trim() || (await chatService.getDefaultModel())?.model
      if (!model) throw new Error('未配置可用模型，请先在设置中添加 Qoder Token 或 OpenAI 配置')
      const description = input?.description ?? ''
      const repositories = input?.repositories ?? []
      // 先读仓库本地背景（repowiki / agents.md / README.md）注入 prompt，
      // 这样无论 Qoder 还是 OpenAI 兼容模型都能拿到一致上下文；Qoder 路径还会另外
      // 启用只读工具（Read / Glob / Grep）让模型按需补充细节。
      const repoContext = await loadRepoContext(repositories)
      const prompt = buildAgentGenerationPrompt({ description, repositories, repoContext })
      // model 形如 `qoder:xxx` / `<厂商前缀>:<model>` / 其它自由字符串；按 `qoder:` 前缀判定驱动。
      // qoder 路径走专用轻量调用（只读工具 / maxTurns=3 / 120s 超时）——见 callQoderForAgentGeneration 注释。
      // openai 路径走纯 prompt fetch（不启工具，超时也压到 120s 与 Qoder 对齐）。
      const isQoder = model.startsWith('qoder:')
      // v2 trace：一次「AI 生成 Agent 说明」= 一个独立 trace（kind=task），记录所选模型与
      // 完整调用过程（qoder 路径含 Read/Glob/Grep 工具调用；openai 路径为单次 llm span）。
      const traceId = `agent-gen-${randomUUID()}`
      const qoderModel = model.slice('qoder:'.length)
      const openaiModel = stripOpenAIModelPrefix(model)
      tracePipeline.beginTrace({
        traceId,
        kind: 'task',
        title: `生成 Agent 说明：${description.replace(/\s+/g, ' ').trim().slice(0, 60)}`,
        source: isQoder ? 'qoder' : 'openai',
        agentName: isQoder ? 'Qoder' : 'OpenAI',
        ...(isQoder || openaiModel ? { model: isQoder ? qoderModel : openaiModel } : {})
      })
      const builder = isQoder ? new QoderTraceBuilder(tracePipeline, traceId, 'task', 'qoder', qoderModel) : undefined
      // openai 路径：请求前开 span（耗时覆盖完整请求），成功后补 output。
      const openaiSpan = isQoder
        ? undefined
        : tracePipeline.startSpan(traceId, {
            type: 'llm.generate',
            name: '生成 Agent 说明',
            ...(openaiModel ? { model: openaiModel } : {})
          })
      try {
        const raw = isQoder
          ? await callQoderForAgentGeneration(prompt, qoderModel, {
              additionalDirectories: repositories.map((repo) => repo.localPath),
              onMessage: (message) => {
                try {
                  builder?.onMessage(message as never)
                } catch {
                  /* 忽略：trace 采集失败不影响生成 */
                }
              }
            })
          : await callOpenAIForPrompt(prompt, AGENT_GENERATOR_TASK_ID, model, undefined, { timeoutMs: 120_000 })
        if (openaiSpan) tracePipeline.endSpan(traceId, openaiSpan, { output: raw })
        const result = parseAgentGenerationResult(raw)
        // trace_events 表已废弃（v2 只走 AgentSpan 管道）：生成结果不再写"其它" trace 事件。
        return result
      } catch (error) {
        if (openaiSpan) {
          tracePipeline.endSpan(traceId, openaiSpan, {
            status: 'error',
            error: { message: error instanceof Error ? error.message : String(error) }
          })
        }
        throw error
      } finally {
        builder?.finish()
        tracePipeline.endTrace(traceId)
      }
    }
  )
  // === Chat 对话(Codex 样式) =================================================
  ipcMain.handle('chats:list', () => chatService.listChats())
  ipcMain.handle('chats:list-projects', () => chatService.listProjects())
  ipcMain.handle('chats:get', (_event, id: string) => chatService.getChat(id))
  ipcMain.handle(
    'chats:create',
    (_event, input?: { driverId?: ChatDriverId; model?: string; workingDirectory?: string }) =>
      chatService.createChat(input?.driverId, input?.model, input?.workingDirectory)
  )
  ipcMain.handle('chats:delete', (_event, id: string) => {
    chatService.deleteChat(id)
    memoryService.deleteConversationMemories(id)
  })
  ipcMain.handle('chats:set-directory', (_event, id: string, workingDirectory?: string) =>
    chatService.setChatWorkingDirectory(id, workingDirectory)
  )
  ipcMain.handle('chats:list-models', async () => {
    const groups = await chatService.listModels()
    // Qoder 无 credit（配额用尽 / 可用模型只剩免费）时给 qoder 分组打标，
    // 前端模型选择弹窗据此提示「当前仅 lite 免费模型可用」，避免用户困惑为何只有 lite。
    const status = qoderStatusCache?.status
    if (status?.enabled && status.connected) {
      const enabled = status.models.filter((m) => m.isEnabled !== false)
      const quotaExhausted =
        status.usage?.isQuotaExceeded === true || (enabled.length > 0 && enabled.every((m) => m.priceFactor === 0))
      if (quotaExhausted) {
        const qoder = groups.find((group) => group.driverId === 'qoder')
        if (qoder) qoder.quotaExhausted = true
      }
    }
    return groups
  })
  ipcMain.handle('chats:default-model', () => chatService.getDefaultModel())
  ipcMain.handle('chats:start-stream', (_event, input) => {
    void chatService.startChatStream(input).catch((reason) => console.error('[chat] stream failed', reason))
  })
  ipcMain.handle('chats:abort', (_event, input) => chatService.abortChat(input))
  // 纯目录选择(项目对话绑定用,不校验 git;repos:choose-folder 才校验仓库)。
  ipcMain.handle('dialog:choose-directory', async () => {
    if (!mainWindow) return undefined
    const localPath = (await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })).filePaths[0]
    return localPath || undefined
  })
}

// 统一应用图标：dev 环境取 build/icon.png 源文件，打包后取 vite 从 public/ 拷贝到 dist/ 的副本，
// 保证 Windows/Linux 运行时窗口图标与 macOS dev Dock 图标和打包产物一致。
function resolveAppIcon(): Electron.NativeImage | undefined {
  for (const candidate of [
    join(__dirname, '../build/icon.normalized.png'),
    join(__dirname, '../build/icon.png'),
    join(__dirname, '../dist/icon.png')
  ]) {
    if (!existsSync(candidate)) continue
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image
  }
  return undefined
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#111210',
    icon: resolveAppIcon(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  })
  if (process.env.VITE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  else await mainWindow.loadFile(join(__dirname, '../dist/index.html'))
}

app.whenReady().then(() => {
  // macOS dev 环境 Dock 默认显示 Electron 默认图标，替换为应用图标保持与打包版一致。
  if (process.platform === 'darwin' && process.env.VITE_DEV_SERVER_URL) {
    const icon = resolveAppIcon()
    if (icon) app.dock?.setIcon(icon)
  }
  if (!resolveBundledOcrBinary()) {
    console.warn(
      '[ocr] @alibaba-group/open-code-review not found in node_modules; reviews will fall back to PATH lookup and may fail in packaged builds.'
    )
  }
  registerIpc()
  void createWindow()
  // 孤儿 trace 收口：崩溃/强杀残留的 events 文件 finalize 为「已结束 + interrupted」。
  sweepInterruptedTraces()
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
app.on('activate', () => {
  // macOS：点击 dock 图标时重新唤起窗口。无窗口则新建；窗口被 hide 后则恢复并聚焦。
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow()
  } else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})
app.on('before-quit', () => {
  void stopPi()
  store.close()
})
