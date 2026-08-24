/**
 * Pi session 管理 + UI 请求桥接：
 *  - requestUi / emitPi：主进程 ↔ 渲染进程的 UI 交互桥（HITL 确认、AskUserQuestion 等）
 *  - startPi / stopPi：Pi Agent Session 生命周期
 *  - syncPiModelConfig：把 OpenAI profile 同步到 Pi 的 models.json
 *  - createGuiUI：为 Pi Extension 提供 GUI 上下文
 *  - handleAskUserQuestion / prettyToolName：HITL 辅助工具
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
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
  providerForTask: (taskId: string | undefined) => 'qoder' | 'openai'
  updatePiUsage: (taskId: string) => void
  emitTaskChanged: (taskId: string) => void
  sendTaskEvent: (event: Record<string, unknown>) => void
  /** 任务终态回调：agent_end 时触发 finishImplementation */
  onFinishImplementation: (taskId: string, responseTexts: string[]) => void
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

// ── 共享状态 ─────────────────────────────────────────────────────────────────

let piSession: AgentSession | undefined
let unsubscribePi: (() => void) | undefined
const pendingUi = new Map<string, (response: Record<string, unknown>) => void>()

/** 当前正在执行任务的 taskId（OpenAI 路径使用） */
let activeTaskId: string | undefined
/** 正在生成计划的 taskId（planning 期间） */
let activePlanningTaskId: string | undefined
/** planning 期间累积的计划文本 */
let activePlanText = ''
/** planning 期间最近一次 assistant 错误消息 */
let activePlanError: string | undefined

export function getActiveTaskId(): string | undefined {
  return activeTaskId
}
export function setActiveTaskId(id: string | undefined): void {
  activeTaskId = id
}
export function getActivePlanningTaskId(): string | undefined {
  return activePlanningTaskId
}
export function setActivePlanningTaskId(id: string | undefined): void {
  activePlanningTaskId = id
}
export function getActivePlanText(): string {
  return activePlanText
}
export function setActivePlanText(text: string): void {
  activePlanText = text
}
export function getActivePlanError(): string | undefined {
  return activePlanError
}
export function setActivePlanError(error: string | undefined): void {
  activePlanError = error
}
export function getPiSession(): AgentSession | undefined {
  return piSession
}
export function getPendingUi(): Map<string, (response: Record<string, unknown>) => void> {
  return pendingUi
}

// ── UI 请求桥接 ──────────────────────────────────────────────────────────────

export function requestUi<T>(
  method: string,
  payload: Record<string, unknown>,
  options?: ExtensionUIDialogOptions
): Promise<T | undefined> {
  const id = randomUUID()
  return new Promise((resolve) => {
    let abortListener: () => void = () => undefined
    const finish = (response: Record<string, unknown>) => {
      if (options?.signal) options.signal.removeEventListener('abort', abortListener)
      pendingUi.delete(id)
      if (response.cancelled) resolve(undefined)
      else if (method === 'confirm') resolve(Boolean(response.confirmed) as T)
      else resolve(response.value as T | undefined)
    }
    pendingUi.set(id, finish)
    emitPi({ type: 'extension_ui_request', id, method, ...payload })
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

export function emitPi(event: unknown): void {
  const json = JSON.stringify(event, (_key, value) => (typeof value === 'string' ? redactSecrets(value) : value))
  const record = JSON.parse(json) as Record<string, unknown>
  if (activePlanningTaskId && record.type === 'message_update') {
    const update = record.assistantMessageEvent as { type?: string; delta?: string } | undefined
    if (update?.type === 'text_delta' && update.delta) activePlanText += update.delta
  }
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
    d().providerForTask(activeTaskId) === 'openai' &&
    ['message_end', 'agent_end'].includes(String(record.type))
  )
    d().updatePiUsage(activeTaskId)
  if (activeTaskId && record.type === 'tool_execution_end') d().emitTaskChanged(activeTaskId)
  // OpenAI 任务：Pi 事件 → 执行树 span
  if (
    activeTaskId &&
    d().providerForTask(activeTaskId) === 'openai' &&
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
  d().sendTaskEvent(typeof record.taskId === 'string' || !activeTaskId ? record : { ...record, taskId: activeTaskId })
  if (
    record.type === 'agent_end' &&
    activeTaskId &&
    !activePlanningTaskId &&
    d().providerForTask(activeTaskId) === 'openai'
  ) {
    const taskId = activeTaskId
    type PiMessage = { role?: string; content?: Array<{ type?: string; text?: string }> }
    const responseTexts = Array.isArray(record.messages)
      ? (record.messages as PiMessage[]).flatMap((message) =>
          message?.role === 'assistant' && Array.isArray(message.content)
            ? message.content
                .filter((block) => block?.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text as string)
            : []
        )
      : []
    void Promise.resolve(d().onFinishImplementation(taskId, responseTexts)).catch((error) =>
      emitPi({ type: 'agent_error', message: error instanceof Error ? error.message : String(error) })
    )
  }
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

// ── Pi Session 生命周期 ──────────────────────────────────────────────────────

export async function stopPi(): Promise<void> {
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

export async function startPi(taskId: string): Promise<void> {
  await stopPi()
  const store = d().store
  const dataDir = d().dataDir
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
  piSession = created.session
  const session = piSession!
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
