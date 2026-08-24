/**
 * 任务生命周期：状态流转 + 执行流程 + 计划/校验/Review 全链路。
 *
 * 从 main.ts 提取的核心任务逻辑：
 *  - 状态流转：updateState / taskStateLabels
 *  - 执行流程：startTask / resumeTask / pauseTask / resumePausedTask / cancelTask / deleteTask
 *  - 计划流程：runOpenAIPlan / failPlanGeneration / approveTaskPlan / reviseTaskPlan
 *  - 实现收尾：finishImplementation / runReviewWithAutoFix / runTestCaseGenerationThenValidate
 *  - 辅助：buildAgentPrompt / qoderTokenGuard / runOperationAgent / taskChangedFiles 等
 *
 * 通过 initTaskLifecycle(deps) 注入共享依赖，避免循环引用。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Task, TaskState, TaskStore, TaskRepository, TaskStartMode, AgentEvent } from '@task-pipeline/core'
import { JsonlTraceStorage, summarizeTrace, traceEventsDir, traceInfoFile, transitionTask } from '@task-pipeline/core'
import { openTaskEditor } from '@task-pipeline/integrations'
import type {
  AtlassianClientFactory,
  DeliveryService,
  GitService,
  MergeStatusRefresher,
  OpenAICompatReviewer,
  ReviewOrchestrator,
  TaskCompleter,
  TaskWorkflow,
  RepositoryCommandMap
} from '@task-pipeline/integrations'
import type { AgentService, OperationKind } from '../agents/agent-service.js'
import type { QoderOrchestrator } from '../pi-extension/qoder/index.js'
import { closeQoderQuerySafely } from '../pi-extension/qoder/index.js'
import type { TracePipeline } from '../trace/bus/trace-pipeline.js'
import type { PiTraceBuilder } from '../trace/instrument/pi-trace-builder.js'
import type { TraceService } from '../trace/trace-service.js'
import type { MemoryService } from '../memory/memory-service.js'
import { consolidateTaskMemory } from '../memory/memory-context.js'
import { stripOpenAIModelPrefix, resolveLiteModel } from '../chat/model-profile.js'
import {
  implementationOutcomeInstruction,
  isExplicitNoChangeCompletionRequest,
  nextStepForImplementation,
  parseImplementationDecision
} from './task-readiness.js'
import {
  callOpenAIForPrompt,
  savePlanDecision,
  advanceAfterValidation,
  runTestCoverageCheck,
  reviewAutoFixEnabled,
  reviewAutoFixMaxRounds,
  collectReviewComments,
  buildReviewFixPrompt
} from './task-runner.js'
import {
  emitPi,
  startPi,
  stopPi,
  getActiveTaskId,
  setActiveTaskId as _setActiveTaskId,
  setActivePlanningTaskId,
  setActivePlanText,
  getActivePlanText,
  setActivePlanError,
  getActivePlanError,
  getPiSession
} from './pi-session.js'

// ── 依赖注入 ─────────────────────────────────────────────────────────────────

interface TaskLifecycleDeps {
  store: TaskStore
  dataDir: string
  tracePipeline: TracePipeline
  traceService: TraceService
  memoryService: MemoryService
  agentService: AgentService
  taskWorkflow: TaskWorkflow
  gitService: GitService
  deliveryService: DeliveryService
  mergeRefresher: MergeStatusRefresher
  taskCompleter: TaskCompleter
  atlassianFactory: AtlassianClientFactory
  qoderOrch: QoderOrchestrator
  openAIReviewer: OpenAICompatReviewer
  piTraceBuilders: Map<string, PiTraceBuilder>
  protectedValue: (key: string) => string | undefined
  providerForTask: (taskId: string | undefined) => 'qoder' | 'openai'
  runtimeProvider: (task: Task) => 'qoder' | 'openai'
  modelProvider: () => 'qoder' | 'openai'
  addTaskEvent: (event: Omit<AgentEvent, 'id' | 'createdAt'>) => void
  emitTaskChanged: (taskId: string) => void
  sendTaskEvent: (event: Record<string, unknown>) => void
  updatePiUsage: (taskId: string) => void
  buildReviewOrchestrator: () => ReviewOrchestrator
  submitMergeRequestsWithCredentialWatch: (taskId: string, signal?: AbortSignal) => Promise<void>
  resolveOpenAIModelValue: () => string
  defaultOpenAIProfile: () =>
    | { baseUrl?: string; model?: string; vendor?: string; id?: string; isDefault?: boolean }
    | undefined
  openAIApiKeyFor: (profile: { baseUrl?: string; model?: string; vendor?: string }) => string | undefined
}

let deps: TaskLifecycleDeps | null = null

export function initTaskLifecycle(d: TaskLifecycleDeps): void {
  deps = d
}

function d(): TaskLifecycleDeps {
  if (!deps) throw new Error('task-lifecycle not initialized')
  return deps
}

// ── 任务状态标签 ─────────────────────────────────────────────────────────────

export const taskStateLabels: Record<Task['state'], string> = {
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

// ── 通用工具 ─────────────────────────────────────────────────────────────────

export function taskWorkspace(taskId: string): string {
  return join(d().dataDir, 'workspaces', taskId)
}

export function updateState(task: Task, state: Task['state']): Task {
  if (task.state !== state) transitionTask(task.state, state)
  const updated = d().store.updateTask(task.id, { state })
  d().addTaskEvent({ taskId: task.id, kind: 'status', title: `状态更新为 ${taskStateLabels[state]}` })
  if (['failed', 'completed', 'cancelled'].includes(state)) {
    d().qoderOrch.closeSession(task.id)
  }
  return updated
}

// ── 在途操作管理 ─────────────────────────────────────────────────────────────

type ActiveTaskOperation = { controller: AbortController; promise: Promise<unknown> }
const activeTaskOperations = new Map<string, ActiveTaskOperation>()

export function getActiveTaskOperations(): Map<string, ActiveTaskOperation> {
  return activeTaskOperations
}

export function runTaskOperation<T>(taskId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
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

// ── 任务记忆整理 ─────────────────────────────────────────────────────────────

const taskMemoryPending = new Map<string, Promise<void>>()

// ── Trace 收尾 ───────────────────────────────────────────────────────────────

export function finalizeTaskTrace(taskId: string): void {
  d().qoderOrch.taskAgent?.finishTrace(taskId)
  d().piTraceBuilders.delete(taskId)
  if (d().tracePipeline.isActive(taskId)) {
    const task = d().store.getTask(taskId)
    const finalState = task?.state
    if (finalState === 'completed' || finalState === 'failed' || finalState === 'cancelled') {
      try {
        const finishSpan = d().tracePipeline.startSpan(taskId, {
          type: 'agent.run',
          name: 'Finish',
          meta: { source: d().providerForTask(taskId) === 'qoder' ? 'qoder' : 'pi', phase: 'finish', finalState }
        })
        d().tracePipeline.endSpan(taskId, finishSpan)
      } catch {
        /* trace 收尾失败不影响任务 */
      }
    }
  }
  const memoryPending = taskMemoryPending.get(taskId)
  if (memoryPending) {
    void memoryPending.then(() => d().tracePipeline.endTrace(taskId))
    return
  }
  d().tracePipeline.endTrace(taskId)
}

