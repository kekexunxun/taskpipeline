/**
 * Pi session 管理 + UI 请求桥接：
 *  - requestUi / emitPi：主进程 ↔ 渲染进程的 UI 交互桥（HITL 确认、AskUserQuestion 等）
 *  - openPiTaskSession / releasePiSession / forkPiStage：Pi Agent Session 生命周期与阶段边界
 *  - syncPiModelConfig：把 OpenAI profile 同步到 Pi 的 models.json
 *  - createGuiUI：为 Pi Extension 提供 GUI 上下文
 *  - handleAskUserQuestion / prettyToolName：HITL 辅助工具
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import type { ExtensionUIDialogOptions, ExtensionUIContext, AgentSession } from '@earendil-works/pi-coding-agent'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import type { TaskStore } from '@task-pipeline/core'
import { lookupCostRate } from '@task-pipeline/core'
import { redactSecrets } from '@task-pipeline/integrations'
import type { TaskAgentPhase } from '../agents/task-agent/task-agent-driver.js'
import type { TracePipeline } from '../trace/bus/trace-pipeline.js'
import { PiTraceBuilder } from '../trace/instrument/pi-trace-builder.js'
import type { ModelProfile } from '../chat/model-profile.js'

// ── 依赖注入 ─────────────────────────────────────────────────────────────────

interface PiSessionDeps {
  store: TaskStore
  dataDir: string
  tracePipeline: TracePipeline
  protectedValue: (key: string) => string | undefined
  readOpenAIProfiles: () => ModelProfile[]
  defaultOpenAIProfile: () => ModelProfile | undefined
  openAIApiKeyFor: (profile: ModelProfile) => string | undefined
  providerForTask: (taskId: string | undefined) => string
  updatePiUsage: (taskId: string) => void
  emitTaskChanged: (taskId: string) => void
  sendTaskEvent: (event: Record<string, unknown>) => void
  /** Pi trace builder 注册表（main.ts 管理生命周期） */
  piTraceBuilders: Map<string, PiTraceBuilder>
  /** 获取 mainWindow（延迟解析） */
  getMainWindow: () => Electron.BrowserWindow | undefined
}

let deps: PiSessionDeps | null = null

export function initPiSession(d: PiSessionDeps): void {
  deps = d
}

function d(): PiSessionDeps {
  if (!deps) throw new Error('pi-session not initialized')
  return deps
}

/**
 * 本文件是「Pi 会话的机制层」：开/关会话、阶段间 fork、事件路由、UI 桥。
 * 阶段策略（发什么 prompt、何时拆边界、降级）在 `pi-task-agent.ts`（driver），
 * 状态机与产物在 `task-lifecycle.ts`（编排）：机制层谁调都能用，不隐含「一定是计划阶段」。
 */

// ── 会话注册表 ───────────────────────────────────────────────────────────────

/**
 * 一个任务同时只有一个活的 Pi 会话，但归属是「阶段实例」而不是任务：
 * 阶段内多轮 prompt 续接同一个 handle，阶段之间 fork（见 `forkPiStage`）。
 *
 * 此前这里是 `let piSession` + `let activeTaskId` 两个进程级单例：`emitPi` 只能靠
 * 「当前活动任务」反推事件归属，两个任务并行时 trace / 用量 / 完成回调会串到别人身上。
 */
const piSessions = new Map<
  string,
  {
    taskId: string
    session: AgentSession
    sessionFile: string | undefined
    unsubscribe: (() => void) | undefined
    /** 回捞期间的流式文本增量（一次性 prompt 阶段：计划 / 测试用例）。 */
    deltas: string
    /**
     * 最近一次 `agent_end` 的 assistant 文本。
     * 实现阶段的产物口径与旧全局实现一致（读 `agent_end.messages`，不是读增量拼接），
     * 避免「换注册表顺手改了产物来源」这种夹带改动。
     */
    agentEndTexts: string[]
    error: string | undefined
    /** 会话归属的阶段实例：事件里的 `stageInstanceId` 来源。 */
    stageInstanceId: string | undefined
    /** 会话当前在跑的阶段：事件里的 `phase` 来源（渲染层与 Trace 分段用）。 */
    phase: TaskAgentPhase | undefined
  }
>()

/** 会话打开上下文：只记录归属，不影响续接。 */
export type PiSessionContext = { stageInstanceId?: string; phase?: TaskAgentPhase }

