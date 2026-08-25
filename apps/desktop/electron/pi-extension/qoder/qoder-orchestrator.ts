/**
 * Qoder 编排器 — 封装所有 Qoder SDK 相关的任务编排逻辑。
 *
 * 从 main.ts 提取：
 *  - createQoderTaskAgent + qoderTaskAgent 单例
 *  - runQoder / runQoderPlan / runQoderTestCases
 *  - probeQoderStatus / getQoderStatus
 *  - callQoderReviewer / callQoderForAgentGeneration（从 task-runner.ts 迁入）
 *  - 会话管理（stop / pause / interrupt / closeSession）
 *
 * main.ts 只保留 provider 路由 + Pi 路径编排。
 */

import {
  accessToken,
  query,
  QoderCliProcessError,
  type AccountInfo,
  type ModelInfo,
  type Query,
  type UsageInfo
} from '@qoder-ai/qoder-agent-sdk'
import type { Task, TaskState, TaskStore, AgentEvent } from '@task-pipeline/core'
import type { TaskWorkflow, OpenAICompatReviewer } from '@task-pipeline/integrations'
import { isDangerousTool, describeToolAction } from '../../agents/task-agent/dangerous-tools.js'
import { parseTestCaseGeneration } from '../../agents/task-agent/parsers/test-case-parser.js'
import type { TracePipeline } from '../../trace/bus/trace-pipeline.js'
import type { AgentService } from '../../agents/agent-service.js'
import type { MemoryService } from '../../memory/memory-service.js'
import type { QoderTaskAgentDeps } from './qoder-task-agent.js'
import { QoderTaskAgentDriver, stripQoderModelPrefix } from './qoder-task-agent.js'
import { recordQoderMessage } from './log.js'

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type QoderStatus = {
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

export type TestCaseGenerationResult = { files: string[]; commitSha?: string; summary: string }

// ── 依赖接口 ─────────────────────────────────────────────────────────────────

export interface QoderOrchestratorDeps {
  // 核心存储
  store: TaskStore
  dataDir: string
  taskWorkflow: TaskWorkflow
  memoryService: MemoryService
  agentService: AgentService
  tracePipeline: TracePipeline
  openAIReviewer: OpenAICompatReviewer

  // 事件通道
  addTaskEvent: (event: Omit<AgentEvent, 'id' | 'createdAt'>) => void
  emitPi: (event: unknown) => void
  sendTaskEvent: (event: Record<string, unknown>) => void

  // 凭据
  protectedValue: (key: string) => string | undefined
  updateCredential: (kind: 'qoder' | 'gitlab' | 'jira' | 'confluence', state: Record<string, unknown>) => void

  // UI 交互
  requestUi: <T>(
    method: string,
    payload: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => Promise<T | undefined>
  handleAskUserQuestion: (
    toolInput: Record<string, unknown>,
    options: { signal?: AbortSignal; taskId?: string }
  ) => Promise<string[] | undefined>

  // 任务状态
  updateState: (task: Task, state: TaskState) => Task
  runTaskOperation: <T>(taskId: string, action: (signal: AbortSignal) => Promise<T>) => Promise<T>

  // 路由
  runtimeProvider: (task: Task) => string
  providerForTask: (taskId: string | undefined) => string

  // Agent 上下文
  resolveAgentContext: QoderTaskAgentDeps['resolveAgentContext']
  resolveModel: QoderTaskAgentDeps['resolveModel']
  resolveTestContext: QoderTaskAgentDeps['resolveTestContext']
  resolveMemoryContext: QoderTaskAgentDeps['resolveMemoryContext']

  // HITL
  getHitlMode: (contextType: 'conversation' | 'task', contextId?: string) => string

  // 共享状态读写（activeTaskId 由 main.ts 拥有，orchestrator 需读写）
  getActiveTaskId: () => string | undefined
  setActiveTaskId: (id: string | undefined) => void

  // 实现完成回调（由 main.ts 提供，因涉及 Pi 路径共享的 finishImplementation）
  finishImplementation: (taskId: string, responseTexts: string[], signal?: AbortSignal) => Promise<void>

  // 计划保存（task-runner.ts 的 savePlanDecision）
  savePlanDecision: (taskId: string, texts: string[]) => Promise<unknown>

  // OpenAI 相关（resolveLiteModel 的 OpenAI 回落路径）
  resolveOpenAIModelValue: () => string
  syncSystemDefaultModel: () => { provider?: string; model?: string } | undefined
  storeGetSetting: (key: string) => string | undefined

  // Review 辅助
  taskChangedFiles: (
    taskId: string,
    excludeUnchanged?: boolean
  ) => Promise<Array<{ path: string; status: string; repositoryName: string }>>
}

// ── 编排器类 ─────────────────────────────────────────────────────────────────

export class QoderOrchestrator {
  private readonly deps: QoderOrchestratorDeps
  private readonly agent: QoderTaskAgentDriver

  // Qoder 专属状态
  private _activeQuery: Query | undefined
  private _activeAbort: AbortController | undefined
  private _activePlanningTaskId: string | undefined
  private _activePlanText = ''

  // 状态探测缓存
  private _statusInflight: Promise<QoderStatus> | null = null
  private _statusCache: { at: number; token: string; status: QoderStatus } | null = null

  constructor(deps: QoderOrchestratorDeps) {
    this.deps = deps
    this.agent = this.createAgent()
  }

  // ── 公共 getter ──────────────────────────────────────────────────────────

  get activeQuery(): Query | undefined {
    return this._activeQuery
  }

  get activeAbort(): AbortController | undefined {
    return this._activeAbort
  }

  get activePlanningTaskId(): string | undefined {
    return this._activePlanningTaskId
  }

  get activePlanText(): string {
    return this._activePlanText
  }

  set activePlanText(value: string) {
    this._activePlanText = value
  }

  get taskAgent(): QoderTaskAgentDriver {
    return this.agent
  }

  // ── Agent 工厂 ───────────────────────────────────────────────────────────

  private createAgent(): QoderTaskAgentDriver {
    const {
      store,
      dataDir,
      addTaskEvent,
      emitPi,
      tracePipeline,
      resolveAgentContext,
      resolveModel,
      resolveTestContext,
      resolveMemoryContext
    } = this.deps
    return new QoderTaskAgentDriver({
      store,
      qoderTokenProvider: () => this.deps.protectedValue('qoderToken'),
      dataDir,
      addTaskEvent,
      emitPi,
      tracePipeline,
      emit: (event) => {
        if (event.type === 'agent_session') {
          const taskId = event.taskId || this.deps.getActiveTaskId()
          if (taskId) store.updateTask(taskId, { qoderSessionId: event.sessionId })
        }
        if (event.type === 'agent_start' || event.type === 'agent_end') {
          emitPi({ type: event.type, provider: 'qoder', taskId: this.deps.getActiveTaskId(), phase: event.phase })
          return
        }
        if (event.type === 'agent_text' && this.deps.getActiveTaskId()) {
          addTaskEvent({
            taskId: this.deps.getActiveTaskId()!,
            kind: 'message',
            title: 'Qoder Agent',
            detail: event.text
          })
          return
        }
        if (event.type === 'agent_error' && this.deps.getActiveTaskId()) {
          addTaskEvent({
            taskId: this.deps.getActiveTaskId()!,
            kind: 'error',
            title: 'Qoder Agent 错误',
            detail: event.message
          })
        }
      },
      resolveMemoryContext,
      resolveAgentContext,
      resolveModel,
      resolveTestContext,
      onQueryStarted: (q, abort) => {
        this._activeQuery = q
        this._activeAbort = abort
      },
      onQueryFinished: (q) => {
        if (this._activeQuery === q) this._activeQuery = undefined
        if (this._activeAbort?.signal === undefined) this._activeAbort = undefined
      },
      onPermissionRequest: async (taskId, toolName, toolInput, signal) => {
        if (toolName === 'AskUserQuestion' && toolInput && typeof toolInput === 'object') {
          const answers = await this.deps.handleAskUserQuestion(toolInput as Record<string, unknown>, {
            signal,
            taskId
          })
          if (answers && answers.length > 0) {
            return { type: 'askUser' as const, answers }
          }
          return { type: 'deny' as const, message: '用户取消了问答，请选择其他方式继续任务' }
        }
        const hitlMode = this.deps.getHitlMode('task', taskId)
        if (hitlMode === 'yolo') return 'allow'
        if (!isDangerousTool(toolName, toolInput)) return 'allow'
        const detail = describeToolAction(toolName, toolInput)
        const task = store.getTask(taskId)
        const approval = store.addApproval({ taskId, kind: 'permission', context: detail })
        addTaskEvent({ taskId, kind: 'permission', title: `请求执行破坏性操作:${toolName}`, detail })
        const ok =
          (await this.deps.requestUi<boolean>(
            'confirm',
            {
              title: `允许执行 ${toolName}?`,
              message: `${task?.title ?? ''}\n\n${detail}`,
              taskId,
              toolName,
              toolInput: typeof toolInput === 'object' && toolInput !== null ? toolInput : {}
            },
            { signal }
          )) ?? false
        store.resolveApproval(approval.id, ok ? 'approved' : 'rejected')
        return ok ? 'allow' : 'deny'
      }
    })
  }

  // ── 实现执行 ─────────────────────────────────────────────────────────────

  async run(
    taskId: string,
    extraPrompt?: string,
    signal?: AbortSignal,
    resumeSessionId?: string,
    traceMark?: { trigger?: 'resume' | 'followup'; round?: number }
  ): Promise<void> {
    const task = await this.deps.taskWorkflow.prepare(taskId, signal)
    const repos = this.deps.store.listTaskRepositories(task.id)
    if (repos.length === 0) throw new Error('任务未关联代码仓库')
    this.deps.setActiveTaskId(task.id)
    signal?.throwIfAborted()
    this.deps.addTaskEvent({
      taskId,
      kind: 'status',
      title: '执行环境:Qoder Agent SDK',
      detail: '使用应用随附运行时,并在已配置仓库目录中执行'
    })
    try {
      await this.agent.runImplementation({
        task,
        repos,
        signal,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(extraPrompt ? { extraPrompt } : {}),
        ...(traceMark?.trigger ? { trigger: traceMark.trigger } : {}),
        ...(traceMark?.round !== undefined ? { round: traceMark.round } : {})
      })
      const { responseTexts } = this.agent.collectResult(taskId, 'implementation')
      await this.deps.finishImplementation(task.id, responseTexts, signal)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const current = this.deps.store.getTask(task.id)
      if (current?.state === 'paused') return
      this.deps.addTaskEvent({ taskId, kind: 'error', title: 'Qoder 执行失败', detail })
      if (['implementing', 'validating'].includes(current?.state ?? '')) this.deps.updateState(current!, 'failed')
      this.deps.emitPi({ type: 'agent_error', taskId, message: detail })
    }
  }

  // ── 计划生成 ─────────────────────────────────────────────────────────────

  async runPlan(
    taskId: string,
    feedback?: string,
    signal?: AbortSignal,
    trigger?: 'resume' | 'followup'
  ): Promise<void> {
    const task = this.deps.store.getTask(taskId)
    if (!task || task.state !== 'planning') throw new Error('当前任务不能生成计划')
    const repos = this.deps.store.listTaskRepositories(task.id)
    if (repos.length === 0) throw new Error('任务未关联代码仓库')

    this.deps.setActiveTaskId(task.id)
    this._activePlanningTaskId = task.id
    this._activePlanText = ''
    signal?.throwIfAborted()
    try {
      await this.agent.runPlan({
        task,
        repos,
        signal,
        ...(feedback ? { feedback } : {}),
        ...(trigger ? { trigger } : {})
      })
      const { responseTexts } = this.agent.collectResult(taskId, 'plan')
      await this.deps.savePlanDecision(taskId, responseTexts)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.deps.addTaskEvent({ taskId, kind: 'error', title: '计划生成失败', detail })
      this.agent.interruptSession(taskId)
      const current = this.deps.store.getTask(taskId)
      if (current?.state === 'planning') {
        this.deps.store.updateTask(taskId, { failureStage: 'planning' })
        this.deps.updateState(current, 'failed')
      }
      throw error
    } finally {
      this._activePlanningTaskId = undefined
    }
  }

  // ── 测试用例生成 ─────────────────────────────────────────────────────────

  async runTestCases(taskId: string, signal?: AbortSignal): Promise<TestCaseGenerationResult> {
    const task = this.deps.store.getTask(taskId)
    if (!task || task.state !== 'generating_tests') throw new Error('当前任务不能生成测试用例')
    const repos = this.deps.store.listTaskRepositories(task.id)
    if (repos.length === 0) throw new Error('任务未关联代码仓库')
    this.deps.setActiveTaskId(task.id)
    this.deps.addTaskEvent({ taskId, kind: 'status', title: '正在生成测试用例' })
    signal?.throwIfAborted()
    if (!this.agent.runTestGeneration) throw new Error('当前 Agent 运行时不支持测试用例生成')
    await this.agent.runTestGeneration({ task, repos, signal })
    const { responseTexts } = this.agent.collectResult(taskId, 'test')
    return parseTestCaseGeneration(responseTexts)
  }

  // ── 续接 / 恢复 ──────────────────────────────────────────────────────────

  async resume(taskId: string, signal?: AbortSignal): Promise<void> {
    const task = await this.deps.taskWorkflow.prepare(taskId, signal)
    this.deps.store.updateTask(taskId, { sessionUsage: undefined })
    await this.run(taskId, RESUME_INSTRUCTION, signal, task.qoderSessionId, { trigger: 'resume' })
  }

  async resumePaused(taskId: string, signal?: AbortSignal): Promise<void> {
    const task = this.deps.store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    await this.run(taskId, RESUME_INSTRUCTION, signal, task.qoderSessionId, { trigger: 'resume' })
  }

  // ── 计划审批 / 修订 ──────────────────────────────────────────────────────

  async approvePlan(taskId: string, signal?: AbortSignal): Promise<void> {
    await this.run(taskId, undefined, signal)
  }

  async revisePlan(taskId: string, feedback: string, signal?: AbortSignal): Promise<void> {
    await this.runPlan(taskId, feedback, signal)
  }

  // ── 消息发送 ─────────────────────────────────────────────────────────────

  async sendMessage(taskId: string, message: string, signal?: AbortSignal): Promise<void> {
    await this.run(taskId, message, signal, undefined, { trigger: 'followup' })
  }

  // ── Review 自动修订 ──────────────────────────────────────────────────────

  async runAutoFix(taskId: string, fixPrompt: string, signal?: AbortSignal, round?: number): Promise<void> {
    await this.run(taskId, fixPrompt, signal, undefined, { round })
  }

  // ── 操作 Agent（Review / MR 描述等短文本） ─────────────────────────────

  async callReviewer(
    prompt: string,
    taskId: string,
    model?: string,
    signal?: AbortSignal,
    onMessage?: (message: unknown) => void
  ): Promise<string> {
    const token = this.deps.protectedValue('qoderToken')
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
            recordQoderMessage(this.deps.store, taskId, message, {
              recordText: true,
              addTaskEvent: this.deps.addTaskEvent,
              emitPi: this.deps.emitPi
            })
            onMessage?.(message)
            if (message.type === 'assistant') {
              const content = (message as unknown as { message?: { content?: Array<{ type: string; text?: string }> } })
                .message?.content
              if (Array.isArray(content))
                text += content
                  .filter((c) => c?.type === 'text' && c.text)
                  .map((c) => c.text!)
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

  async callForAgentGeneration(
    prompt: string,
    model: string,
    options: { additionalDirectories?: string[]; signal?: AbortSignal; onMessage?: (message: unknown) => void } = {}
  ): Promise<string> {
    const { additionalDirectories = [], signal, onMessage } = options
    const token = this.deps.protectedValue('qoderToken')
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
    const AGENT_GENERATION_TIMEOUT_MS = 120_000
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
                  .map((c) => c.text!)
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

  // ── 状态探测 ─────────────────────────────────────────────────────────────

  async getStatus(): Promise<QoderStatus> {
    const token = this.deps.protectedValue('qoderToken')
    if (!token) {
      this.deps.updateCredential('qoder', { status: 'skipped', message: '未配置', checkedAt: Date.now() })
      if (this._statusCache?.status && (this._statusCache.status.enabled || this._statusCache.status.connected))
        this.deps.sendTaskEvent({ type: 'qoder_status_changed' })
      this._statusCache = {
        at: Date.now(),
        token: '',
        status: { enabled: false, connected: false, running: false, models: [] }
      }
      return { enabled: false, connected: false, running: false, models: [] }
    }
    if (this._statusCache && this._statusCache.token === token && Date.now() - this._statusCache.at < 30_000) {
      return this._statusCache.status
    }
    if (this._statusInflight) return this._statusInflight
    this._statusInflight = this.probeStatus().finally(() => {
      this._statusInflight = null
    })
    const status = await this._statusInflight
    const prev = this._statusCache?.status
    if (prev && (prev.connected !== status.connected || prev.enabled !== status.enabled))
      this.deps.sendTaskEvent({ type: 'qoder_status_changed' })
    this._statusCache = { at: Date.now(), token, status }
    this.deps.updateCredential(
      'qoder',
      status.connected
        ? { status: 'ok', message: undefined, checkedAt: Date.now() }
        : { status: 'failed', message: status.error ?? '连接失败', checkedAt: Date.now() }
    )
    return status
  }

  getStatusForHealth(): Promise<QoderStatus> {
    return this.getStatus()
  }

  /** 同步返回缓存的状态（未探测过返回 undefined）。供 syncSystemDefaultModel / isModelValueAvailable 等同步路径使用。 */
  getCachedStatus(): QoderStatus | undefined {
    return this._statusCache?.status
  }

  private async probeStatus(): Promise<QoderStatus> {
    const token = this.deps.protectedValue('qoderToken')
    if (!token) return { enabled: false, connected: false, running: false, models: [] }
    const probeAbort = this._activeQuery ? undefined : new AbortController()
    const q =
      this._activeQuery ??
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
        running: Boolean(this._activeQuery),
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
      const message =
        error instanceof QoderCliProcessError && error.stderr
          ? `${error.message}\n\nqodercli stderr (tail):\n${error.stderr.trim().slice(-2000)}`
          : error instanceof Error
            ? error.message
            : String(error)
      return {
        enabled: true,
        connected: false,
        running: Boolean(this._activeQuery),
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

  // ── 会话管理 ─────────────────────────────────────────────────────────────

  async stop(
    taskId: string,
    markFailed: boolean
  ): Promise<{ abortedQuery?: Query; abortedController?: AbortController }> {
    const result = { abortedQuery: this._activeQuery, abortedController: this._activeAbort }
    this.agent.closeSession(taskId)
    this._activeAbort?.abort(new Error(markFailed ? '任务已停止' : '任务已删除'))
    this._activeAbort = undefined
    try {
      await this._activeQuery?.interrupt()
    } catch {
      /* The query may already be closed. */
    }
    return result
  }

  async pause(taskId: string): Promise<void> {
    this._activeAbort?.abort(new Error('任务已暂停'))
    this.agent.interruptSession(taskId)
  }

  interruptSession(taskId: string): void {
    this.agent.interruptSession(taskId)
  }

  closeSession(taskId: string): void {
    this.agent.closeSession(taskId)
  }

  resetSessionUsage(taskId: string): void {
    this.deps.store.updateTask(taskId, { sessionUsage: undefined })
  }

  collectResult(taskId: string, phase: 'implementation' | 'plan' | 'test') {
    return this.agent.collectResult(taskId, phase)
  }

  // ── Lite 模型解析 ────────────────────────────────────────────────────────

  async resolveLiteModel(): Promise<string> {
    try {
      const status = await this.getStatus()
      const enabled = status.models.filter((m) => m.isEnabled !== false)
      const free = enabled.find((m) => {
        const name = `${m.value} ${m.displayName ?? ''}`.toLowerCase()
        return m.priceFactor === 0 || name.includes('lite')
      })
      if (free?.value) return free.value
      const pick = enabled.find((m) => m.isDefault) ?? enabled[0]
      if (pick?.value) return pick.value
    } catch {
      /* 静默回落到默认 */
    }
    const legacy = this.deps.storeGetSetting('defaultModel')
    if (legacy) return legacy
    const system = this.deps.syncSystemDefaultModel()
    if (system?.provider === 'qoder') return system.model!.replace(/^qoder:/, '')
    return 'claude-sonnet-4.5'
  }
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

const RESUME_INSTRUCTION =
  '任务此前执行失败/中断。请先检查当前工作区与代码状态（已完成的改动应保留），定位失败原因后继续完成剩余工作；不要重新执行已完成的部分，也不要重复安装依赖或重建环境。'

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

async function* holdQoderProbe(signal: AbortSignal): AsyncGenerator<never> {
  if (signal.aborted) return
  yield (await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true })
  )) as never
}

export { stripQoderModelPrefix }