// ── Agent Prompt & Token Guard ───────────────────────────────────────────────

async function buildAgentPrompt(task: Task, body: string): Promise<string> {
  const repos = d().store.listTaskRepositories(task.id)
  const sections = (await d().agentService.resolveAgentContext(task, repos)).sections
  if (sections.length)
    d().addTaskEvent({ taskId: task.id, kind: 'status', title: '注入 Agent 上下文', detail: sections.join('\n\n') })
  return `${sections.length ? `${sections.join('\n\n')}\n\n` : ''}${body}`
}

function qoderTokenGuard(task: Task): void {
  if (d().runtimeProvider(task) !== 'qoder' || d().protectedValue('qoderToken')) return
  const agent = d().agentService.resolveAgentFor(
    d().store.listTaskRepositories(task.id)[0]?.repositoryId ?? '',
    task.agentProfileId,
    task.repoAgentIds?.[d().store.listTaskRepositories(task.id)[0]?.repositoryId ?? '']
  )
  throw new Error(
    agent
      ? `Agent「${agent.name}」指定了 Qoder 模型，请先配置 Qoder Token`
      : '任务路由到 Qoder 路径，请先配置 Qoder Token'
  )
}

// ── 操作子 Agent 执行器 ──────────────────────────────────────────────────────

export async function runOperationAgent(
  taskId: string,
  operation: OperationKind,
  body: string,
  signal?: AbortSignal
): Promise<string> {
  const task = d().store.getTask(taskId)
  if (!task) return ''
  const repos = d().store.listTaskRepositories(taskId)
  const { roleAgent, roleBody, contextBody } = d().agentService.resolveOperationAgent(operation, task, repos)
  if (!roleAgent || !roleBody) return ''
  const prompt = [roleBody, contextBody, body].filter(Boolean).join('\n\n')
  if (d().providerForTask(taskId) !== 'qoder') {
    return callOpenAIForPrompt(prompt, taskId, stripOpenAIModelPrefix(roleAgent.preferredModel), signal)
  }
  const model = operation === 'mr' ? await resolveLiteModel('qoder') : roleAgent.preferredModel
  return d().qoderOrch.callReviewer(prompt, taskId, model, signal)
}