/** 回捞归属的阶段：一次性 prompt 阶段（计划 / 测试用例）要拿回文本自己解析。 */
export type PiCapturePhase = Extract<TaskAgentPhase, 'planning' | 'test_generation'>
/** 正在回捞文本的阶段：`planning` / `test_generation` 期间不把 `agent_end` 当成实现收尾。 */
const capturing = new Map<string, PiCapturePhase>()
const pendingUi = new Map<string, (response: Record<string, unknown>) => void>()

/** 正在跑 Pi 会话的任务（UI / 停止入口据此判定「该不该动这个任务」，不再靠单例猜）。 */
export function getPiTaskIds(): string[] {
  return [...piSessions.keys()]
}

export function isPiSessionBusy(taskId: string): boolean {
  const handle = piSessions.get(taskId)
  return !!handle && !handle.session.isIdle
}

/** 只读某个任务当前会话的 sessionId / sessionFile（driver 判定「要不要续接」用）。 */
export function getPiSessionInfo(taskId: string): { sessionId?: string; sessionFile?: string } | undefined {
  const handle = piSessions.get(taskId)
  if (!handle) return undefined
  return {
    sessionId: handle.session.sessionId,
    ...(handle.session.sessionFile ? { sessionFile: handle.session.sessionFile } : {})
  }
}

/** 某个任务的活会话（用量统计、中断探测用；不存在返回 undefined，绝不隐式开会话）。 */
export function getPiSessionForTask(taskId: string): AgentSession | undefined {
  return piSessions.get(taskId)?.session
}

/** 待应答的 UI 请求（渲染进程把用户选择回填给对应 id）。 */
export function getPendingUi(): Map<string, (response: Record<string, unknown>) => void> {
  return pendingUi
}

/** 打开（或复用）某任务的 Pi 会话；归属信息只用于事件标注。 */
export async function ensurePiSession(taskId: string, context?: PiSessionContext): Promise<AgentSession> {
  const existing = piSessions.get(taskId)
  if (existing) {
    if (context?.stageInstanceId) existing.stageInstanceId = context.stageInstanceId
    if (context?.phase) existing.phase = context.phase
    return existing.session
  }
  return openPiTaskSession(taskId, context)
}

/** 开始回捞某个任务的阶段文本（计划 / 测试用例）；与 `endPiCapture` 成对调用。 */
export function beginPiCapture(taskId: string, phase: PiCapturePhase): void {
  capturing.set(taskId, phase)
  const handle = piSessions.get(taskId)
  if (handle) {
    handle.deltas = ''
    handle.error = undefined
  }
}

/** 取回某个 handle 累积的文本 / 错误并停止回捞（可安全放在 finally：没有 handle 时返回空）。 */
export function endPiCapture(taskId: string): { text: string; error: string | undefined } {
  capturing.delete(taskId)
  const handle = piSessions.get(taskId)
  const result = { text: handle?.deltas ?? '', error: handle?.error }
  if (handle) {
    handle.deltas = ''
    handle.error = undefined
  }
  return result
}

/** 取回最近一次 `agent_end` 的实现阶段产物并清空缓冲（实现阶段不看回捞文本）。 */
export function takePiAgentEndTexts(taskId: string): string[] {
  const handle = piSessions.get(taskId)
  const texts = handle?.agentEndTexts ?? []
  if (handle) handle.agentEndTexts = []
  return texts
}

/** 会话是否已经跑完本回合（driver 用它决定「等 agent_end」还是「继续排队」。） */
export function isPiSessionIdle(taskId: string): boolean {
  const handle = piSessions.get(taskId)
  return !handle || handle.session.isIdle
}

/** 会话文件目录与 cwd：与 `openPiTaskSession` 保持同一口径（否则 fork 出的会话下次打不开）。 */
function piSessionDir(): string {
  return join(d().dataDir, 'pi-sessions')
}

function piWorkspaceCwd(taskId: string): string {
  const repo = d().store.listTaskRepositories(taskId)[0]
  return repo?.worktreePath ?? repo?.localPath ?? process.cwd()
}

/**
 * fork 结果：要么拿到新会话文件，要么带上一句失败原因。
 *
 * 为什么不是 `string | undefined`：“没得 fork”与“fork 抛错”在 Trace 上是两回事，
 * 前者是预期路径（首次执行），后者是降级（必须能看到原因）。
 */
export type PiForkOutcome = { file?: string; error?: string }

