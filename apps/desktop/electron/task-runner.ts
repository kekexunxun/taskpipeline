/**
 * task-runner.ts — Review 实现 + OpenAI 调用 + 自动修订配置 + 辅助工具
 *
 * 从 main.ts 提取的纯逻辑函数集合：
 *  - Qoder / OpenAI Review 调用（callQoderReviewer, callQoderOrOpenAIReviewer, …）
 *  - OpenAI 兼容 prompt 调用（callOpenAIForPrompt）
 *  - AI Agent 生成（callQoderForAgentGeneration, loadRepoContext）
 *  - 自动修订配置（reviewAutoFixEnabled, collectReviewComments, buildReviewFixPrompt）
 *  - 校验后推进（advanceAfterValidation）
 *  - 测试覆盖检测（runTestCoverageCheck）
 *
 * Pi 依赖的编排函数（runQoder / runReviewWithAutoFix / finishImplementation / runQoderPlan …）
 * 因直接操作 piSession / startPi 等共享状态，保留在 main.ts。
 * 通过 initTaskRunner(deps) 注入共享依赖，避免循环引用。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSpan, AgentSpanUsage, Task, TaskState, TaskStore } from '@task-pipeline/core'
import type { OpenAICompatReviewer, TaskWorkflow } from '@task-pipeline/integrations'
import { query, accessToken } from '@qoder-ai/qoder-agent-sdk'
import { recordQoderMessage } from './task-agent/log.js'
import { QoderTraceBuilder } from './trace/instrument/qoder-trace-builder.js'
import type { TracePipeline } from './trace/bus/trace-pipeline.js'
import { implementationOutcomeInstruction } from './task-readiness.js'
import { parsePlanDecision } from './plan-content.js'
import { nextStepForPlan } from './task-readiness.js'
import type { AgentService, OperationKind } from './agents/agent-service.js'
import { formatRepoContext, type AgentGenerationRepository, type RepoContextEntry } from './agents/agent-generator.js'
import { stripQoderModelPrefix } from './task-agent/qoder-task-agent.js'
import type { QoderTaskAgentDriver } from './task-agent/qoder-task-agent.js'
import type { ChatDriverId } from './chat/chat-types.js'
import type { MemoryService } from './memory/memory-service.js'

// ── 依赖注入 ─────────────────────────────────────────────────────────────────

interface TaskRunnerDeps {
  store: TaskStore
  protectedValue: (key: string) => string | undefined
  addTaskEvent: (event: { taskId: string; kind: string; title: string; detail?: string }) => void
  emitPi: (event: unknown) => void
  tracePipeline: TracePipeline
  openAIReviewer: OpenAICompatReviewer
  agentService: AgentService
  qoderTaskAgent: QoderTaskAgentDriver
  memoryService: MemoryService
  taskWorkflow: TaskWorkflow

  // main.ts 函数
  providerForTask: (taskId: string | undefined) => 'qoder' | 'openai'
  defaultOpenAIProfile: () =>
    | { baseUrl?: string; model?: string; vendor?: string; id?: string; isDefault?: boolean }
    | undefined
  openAIApiKeyFor: (profile: { baseUrl?: string; model?: string; vendor?: string }) => string | undefined
  stripOpenAIModelPrefix: (model: string | undefined) => string | undefined
  resolveLiteModel: (driverId: ChatDriverId) => Promise<string>
  updateState: (task: Task, state: TaskState) => Task
  submitMergeRequestsWithCredentialWatch: (taskId: string, signal?: AbortSignal) => Promise<void>
  taskChangedFiles: (
    taskId: string,
    excludeUnchanged?: boolean
  ) => Promise<Array<{ path: string; status: string; repositoryName: string }>>
  runReviewWithAutoFix: (taskId: string, signal?: AbortSignal) => Promise<void>
  runOperationAgent: (taskId: string, operation: OperationKind, body: string, signal?: AbortSignal) => Promise<string>
}

let deps: TaskRunnerDeps
export function initTaskRunner(d: TaskRunnerDeps): void {
  deps = d
}

// ── Review 实现 ──────────────────────────────────────────────────────────────

async function callQoderReviewer(
  prompt: string,
  taskId: string,
  model?: string,
  signal?: AbortSignal,
  onMessage?: (message: unknown) => void
): Promise<string> {
  const token = deps.protectedValue('qoderToken')
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
          recordQoderMessage(deps.store, taskId, message, {
            recordText: true,
            addTaskEvent: deps.addTaskEvent,
            emitPi: deps.emitPi
          })
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
    const source = deps.providerForTask(taskId) === 'qoder' ? 'qoder' : 'pi'
    deps.tracePipeline.beginTrace({
      traceId: taskId,
      kind: 'task',
      title: task.title,
      source,
      ...(task.qoderModel ? { model: stripQoderModelPrefix(task.qoderModel) } : {})
    })
    deps.tracePipeline.ensureRootSpan(taskId, { type: 'task.run', name: '任务执行', meta: { source } })
    return deps.tracePipeline.startSpan(taskId, { type: 'agent.run', name, meta: { source, phase } })
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
  const modelName = deps.stripOpenAIModelPrefix(model)
  const llmSpan = stage
    ? deps.tracePipeline.startSpan(taskId, {
        type: 'llm.generate',
        name: modelName ?? 'OpenAI Review',
        ...(modelName ? { model: modelName } : {}),
        input: prompt,
        meta: { source: 'pi' }
      })
    : undefined
  let usage: AgentSpanUsage | undefined
  try {
    const text = await deps.openAIReviewer.call(input, taskId, modelName, signal, prompt, (u) => {
      usage = u
    })
    if (llmSpan) deps.tracePipeline.endSpan(taskId, llmSpan, { output: text, ...(usage ? { usage } : {}) })
    return text
  } catch (error) {
    if (llmSpan) {
      deps.tracePipeline.endSpan(taskId, llmSpan, {
        status: 'error',
        error: { message: error instanceof Error ? error.message : String(error) }
      })
    }
    throw error
  } finally {
    if (stage) {
      try {
        deps.tracePipeline.endSpan(taskId, stage)
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
  const task = deps.store.getTask(taskId)
  const repos = task ? deps.store.listTaskRepositories(taskId) : []
  const { roleBody } = deps.agentService.resolveOperationAgent('review', task ?? undefined, repos)
  const prompt = buildReviewPromptForQoder(input, roleBody)
  // review 阶段容器：CodeReview 进入任务阶段链（关键词提取→Plan→Exec→CodeReview→…），
  // per repo 调用在容器内产 llm/tool span（此前 review 完全没接 trace，阶段链数据缺失）。
  const stage = startTaskStageSpan(task, taskId, 'CodeReview', 'review')
  if (deps.providerForTask(taskId) !== 'qoder')
    return runOpenAIReviewWithSpan(input, taskId, model, signal, prompt, stage)
  // Review 逐仓库执行：按 input.repo 匹配仓库，注入该仓库 Agent 的指引（领域约定）。
  let finalPrompt = prompt
  if (task) {
    const target = repos.find((repo) => repo.name === input.repo)
    const agent = target
      ? deps.agentService.resolveAgentFor(
          target.repositoryId,
          task.agentProfileId,
          task.repoAgentIds?.[target.repositoryId]
        )
      : undefined
    const body = [agent?.systemPrompt, agent?.engineeringGuidelines].filter(Boolean).join('\n\n')
    if (body) finalPrompt = `## Agent 指引 — 仓库 ${input.repo}\n${body}\n\n${prompt}`
  }
  // Qoder reviewer：SDK 消息流经 QoderTraceBuilder 转成 llm/tool span（挂栈顶落入 review 容器）。
  const builder = stage
    ? new QoderTraceBuilder(deps.tracePipeline, taskId, 'task', 'qoder', stripQoderModelPrefix(model))
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
        deps.tracePipeline.endSpan(taskId, stage)
      } catch {
        /* trace 收尾失败不影响 review */
      }
    }
  })
}