// ── 计划生成 ─────────────────────────────────────────────────────────────────

async function runOpenAIPlan(taskId: string, prompt: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  setActivePlanningTaskId(taskId)
  setActivePlanText('')
  setActivePlanError(undefined)
  try {
    await startPi(taskId)
    if (!getPiSession()) throw new Error('OpenAI agent session is unavailable')
    await getPiSession()!.prompt(prompt, { source: 'rpc' })
    signal.throwIfAborted()
    const planError = getActivePlanError()
    if (planError) throw new Error(planError)
    const plan = getActivePlanText().trim()
    if (!plan) throw new Error('Agent 未返回有效计划')
    await savePlanDecision(taskId, [plan])
  } finally {
    setActivePlanningTaskId(undefined)
    setActivePlanError(undefined)
  }
}

function failPlanGeneration(taskId: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  const current = d().store.getTask(taskId)
  if (current?.state !== 'planning') return
  d().addTaskEvent({ taskId, kind: 'error', title: '计划生成失败', detail })
  d().store.updateTask(taskId, { failureStage: 'planning' })
  updateState(current, 'failed')
}

// ── Review 自动修订 ──────────────────────────────────────────────────────────

async function runReviewWithAutoFix(taskId: string, signal?: AbortSignal): Promise<void> {
  await d().taskWorkflow.runReview(taskId, d().buildReviewOrchestrator(), signal)
  const task = d().store.getTask(taskId)
  if (!task || task.state !== 'review_blocked') return
  if (!reviewAutoFixEnabled()) return
  const used = task.reviewFixCount ?? 0
  const maxRounds = reviewAutoFixMaxRounds()
  const comments = collectReviewComments(taskId, true)
  if (comments.length === 0) return
  if (used >= maxRounds) {
    d().addTaskEvent({
      taskId,
      kind: 'status',
      title: '已到达 Review 自动修订上限',
      detail: `已自动修订 ${used} 轮，剩余 ${comments.length} 条阻断意见需人工处理`
    })
    return
  }
  const fixPrompt = buildReviewFixPrompt(task, comments)
  d().store.updateTask(taskId, { reviewFixCount: used + 1 })
  updateState(d().store.getTask(taskId)!, 'implementing')
  d().addTaskEvent({
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
  if (d().runtimeProvider(task) === 'qoder') {
    await d()
      .qoderOrch.runAutoFix(taskId, fixPrompt, signal, used + 1)
      .catch((error: unknown) =>
        emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
      )
    return
  }
  signal?.throwIfAborted()
  await startPi(taskId)
  if (!getPiSession()) throw new Error('OpenAI agent session is unavailable')
  await getPiSession()!.prompt(
    await buildAgentPrompt(
      task,
      `${fixPrompt}\n\n${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ''}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`
    ),
    { source: 'rpc' }
  )
}

// ── 实现收尾 ─────────────────────────────────────────────────────────────────

async function finishImplementation(taskId: string, responseTexts: string[], signal?: AbortSignal): Promise<void> {
  const task = d().store.getTask(taskId)
  if (!task || task.state !== 'implementing') return
  const decision = parseImplementationDecision(responseTexts)
  if (decision.outcome === 'needs_input') {
    d().taskWorkflow.awaitInput(taskId, decision.content || 'Agent 表示当前信息不足或实现尚未完成，请补充后继续。')
    return
  }
  const memoryPending = consolidateTaskMemory(taskId, responseTexts)
  taskMemoryPending.set(taskId, memoryPending)
  void memoryPending.then(() => {
    if (taskMemoryPending.get(taskId) === memoryPending) taskMemoryPending.delete(taskId)
  })
  let changedFiles: Awaited<ReturnType<typeof taskChangedFiles>>
  try {
    changedFiles = await taskChangedFiles(taskId, false)
  } catch (error) {
    d().addTaskEvent({
      taskId,
      kind: 'error',
      title: '无法确认文件改动',
      detail: `${error instanceof Error ? error.message : String(error)}\n任务不会自动进入校验、Review 或完成状态。`
    })
    return
  }
  const nextStep = nextStepForImplementation(decision.outcome, changedFiles.length)
  if (nextStep === 'complete_without_changes') {
    d().taskWorkflow.completeImplementationWithoutChanges(
      taskId,
      decision.content || 'Agent 已确认当前仓库满足任务要求。无需修改代码。'
    )
    return
  }
  if (nextStep === 'await_confirmation') {
    d().addTaskEvent({
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
  if (d().taskWorkflow.shouldGenerateTestCases(task)) {
    const covered = await runTestCoverageCheck(taskId, signal)
    if (covered) {
      const validated = await d().taskWorkflow.runValidation(taskId, signal)
      await advanceAfterValidation(taskId, validated.state, signal)
    } else {
      await runTestCaseGenerationThenValidate(taskId, signal)
    }
    return
  }
  const validated = await d().taskWorkflow.runValidation(taskId, signal)
  await advanceAfterValidation(taskId, validated.state, signal)
}

async function runTestCaseGenerationThenValidate(taskId: string, signal?: AbortSignal): Promise<void> {
  try {
    d().taskWorkflow.beginTestCaseGeneration(taskId)
    const result = await d().qoderOrch.runTestCases(taskId, signal)
    d().taskWorkflow.finishTestCaseGeneration(taskId, result)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    d().addTaskEvent({ taskId, kind: 'error', title: '测试用例生成失败', detail })
    const current = d().store.getTask(taskId)
    if (current?.state === 'generating_tests') updateState(current, 'implementing')
    return
  }
  const validated = await d().taskWorkflow.runValidation(taskId, signal)
  await advanceAfterValidation(taskId, validated.state, signal)
}

// ── 任务文件变更 ─────────────────────────────────────────────────────────────

export async function taskChangedFiles(
  taskId: string,
  ignoreErrors = true
): Promise<Array<{ repositoryId: string; repositoryName: string; path: string; status: string }>> {
  const git = d().gitService
  const groups = await Promise.all(
    d()
      .store.listTaskRepositories(taskId)
      .map(async (repo) => {
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
    d()
      .store.listCards()
      .map(async (card) => {
        const repositories = new Map(
          d()
            .store.listTaskRepositories(card.id)
            .map((repo) => [repo.id, repo])
        )
        return {
          ...card,
          repositories: await Promise.all(
            card.repositories.map(async (repository) => {
              const repo = repositories.get(repository.id)
              if (!repo) return repository
              if (repo.deliveryStatus === 'workspace_removed') return repository
              try {
                const changedFiles = await d().gitService.changedFiles(
                  repo.worktreePath ?? repo.localPath,
                  repo.baseBranch
                )
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

// ── 任务启动 / 继续 / 暂停 ──────────────────────────────────────────────────

export async function startTask(
  taskId: string,
  options: {
    mode?: TaskStartMode
    repositoryCommands?: RepositoryCommandMap
    useAllRepositories?: boolean
    repoAgentIds?: Record<string, string>
  } = {}
): Promise<void> {
  const current = d().store.getTask(taskId)
  if (current) qoderTokenGuard(current)
  if (options.useAllRepositories && current) {
    const existing = d().store.listTaskRepositories(taskId)
    if (existing.length === 0) {
      const all = d().store.listRepositoryProfiles()
      for (const profile of all) {
        const exists = existing.find((repo) => repo.repositoryId === profile.id)
        if (!exists) d().store.attachRepository(taskId, profile.id)
      }
    }
  }
  if (options.repoAgentIds && Object.keys(options.repoAgentIds).length > 0) {
    d().store.updateTask(taskId, { repoAgentIds: options.repoAgentIds })
  }
  if (current && ['draft', 'failed'].includes(current.state) && d().runtimeProvider(current) === 'qoder')
    d().store.updateTask(taskId, { sessionUsage: undefined })
  const mode = options.mode ?? 'direct'
  d().store.updateTask(taskId, { reviewFixCount: 0 })
  const task = await runTaskOperation(taskId, (signal) =>
    d().taskWorkflow.begin(taskId, mode, options.repositoryCommands, signal)
  )
  if (mode === 'plan') {
    if (d().runtimeProvider(task) === 'qoder')
      void runTaskOperation(taskId, (signal) => d().qoderOrch.runPlan(taskId, undefined, signal)).catch(
        (error: unknown) =>
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
  if (d().runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) => d().qoderOrch.run(taskId, undefined, signal)).catch((error: unknown) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    await startPi(taskId)
    if (!getPiSession()) throw new Error('OpenAI agent session is unavailable')
    await getPiSession()!.prompt(
      await buildAgentPrompt(
        task,
        `${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ''}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\n${implementationOutcomeInstruction}`
      ),
      { source: 'rpc' }
    )
  })
}

const resumeImplementationInstruction =
  '任务此前执行失败/中断。请先检查当前工作区与代码状态（已完成的改动应保留），定位失败原因后继续完成剩余工作；不要重新执行已完成的部分，也不要重复安装依赖或重建环境。'

async function resumeTask(taskId: string): Promise<void> {
  const current = d().store.getTask(taskId)
  if (!current || current.state !== 'failed') throw new Error('只有失败的任务可以继续执行')
  qoderTokenGuard(current)
  d().store.updateTask(taskId, { sessionUsage: undefined })
  const failedDuringPlanning =
    current.failureStage === 'planning' || (current.startMode === 'plan' && !current.planContent)
  d().store.updateTask(taskId, { failureStage: undefined })
  if (failedDuringPlanning) {
    const task = await runTaskOperation(taskId, (signal) => d().taskWorkflow.begin(taskId, 'plan', undefined, signal))
    if (d().runtimeProvider(task) === 'qoder') {
      void runTaskOperation(taskId, (signal) => d().qoderOrch.runPlan(taskId, undefined, signal, 'resume')).catch(
        (error: unknown) =>
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
  const task = await runTaskOperation(taskId, (signal) => d().taskWorkflow.prepare(taskId, signal))
  if (d().runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) => d().qoderOrch.resume(taskId, signal)).catch((error: unknown) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    await startPi(taskId)
    if (!getPiSession()) throw new Error('OpenAI agent session is unavailable')
    await getPiSession()!.prompt(
      await buildAgentPrompt(
        task,
        `${resumeImplementationInstruction}\n\n${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ''}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\n${implementationOutcomeInstruction}`
      ),
      { source: 'rpc' }
    )
  })
}

async function pauseTask(taskId: string): Promise<void> {
  const task = d().store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  if (!['implementing', 'awaiting_input'].includes(task.state)) throw new Error('当前状态不能暂停')
  updateState(task, 'paused')
  const operation = activeTaskOperations.get(taskId)
  operation?.controller.abort(new Error('任务已暂停'))
  if (getActiveTaskId() === taskId) {
    d().qoderOrch.pause(taskId)
    await stopPi()
    _setActiveTaskId(undefined)
    d().store.setSetting('activeTaskId', '')
  }
  try {
    const events = d().store.listEvents(taskId)
    const toolUseIds = new Set<string>()
    const toolResultIds = new Set<string>()
    const toolNames = new Map<string, string>()
    for (const event of events) {
      if (event.kind !== 'tool') continue
      const payload = event.payload as Record<string, unknown> | undefined
      const toolUseId = payload?.toolUseId as string | undefined
      if (!toolUseId) continue
      if (payload?.phase === 'use') {
        toolUseIds.add(toolUseId)
        toolNames.set(toolUseId, (payload?.toolName as string) ?? event.title)
      } else if (payload?.phase === 'result') {
        toolResultIds.add(toolUseId)
      }
    }
    for (const toolUseId of toolUseIds) {
      if (toolResultIds.has(toolUseId)) continue
      d().addTaskEvent({
        taskId,
        kind: 'tool',
        title: toolNames.get(toolUseId) ?? 'tool',
        payload: {
          toolUseId,
          toolName: toolNames.get(toolUseId) ?? 'tool',
          phase: 'result',
          output: '任务已暂停，工具调用未执行',
          isError: true
        }
      })
    }
  } catch {
    /* 事件扫描失败不影响暂停主流程 */
  }
  void (async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const deniedIds = d().qoderOrch.taskAgent.getDeniedCallIds(taskId)
      if (deniedIds.size === 0) return
      const events = d().store.listEvents(taskId)
      const errorResultIds = new Set<string>()
      const toolNames = new Map<string, string>()
      for (const event of events) {
        if (event.kind !== 'tool') continue
        const payload = event.payload as Record<string, unknown> | undefined
        const toolUseId = payload?.toolUseId as string | undefined
        if (!toolUseId) continue
        if (payload?.phase === 'result' && payload?.isError === true) {
          errorResultIds.add(toolUseId)
        }
        if (payload?.phase === 'use') {
          toolNames.set(toolUseId, (payload?.toolName as string) ?? event.title)
        }
      }
      for (const id of deniedIds) {
        if (errorResultIds.has(id)) continue
        d().addTaskEvent({
          taskId,
          kind: 'tool',
          title: toolNames.get(id) ?? 'tool',
          payload: {
            toolUseId: id,
            toolName: toolNames.get(id) ?? 'tool',
            phase: 'result',
            output: '任务已暂停，工具调用被拒绝',
            isError: true
          }
        })
      }
    } catch {
      /* 延迟扫描失败不影响主流程 */
    }
  })()
  d().addTaskEvent({ taskId, kind: 'status', title: '任务已暂停', detail: '可通过「继续执行」从当前进度续跑' })
}

async function resumePausedTask(taskId: string): Promise<void> {
  const current = d().store.getTask(taskId)
  if (!current || current.state !== 'paused') throw new Error('只有暂停的任务可以继续执行')
  qoderTokenGuard(current)
  const task = updateState(current, 'implementing')
  d().addTaskEvent({ taskId, kind: 'status', title: '任务已恢复执行' })
  if (d().runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) => d().qoderOrch.resumePaused(taskId, signal)).catch((error: unknown) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    await startPi(taskId)
    if (!getPiSession()) throw new Error('OpenAI agent session is unavailable')
    await getPiSession()!.prompt(
      await buildAgentPrompt(
        task,
        `${resumeImplementationInstruction}\n\n${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ''}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\n${implementationOutcomeInstruction}`
      ),
      { source: 'rpc' }
    )
  })
}

// ── 计划操作 ─────────────────────────────────────────────────────────────────

async function updateTaskPlan(taskId: string, planContent: string): Promise<void> {
  const task = d().store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  if (!['awaiting_plan_approval', 'planning'].includes(task.state)) throw new Error('当前状态不能编辑计划')
  const content = planContent.trim()
  if (!content) throw new Error('计划内容不能为空')
  const revision = (task.planRevision ?? 0) + 1
  d().store.updateTask(taskId, { planContent: content, planRevision: revision })
  d().addTaskEvent({ taskId, kind: 'status', title: '计划已手动编辑', detail: `第 ${revision} 版` })
}

async function approveTaskPlan(taskId: string): Promise<void> {
  const before = d().store.getTask(taskId)
  if (!before?.planContent) throw new Error('当前任务没有可批准的计划')
  d().store.updateTask(taskId, { reviewFixCount: 0 })
  const approval = d().store.addApproval({ taskId, kind: 'plan', context: before.planContent })
  d().store.resolveApproval(approval.id, 'approved')
  const task = await runTaskOperation(taskId, (signal) => d().taskWorkflow.approvePlan(taskId, signal))
  if (d().runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) => d().qoderOrch.approvePlan(taskId, signal)).catch((error: unknown) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    await startPi(taskId)
    await getPiSession()!.prompt(
      await buildAgentPrompt(
        task,
        `${task.title}\n\n${task.description}\n\nApproved implementation plan:\n${task.planContent}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\n${implementationOutcomeInstruction}`
      ),
      { source: 'rpc' }
    )
  })
}

async function reviseTaskPlan(taskId: string, feedback: string): Promise<void> {
  const task = d().taskWorkflow.revisePlan(taskId)
  d().addTaskEvent({ taskId, kind: 'message', title: '计划调整意见', detail: feedback })
  if (d().runtimeProvider(task) === 'qoder') {
    try {
      await runTaskOperation(taskId, (signal) => d().qoderOrch.revisePlan(taskId, feedback, signal))
    } catch (error) {
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
    const validated = await d().taskWorkflow.runValidation(taskId, signal)
    await advanceAfterValidation(taskId, validated.state, signal)
  })
}

// ── 任务消息 / 停止 / 取消 / 删除 ────────────────────────────────────────────

async function sendTaskMessage(taskId: string, message: string): Promise<void> {
  let task = d().store.getTask(taskId)
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
  d().addTaskEvent({ taskId, kind: 'message', title: '你', detail: message })
  if (task.state === 'awaiting_input' && isExplicitNoChangeCompletionRequest(message)) {
    d().taskWorkflow.completeAtUserRequest(taskId)
    return
  }
  if (task.state === 'awaiting_input') task = d().taskWorkflow.resumeImplementation(taskId)
  else if (task.state !== 'implementing') task = updateState(task, 'implementing')
  d().store.updateTask(task.id, { reviewStatus: 'pending' })
  if (d().runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) => d().qoderOrch.sendMessage(taskId, message, signal)).catch((error) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    if (!getPiSession() || getActiveTaskId() !== taskId) await startPi(taskId)
    await getPiSession()!.prompt(`${message}\n\n${implementationOutcomeInstruction}`, {
      source: 'rpc',
      ...(getPiSession()!.isStreaming ? { streamingBehavior: 'followUp' as const } : {})
    })
  })
}

export async function stopTaskOperations(taskId: string, markFailed: boolean): Promise<void> {
  const operation = activeTaskOperations.get(taskId)
  operation?.controller.abort(new Error(markFailed ? '任务已停止' : '任务已删除'))
  const task = d().store.getTask(taskId)
  if (markFailed && task && ['planning', 'implementing', 'validating', 'generating_tests'].includes(task.state))
    updateState(task, 'failed')
  d().qoderOrch.closeSession(taskId)
  if (getActiveTaskId() === taskId) {
    const result = await d().qoderOrch.stop(taskId, markFailed)
    const qoderAbort = result.abortedController
    const qoderQuery = result.abortedQuery
    _setActiveTaskId(undefined)
    setActivePlanningTaskId(undefined)
    setActivePlanText('')
    d().store.setSetting('activeTaskId', '')
    qoderAbort?.abort(new Error(markFailed ? '任务已停止' : '任务已删除'))
    try {
      await qoderQuery?.interrupt()
    } catch {
      /* The query may already be closed. */
    }
    if (qoderQuery) await closeQoderQuerySafely(qoderQuery, 5_000)
    await stopPi()
  }
  try {
    await operation?.promise
  } catch {
    /* Cancellation is expected while removing a task. */
  }
}

async function cancelTask(taskId: string): Promise<void> {
  const task = d().store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  if (['failed', 'completed', 'cancelled', 'await_merge'].includes(task.state)) {
    throw new Error('当前状态的任务不能结束')
  }
  await stopTaskOperations(taskId, false)
  const current = d().store.getTask(taskId)
  if (current && !['failed', 'completed', 'cancelled'].includes(current.state)) {
    updateState(current, 'cancelled')
  }
}

export type TaskRemovalMode = 'workspace' | 'all'

async function removeTaskWorkspace(taskId: string, repositories: TaskRepository[]): Promise<void> {
  const git = d().gitService
  for (const repo of repositories) {
    if (!repo.worktreePath) continue
    try {
      await git.removeWorktree(repo.localPath, repo.worktreePath)
    } catch {
      rmSync(repo.worktreePath, { recursive: true, force: true })
    }
  }
  rmSync(taskWorkspace(taskId), { recursive: true, force: true })
  rmSync(join(d().dataDir, 'worktrees', taskId), { recursive: true, force: true })
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
  const task = d().store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  await stopTaskOperations(taskId, false)
  const repositories = d().store.listTaskRepositories(taskId)
  await removeTaskWorkspace(taskId, repositories)
  if (mode === 'workspace') {
    for (const repo of repositories) {
      d().store.updateTaskRepository(repo.id, {
        worktreePath: undefined,
        featureBranch: undefined,
        deliveryStatus: 'workspace_removed'
      })
    }
    const preservedStates = new Set<TaskState>(['draft', 'failed', 'completed', 'await_merge', 'cancelled'])
    if (!preservedStates.has(task.state)) {
      d().store.updateTask(taskId, { state: 'cancelled', failureStage: undefined })
    }
    d().addTaskEvent({
      taskId,
      kind: 'status',
      title: '任务工作区已清理',
      detail: '已停止任务操作并删除 Worktree；任务、计划、执行记录和交付信息继续保留'
    })
    return
  }
  d().store.deleteTask(taskId)
  await d().traceService.deleteTrace(taskId)
  d().memoryService.deleteConversationMemories(`task:${taskId}`)
  if (getActiveTaskId() === taskId) _setActiveTaskId(undefined)
}

// ── 编辑器 / 合并 / 导出 ────────────────────────────────────────────────────

async function openEditorForTask(taskId: string, editor: 'vscode' | 'qoder'): Promise<void> {
  if (!(['vscode', 'qoder'] as const).includes(editor)) throw new Error('不支持的编辑器')
  const paths = d()
    .store.listTaskRepositories(taskId)
    .map((repo) => repo.worktreePath ?? repo.localPath)
  await openTaskEditor(editor, paths)
}

async function mergeBackToBase(taskId: string, signal?: AbortSignal): Promise<void> {
  const task = d().store.getTask(taskId)
  if (!task) throw new Error('任务不存在')
  const repos = d().store.listTaskRepositories(taskId)
  if (repos.length === 0) throw new Error('任务未关联代码仓库')
  d().addTaskEvent({ taskId, kind: 'status', title: '开始合并 feature 分支到 base' })
  for (const repo of repos) {
    if (!repo.worktreePath) {
      d().addTaskEvent({
        taskId,
        kind: 'error',
        title: `仓库 ${repo.name} 缺少 worktree 路径`,
        detail: '请先完成「准备工作」创建 worktree。'
      })
      throw new Error(`仓库 ${repo.name} 缺少 worktree 路径`)
    }
    if (!repo.featureBranch) {
      d().addTaskEvent({
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
      const status = (await d().gitService.status(cwd)).trim()
      if (status) {
        d().addTaskEvent({
          taskId,
          kind: 'error',
          title: `仓库 ${repo.name} 工作区不干净`,
          detail: `请先 commit 或 stash 当前改动。\n${status}`
        })
        throw new Error(`仓库 ${repo.name} 工作区存在未提交改动`)
      }
      d().addTaskEvent({
        taskId,
        kind: 'command',
        title: `git checkout ${repo.baseBranch}`,
        detail: `工作目录: ${cwd}`
      })
      await d().gitService.checkout(cwd, repo.baseBranch, signal)
      const message = `merge: ${task.taskKey ?? task.id} ${task.title.slice(0, 60)}`
      d().addTaskEvent({ taskId, kind: 'command', title: `git merge --no-ff ${repo.featureBranch}`, detail: message })
      await d().gitService.mergeNoFF(cwd, repo.featureBranch, message, signal)
      d().addTaskEvent({
        taskId,
        kind: 'status',
        title: `仓库 ${repo.name} 已合并 ${repo.featureBranch} -> ${repo.baseBranch}`
      })
      d().addTaskEvent({
        taskId,
        kind: 'command',
        title: `git checkout ${repo.featureBranch}`,
        detail: '合并完成后切回 feature 分支，保持 worktree 习惯'
      })
      await d().gitService.checkout(cwd, repo.featureBranch, signal)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      try {
        await d().gitService.checkout(cwd, repo.featureBranch, signal)
      } catch {
        /* 静默：原始错误更重要 */
      }
      d().addTaskEvent({ taskId, kind: 'error', title: `仓库 ${repo.name} 合并失败`, detail })
      throw error
    }
  }
  d().addTaskEvent({ taskId, kind: 'status', title: '已合并所有仓库的 feature 分支到 base（未推送远端）' })
}

// ── 孤儿 Trace 收口 ──────────────────────────────────────────────────────────

export function sweepInterruptedTraces(): void {
  const ORPHAN_STALE_MS = 10 * 60_000
  const storage = new JsonlTraceStorage(d().dataDir)
  let names: string[] = []
  try {
    names = readdirSync(traceEventsDir(d().dataDir)).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    const traceId = name.replace(/\.jsonl$/, '')
    try {
      if (existsSync(traceInfoFile(d().dataDir, traceId))) continue
      if (d().tracePipeline.isActive(traceId)) continue
      if (now - statSync(join(traceEventsDir(d().dataDir), name)).mtimeMs < ORPHAN_STALE_MS) continue
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

// ── 导出 ─────────────────────────────────────────────────────────────────────

export {
  resumeTask,
  pauseTask,
  resumePausedTask,
  updateTaskPlan,
  approveTaskPlan,
  reviseTaskPlan,
  retryTaskValidation,
  sendTaskMessage,
  cancelTask,
  deleteTask,
  taskCardsWithCurrentChanges,
  openEditorForTask,
  mergeBackToBase,
  runReviewWithAutoFix,
  finishImplementation,
  submitMergeRequestsWithCredWatch
}

async function submitMergeRequestsWithCredWatch(taskId: string, signal?: AbortSignal): Promise<void> {
  try {
    await d().deliveryService.submitMergeRequests(taskId, signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/401|403|unauthori[sz]ed|forbidden/i.test(message)) {
      const { markCredentialFailed } = await import('../credential/credential-state.js')
      markCredentialFailed('gitlab', message)
    }
    throw error
  }
}