/**
 * 阶段边界 = 会话边界：从当前会话 fork 出一个新会话（`SessionManager.forkFrom`）。
 *
 * `anchorEntryId` 给出时改用 `createBranchedSession(leafId)`——它只把「根到该叶子」的路径
 * 写进新文件，等价于 Qoder 侧的 `resumeSessionAt`（实测见方案 §1 V13）。
 * fork 完只是备好新会话：旧会话就地释放，下一次 `ensurePiSession` 才真正开新 session
 * （Pi 的 createAgentSession 是异步且要绑扩展，不适合在这里半开）。
 *
 * **不抛异常**（P3 收尾）：实测 `forkFrom` 在源文件不合法时会抛
 * `Cannot fork: source session file is empty or invalid`。机制层把它折成 `{ error }`，
 * 由 driver（`pi-task-agent.ts`）决定怎么降级 —— 它的「退化成新开会话 + 记一笔」路径已存在。
 */
export async function forkPiStage(taskId: string, options?: { anchorEntryId?: string }): Promise<PiForkOutcome> {
  const source = piSessions.get(taskId)?.sessionFile ?? d().store.getTask(taskId)?.piSessionPath
  if (!source || !existsSync(source)) return { error: '没有可继承的会话文件' }
  const cwd = piWorkspaceCwd(taskId)
  const sessionDir = piSessionDir()
  let nextFile: string | undefined
  try {
    nextFile = options?.anchorEntryId
      ? SessionManager.open(source, sessionDir, cwd).createBranchedSession(options.anchorEntryId)
      : SessionManager.forkFrom(source, cwd, sessionDir).getSessionFile()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (!nextFile) return { error: 'fork 未产出会话文件' }
  // 换指针之前先关旧会话：dispose 之后旧 handle 的事件不会再进来（否则 fork 后两个会话同时在推）。
  await releasePiSession(taskId, { keepSessionFile: nextFile })
  return { file: nextFile }
}

/** 释放一个任务的会话（退订 + dispose），可选把新会话文件写回 `task.piSessionPath`。 */
export async function releasePiSession(taskId: string, options?: { keepSessionFile?: string }): Promise<void> {
  const handle = piSessions.get(taskId)
  if (handle) {
    piSessions.delete(taskId)
    handle.unsubscribe?.()
    if (!handle.session.isIdle) await handle.session.abort().catch(() => undefined)
    handle.session.dispose()
  }
  capturing.delete(taskId)
  if (options?.keepSessionFile) d().store.updateTask(taskId, { piSessionPath: options.keepSessionFile })
  cancelPendingUi(taskId)
}

/** 应用退出 / 窗口销毁：释放所有 Pi 会话。 */
export async function releaseAllPiSessions(): Promise<void> {
  for (const taskId of [...piSessions.keys()]) await releasePiSession(taskId)
  cancelPendingUi()
}

/**
 * 删除任务的 Pi 会话文件（§4.4 级联：任务被删 / 重置时同步走）。
 *
 * 两道：先走 `purgePiTaskSessionFiles`（扫目录按首行 header.cwd 归因，能盖到 fork 的前驱文件），
 * 再按 DB 指针补删这一份（指针可能指向已被移走的文件，或 header 解析失败时兜底）。
 * 只删落在 `<dataDir>/pi-sessions` 直接子层的文件，不信任 DB 里的任意路径。
 */
export function deletePiTaskSessionFile(taskId: string): void {
  const file = piSessions.get(taskId)?.sessionFile ?? d().store.getTask(taskId)?.piSessionPath
  if (!file) return
  const rel = relative(piSessionDir(), file)
  if (!rel || rel.startsWith('..') || rel.includes(sep)) return
  try {
    rmSync(file, { force: true })
  } catch {
    /* 删不掉不阻断任务删除；下次重置还会再试 */
  }
}

// ── UI 请求桥接 ──────────────────────────────────────────────────────────────

/** 请求 id → 归属任务：释放某个任务的会话时只取消它自己的弹窗，不牵连并行任务。 */
const pendingUiOwner = new Map<string, string>()

function cancelPendingUi(taskId?: string): void {
  const ids = taskId
    ? [...pendingUiOwner.entries()].filter(([, owner]) => owner === taskId).map(([id]) => id)
    : [...pendingUi.keys()]
  for (const id of ids) {
    pendingUi.get(id)?.({ cancelled: true })
    pendingUi.delete(id)
    pendingUiOwner.delete(id)
  }
}

export function requestUi<T>(
  method: string,
  payload: Record<string, unknown>,
  options?: ExtensionUIDialogOptions & { taskId?: string }
): Promise<T | undefined> {
  const id = randomUUID()
  return new Promise((resolve) => {
    let abortListener: () => void = () => undefined
    const finish = (response: Record<string, unknown>) => {
      if (options?.signal) options.signal.removeEventListener('abort', abortListener)
      pendingUi.delete(id)
      pendingUiOwner.delete(id)
      if (response.cancelled) resolve(undefined)
      else if (method === 'confirm') resolve(Boolean(response.confirmed) as T)
      else resolve(response.value as T | undefined)
    }
    pendingUi.set(id, finish)
    if (options?.taskId) pendingUiOwner.set(id, options.taskId)
    emitPi({
      type: 'extension_ui_request',
      id,
      method,
      ...(options?.taskId ? { taskId: options.taskId } : {}),
      ...payload
    })
    abortListener = () => finish({ cancelled: true })
    options?.signal?.addEventListener('abort', abortListener, { once: true })
  })
}

/**
 * AskUserQuestion HITL：agent 向用户提问，展示选项让用户选择，把用户的选择作为工具结果返回。
 * 支持多问题：questions 数组可包含多个问题，前端卡片逐一展示，用户逐个选择后一次性返回。
 */
export function handleAskUserQuestion(
  toolInput: Record<string, unknown>,
  options: { signal?: AbortSignal; conversationId?: string; taskId?: string }
): Promise<string[] | undefined> {
  const questions = (
    toolInput as { questions?: { header?: string; question?: string; options?: { label: string }[] }[] }
  ).questions
  if (!Array.isArray(questions) || questions.length === 0) return Promise.resolve(undefined)
  const allQuestions = questions.map((q) => ({
    header: (q.header as string) ?? '问题',
    question: (q.question as string) ?? '',
    options: Array.isArray(q.options) ? q.options : []
  }))
  return requestUi<string | string[]>(
    'ask-user',
    {
      questions: allQuestions,
      ...(allQuestions.length === 1
        ? (() => {
            const q = allQuestions[0]!
            return {
              title: q.header,
              message: q.question,
              options: q.options.map((o) => o.label),
              optionDetails: q.options
            }
          })()
        : {
            title: allQuestions.length > 1 ? `${allQuestions.length} 个问题` : allQuestions[0]!.header
          }),
      ...options
    },
    { signal: options.signal }
  ).then((result) => {
    if (result === undefined) return undefined
    return Array.isArray(result) ? result : [result]
  })
}

/**
 * 工具名美化：`mcp__jira__create_issue` → `Jira: create_issue`。
 * 弹窗标题可读性（原始 mcp__ 前缀 + 下划线太机器味）。非 mcp__ 名原样返回。
 */
export function prettyToolName(name: string): string {
  const match = /^mcp__([^_]+)__(.+)$/.exec(name)
  if (!match) return name
  const server = (match[1] ?? '').charAt(0).toUpperCase() + (match[1] ?? '').slice(1)
  return `${server}: ${match[2] ?? ''}`
}

// ── emitPi ───────────────────────────────────────────────────────────────────

/**
 * Pi 会话事件 / 桥接事件的唯一出口：按事件自带的 `taskId` 路由到该任务的会话 handle。
 *
 * 归因只能来自事件本身（P3）：此前是「进程级当前任务」，两个任务并行时用量 / Trace /
 * 完成回调会记到别人头上。无 `taskId` 的事件（对话板块的 UI 请求等）原样转发，不做阶段归因。
 */
export function emitPi(event: unknown): void {
  const json = JSON.stringify(event, (_key, value) => (typeof value === 'string' ? redactSecrets(value) : value))
  const record = JSON.parse(json) as Record<string, unknown>
  const taskId = typeof record.taskId === 'string' ? record.taskId : undefined
  const handle = taskId ? piSessions.get(taskId) : undefined
  const capturePhase = taskId ? capturing.get(taskId) : undefined
  if (capturePhase) record.phase = capturePhase
  else if (handle?.phase) record.phase = handle.phase
  if (handle?.stageInstanceId) record.stageInstanceId = handle.stageInstanceId
  if (capturePhase && handle && record.type === 'message_update') {
    const update = record.assistantMessageEvent as { type?: string; delta?: string } | undefined
    if (update?.type === 'text_delta' && update.delta) handle.deltas += update.delta
  }
  if (capturePhase && handle && record.type === 'message_end') {
    const message = record.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined
    if (message?.role === 'assistant') {
      if (message.stopReason === 'error') {
        handle.error = message.errorMessage || '模型流式输出异常结束'
      } else if (handle.error) {
        handle.error = undefined
      }
    }
  }
  if (record.type === 'agent_end' && handle && !capturePhase) handle.agentEndTexts = collectAssistantTexts(record)
  if (taskId && handle && d().providerForTask(taskId) === 'openai') {
    if (['message_end', 'agent_end'].includes(String(record.type))) d().updatePiUsage(taskId)
    if (record.type === 'tool_execution_end') d().emitTaskChanged(taskId)
  }
  // OpenAI 任务：Pi 事件 → 执行树 span
  if (
    taskId &&
    handle &&
    d().providerForTask(taskId) === 'openai' &&
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
    if (!d().piTraceBuilders.has(taskId)) {
      const task = d().store.getTask(taskId)
      if (task) {
        d().tracePipeline.beginTrace({
          traceId: taskId,
          kind: 'task',
          title: task.title,
          source: 'pi',
          ...(task.qoderModel ? { model: task.qoderModel } : {})
        })
        d().tracePipeline.ensureRootSpan(taskId, { type: 'task.run', name: '任务执行', meta: { source: 'pi' } })
        d().piTraceBuilders.set(taskId, new PiTraceBuilder(d().tracePipeline, taskId, 'task'))
      }
    }
    try {
      d().piTraceBuilders.get(taskId)?.onEvent(record)
    } catch {
      /* 忽略:trace 采集失败不能影响任务 */
    }
  }
  d().sendTaskEvent(record)
}

/** `agent_end.messages` → assistant 文本数组（实现阶段产物，与旧全局实现同一取法）。 */
function collectAssistantTexts(record: Record<string, unknown>): string[] {
  type PiMessage = { role?: string; content?: Array<{ type?: string; text?: string }> }
  if (!Array.isArray(record.messages)) return []
  return (record.messages as PiMessage[]).flatMap((message) =>
    message?.role === 'assistant' && Array.isArray(message.content)
      ? message.content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
      : []
  )
}

// ── Pi 模型配置同步 ──────────────────────────────────────────────────────────

export function syncPiModelConfig(): void {
  const profiles = d().readOpenAIProfiles()
  if (profiles.length === 0) return
  const agentDir = d().store.getSetting('piAgentDir') ?? getAgentDir()
  mkdirSync(agentDir, { recursive: true })
  const modelsPath = join(agentDir, 'models.json')
  const current = existsSync(modelsPath)
    ? (JSON.parse(readFileSync(modelsPath, 'utf8')) as Record<string, unknown>)
    : {}
  const providers =
    current.providers && typeof current.providers === 'object' && !Array.isArray(current.providers)
      ? (current.providers as Record<string, unknown>)
      : {}
  const providersNext: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(providers)) {
    if (key.startsWith('company-openai')) continue
    providersNext[key] = value
  }
  let wrote = false
  for (const profile of profiles) {
    if (!profile.baseUrl || !profile.model) continue
    const providerKey = profile.id ? `company-openai:${profile.id}` : 'company-openai'
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

// ── GUI UI 上下文 ────────────────────────────────────────────────────────────

function createGuiUI(taskId: string): ExtensionUIContext {
  const ui = {
    select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
      requestUi<string>('select', { title, options }, { ...opts, taskId }),
    confirm: async (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
      (await requestUi<boolean>('confirm', { title, message }, { ...opts, taskId })) ?? false,
    input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
      requestUi<string>('input', { title, placeholder }, { ...opts, taskId }),
    editor: (title: string, prefill?: string) => requestUi<string>('editor', { title, prefill }, { taskId }),
    notify: (message: string, type = 'info') =>
      emitPi({
        type: 'extension_ui_request',
        id: randomUUID(),
        method: 'notify',
        taskId,
        message,
        notificationType: type
      }),
    setStatus: (key: string, text?: string) =>
      emitPi({
        type: 'extension_ui_request',
        id: randomUUID(),
        method: 'setStatus',
        taskId,
        statusKey: key,
        statusText: text
      }),
    setTitle: (title: string) =>
      emitPi({ type: 'extension_ui_request', id: randomUUID(), method: 'setTitle', taskId, title }),
    setEditorText: (text: string) =>
      emitPi({ type: 'extension_ui_request', id: randomUUID(), method: 'set_editor_text', taskId, text }),
    pasteToEditor: (text: string) =>
      emitPi({ type: 'extension_ui_request', id: randomUUID(), method: 'set_editor_text', taskId, text }),
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

// ── Pi Session 生命周期 ──────────────────────────────────────────────────────

/**
 * 打开（或复用）某个任务的 Pi 会话并登记到注册表。
 *
 * 会话指针就一个：`task.piSessionPath`。它在阶段边界被 `forkPiStage` 换成新文件，
 * 所以「本阶段该用哪个会话」不需要额外状态 —— 只要别在 fork 之后才想起开会话。
 */
async function openPiTaskSession(taskId: string, context?: PiSessionContext): Promise<AgentSession> {
  const store = d().store
  const task = store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  const cwd = piWorkspaceCwd(taskId)
  const agentDir = store.getSetting('piAgentDir') ?? getAgentDir()
  const sessionDir = piSessionDir()
  const sessionFile = task.piSessionPath
  const sessionManager =
    sessionFile && existsSync(sessionFile)
      ? SessionManager.open(sessionFile, sessionDir, cwd)
      : SessionManager.create(cwd, sessionDir)
  const settingsManager = SettingsManager.create(cwd, agentDir)
  const require = createRequire(import.meta.url)
  const extension = require.resolve('@task-pipeline/pi-package')
  const additionalExtensionPaths = [extension]
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths })
  await resourceLoader.reload({
    resolveProjectTrust: async () => {
      if (!hasTrustRequiringProjectResources(cwd)) return true
      const trustStore = new ProjectTrustStore(agentDir)
      const saved = trustStore.get(cwd)
      if (saved !== null) return saved
      const choice = await requestUi<string>(
        'select',
        {
          title: '信任项目配置',
          options: ['信任并记住', '仅本次信任', '不信任'],
          message: `仓库 ${cwd} 包含项目级 Pi Extension、Skill 或配置。仅信任你确认过的代码仓库。`
        },
        { taskId }
      )
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
  const profiles = d().readOpenAIProfiles()
  if (profiles.length > 0) {
    for (const profile of profiles) {
      const providerKey = profile.id ? `company-openai:${profile.id}` : 'company-openai'
      const apiKey = d().openAIApiKeyFor(profile)
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
  const session = created.session
  const handle = {
    taskId,
    session,
    sessionFile: session.sessionFile,
    unsubscribe: undefined as (() => void) | undefined,
    deltas: '',
    agentEndTexts: [] as string[],
    error: undefined as string | undefined,
    stageInstanceId: context?.stageInstanceId,
    phase: context?.phase
  }
  piSessions.set(taskId, handle)
  await session.bindExtensions({
    uiContext: createGuiUI(taskId),
    mode: 'rpc',
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      // P3：解除「一律 `{ cancelled: true }`」的桩。这三个 action 的调用方是 Pi 内置命令
      // （用户在任务输入框里敲 `/new`、`/fork`），不是阶段边界；阶段间 fork 由编排层
      // `PiTaskAgent.runStage` 调 `forkPiStage` 完成。这里只保证「用户主动喊新建/分叉」
      // 真能落到会话层，而不是只弹一句「已新建上下文」的 toast。
      newSession: async () => {
        await releasePiSession(taskId)
        store.updateTask(taskId, { piSessionPath: undefined })
        await openPiTaskSession(taskId, context)
        return { cancelled: false }
      },
      fork: async () => {
        const forked = await forkPiStage(taskId)
        // 只能看 `.file`：`forkPiStage` 现在失败时返回 `{ error }`（truthy），
        // 按对象本身判空会永远当成成功 → 不换会话文件却重开会话，对外报「已分叉」。
        if (!forked.file) return { cancelled: true }
        await openPiTaskSession(taskId, context)
        return { cancelled: false }
      },
      navigateTree: (targetId, options) => session.navigateTree(targetId, options),
      // 切换历史会话需要一个会话列表 UI，桌面端没有：依旧显式取消（不假装成功）。
      switchSession: async () => ({ cancelled: true }),
      reload: () => session.reload()
    },
    abortHandler: () => {
      void session.abort()
    },
    shutdownHandler: () => {
      void releasePiSession(taskId)
    },
    onError: (error) => emitPi({ type: 'extension_error', taskId, ...error })
  })
  handle.unsubscribe = session.subscribe((event) => emitPi({ ...(event as object), taskId }))
  store.updateTask(taskId, { piSessionPath: session.sessionFile })
  handle.sessionFile = session.sessionFile
  emitPi({
    type: 'session_ready',
    taskId,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    ...(handle.stageInstanceId ? { stageInstanceId: handle.stageInstanceId } : {}),
    diagnostics: created.extensionsResult.errors
  })
  return session
}