// ── AI Agent 生成 ────────────────────────────────────────────────────────────

/**
 * 「AI 生成 Agent 模板」专用 Qoder 调用：与 `callQoderReviewer` 共享 token / abort 机制，
 * 但明显轻量化 —— 一次性返回 JSON，不需要 review 路径的 16 个工具栈 / 长超时。
 */
const AGENT_GENERATION_TIMEOUT_MS = 120_000
async function callQoderForAgentGeneration(
  prompt: string,
  model: string,
  options: { additionalDirectories?: string[]; signal?: AbortSignal; onMessage?: (message: unknown) => void } = {}
): Promise<string> {
  const { additionalDirectories = [], signal, onMessage } = options
  const token = deps.protectedValue('qoderToken')
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
      includePartialMessages: true,
      allowedTools: ['Read', 'Glob', 'Grep'],
      maxTurns: 3,
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
 */
async function loadRepoContext(repositories: AgentGenerationRepository[]): Promise<string> {
  if (repositories.length === 0) return ''
  const entries = await Promise.all(
    repositories.map(async (repo): Promise<RepoContextEntry | null> => {
      try {
        let wikiDocs: RepoContextEntry['wikiDocs'] = []
        try {
          wikiDocs = deps.memoryService
            .listRepoWikiDocs(repo.id)
            .map((doc) => ({ path: doc.path, title: doc.title, content: doc.content }))
        } catch {
          wikiDocs = []
        }
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

// ── OpenAI 兼容 prompt 调用 ──────────────────────────────────────────────────

/**
 * OpenAI 兼容路径的纯 prompt 调用（无 DelegateReviewerInput 包装）。
 * 用于 runOperationAgent 等不需要 Review 输入结构的场景。
 */
async function callOpenAIForPrompt(
  prompt: string,
  _taskId: string,
  model?: string,
  signal?: AbortSignal,
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const { timeoutMs = 180_000 } = options
  const profile = deps.defaultOpenAIProfile()
  if (!profile) throw new Error('未配置 OpenAI-Compatible 模型')
  if (!profile.baseUrl || !profile.model) throw new Error('默认 OpenAI 配置缺少 baseUrl 或 model')
  const apiKey = deps.openAIApiKeyFor(profile)
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
        model: deps.stripOpenAIModelPrefix(model) ?? profile.model,
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

// ── 自动修订配置 ─────────────────────────────────────────────────────────────

/** 系统设置：Review 阻断后是否自动按意见修订（默认关闭，由用户在设置里开启）。 */
function reviewAutoFixEnabled(): boolean {
  return deps.store.getSetting('reviewAutoFix') === 'true'
}
/** 系统设置：自动修订最大轮数（默认 2）。 */
function reviewAutoFixMaxRounds(): number {
  const raw = Number(deps.store.getSetting('reviewAutoFixMaxRounds'))
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 10) : 2
}

/** 从最近的 review 事件里收集意见（含阻断级别），用于自动修订 prompt。 */
function collectReviewComments(
  taskId: string,
  blockingOnly: boolean
): Array<{ severity?: string; path?: string; line?: number; message?: string }> {
  const events = deps.store.listEvents(taskId)
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
 * 校验后推进：Review 开启则跑 review，否则直接跳到 awaiting_commit；
 * 若任务级/系统级开关打开则自动创建 MR。
 */
async function advanceAfterValidation(taskId: string, state: TaskState, signal?: AbortSignal): Promise<void> {
  if (state !== 'awaiting_review') return
  signal?.throwIfAborted()
  const task = deps.store.getTask(taskId)
  // 任务级覆盖优先于系统级设置。
  if (deps.taskWorkflow.isReviewEnabledFor(task)) {
    // runReviewWithAutoFix 保留在 main.ts（依赖 piSession / startPi 共享状态），
    // 通过 deps 回调注入，避免循环引用。
    await deps.runReviewWithAutoFix(taskId, signal)
  } else {
    deps.store.updateTask(taskId, { reviewStatus: 'waived' })
    deps.updateState(deps.store.getTask(taskId)!, 'awaiting_commit')
    deps.addTaskEvent({ taskId, kind: 'status', title: '已跳过 Review,等待提交 MR' })
  }
  const updated = deps.store.getTask(taskId)
  if (updated?.state === 'awaiting_commit' && deps.taskWorkflow.shouldAutoCreateMergeRequestsFor(updated)) {
    await deps.submitMergeRequestsWithCredentialWatch(taskId, signal)
  }
}

// ── 测试覆盖检测 ─────────────────────────────────────────────────────────────

/**
 * LLM 驱动的测试覆盖检测：在生成测试用例之前，先让 Test Writer Agent 判断当前改动是否已有测试覆盖。
 * 检测调用失败或返回 false 时不跳过（保守：照常生成测试）。
 */
async function runTestCoverageCheck(taskId: string, signal?: AbortSignal): Promise<boolean> {
  const task = deps.store.getTask(taskId)
  if (!task) return false
  let changedFiles: Awaited<ReturnType<typeof deps.taskChangedFiles>>
  try {
    changedFiles = await deps.taskChangedFiles(taskId, true)
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
    const text = await deps.runOperationAgent(taskId, 'test', body, signal)
    if (!text) return false
    const json = JSON.parse(text.trim())
    if (json.covered === true) {
      deps.addTaskEvent({ taskId, kind: 'status', title: '检测到已有测试覆盖，跳过生成', detail: json.reason || '' })
      return true
    }
    return false
  } catch (error) {
    deps.addTaskEvent({
      taskId,
      kind: 'error',
      title: '测试覆盖检测失败，将继续生成测试用例',
      detail: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

// ── 计划决策 ─────────────────────────────────────────────────────────────────

async function savePlanDecision(taskId: string, texts: string[]): Promise<Task> {
  const decision = parsePlanDecision(texts)
  if (decision.outcome === 'changes_required') return deps.taskWorkflow.setPlan(taskId, decision.content)

  let changedFiles: Awaited<ReturnType<typeof deps.taskChangedFiles>>
  try {
    changedFiles = await deps.taskChangedFiles(taskId, false)
  } catch (error) {
    const pending = deps.taskWorkflow.setPlan(
      taskId,
      [
        '## 需要人工确认',
        '',
        'Agent 判断当前代码已满足任务要求，但系统无法确认工作区是否存在文件变化，因此任务未自动完成。',
        '',
        decision.content
      ].join('\n')
    )
    deps.store.updateTask(taskId, { summary: '无法确认文件状态，等待计划确认' })
    deps.addTaskEvent({
      taskId,
      kind: 'error',
      title: '无法确认计划阶段的文件改动',
      detail: error instanceof Error ? error.message : String(error)
    })
    return pending
  }

  if (nextStepForPlan(decision.outcome, changedFiles.length) === 'complete_without_changes') {
    return deps.taskWorkflow.completeWithoutChanges(taskId, decision.content)
  }

  const changedList = changedFiles.map((file) => `- ${file.repositoryName}: ${file.path} (${file.status})`).join('\n')
  const pending = deps.taskWorkflow.setPlan(
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
  deps.store.updateTask(taskId, { summary: '计划结论与文件变化不一致，等待确认' })
  deps.addTaskEvent({
    taskId,
    kind: 'status',
    title: '计划结论与文件变化不一致',
    detail: `Agent 返回无需修改，但系统检测到 ${changedFiles.length} 个文件变化，任务不会自动完成。`
  })
  return pending
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

export {
  callQoderReviewer,
  startTaskStageSpan,
  callQoderOrOpenAIReviewer,
  callQoderForAgentGeneration,
  loadRepoContext,
  callOpenAIForPrompt,
  savePlanDecision,
  reviewAutoFixEnabled,
  reviewAutoFixMaxRounds,
  collectReviewComments,
  buildReviewFixPrompt,
  advanceAfterValidation,
  runTestCoverageCheck
}
