/**
 * 任务生命周期：状态流转 + 执行流程 + 计划/校验/Review 全链路。
 *
 * 从 main.ts 提取的核心任务逻辑：
 *  - 状态流转：updateState / taskStateLabels
 *  - 执行流程：startTask / resumeTask / pauseTask / resumePausedTask / cancelTask / deleteTask
 *  - 计划流程：runPiPlan / failPlanGeneration / approveTaskPlan / reviseTaskPlan
 *  - 实现收尾：finishImplementation / runReviewWithAutoFix / runTestCaseGenerationThenValidate
 *  - 辅助：buildAgentPrompt / qoderTokenGuard / runOperationAgent / taskChangedFiles 等
 *
 * 通过 initTaskLifecycle(deps) 注入共享依赖，避免循环引用。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentEvent,
  Task,
  TaskDraftEventPayload,
  TaskDraftFieldKey,
  TaskRepository,
  TaskState,
  TaskStore
} from '@task-pipeline/core'
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
import type { TaskAgentResult } from '../agents/task-agent/task-agent-driver.js'
import {
  adoptDraftFields,
  closeTaskIntake,
  describeDraftFields,
  pickDraftFields,
  runTaskIntakeTurn
} from '../agents/task-intake/task-intake.js'
import type { QoderOrchestrator } from '../pi-extension/qoder/index.js'
import { closeQoderQuerySafely, purgeTaskSessions, stripQoderModelPrefix } from '../pi-extension/qoder/index.js'
import type { TracePipeline } from '../trace/bus/trace-pipeline.js'
import type { PiTraceBuilder } from '../trace/instrument/pi-trace-builder.js'
import type { TraceService } from '../trace/trace-service.js'
import type { MemoryService } from '../memory/memory-service.js'
import { consolidateTaskMemory } from '../memory/memory-context.js'
import { stripOpenAIModelPrefix, resolveLiteModel } from '../chat/model-profile.js'
import { parseTestCaseGeneration } from '../agents/task-agent/parsers/test-case-parser.js'
import type { TestCaseGenerationResult } from '../agents/task-agent/parsers/test-case-parser.js'
import {
  assertDraftIntake,
  implementationOutcomeInstruction,
  isExplicitNoChangeCompletionRequest,
  nextStepForImplementation,
  parseImplementationDecision,
  testCaseGenerationInstruction
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
  PLAN_SECTION_REQUIREMENT,
  exportPlanArtifact,
  readExecSummary,
  removeTaskArtifacts,
  writeExecSummary,
  writeTestCases
} from './stage-artifacts.js'
import { deletePiTaskSessionFile, emitPi, releasePiSession } from './pi-session.js'
import { purgePiTaskSessionFiles } from './pi-session-sweep.js'
import type { PiStageInput } from './pi-task-agent.js'
import { piTaskAgent } from './pi-task-agent.js'

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
  providerForTask: (taskId: string | undefined) => string
  runtimeProvider: (task: Task) => string
  modelProvider: () => string
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

/**
 * 任务走哪条运行时（§6）：入口判定只看这一个函数。
 *
 * 阶段级差异（能不能 fork、权限怎么给）由 `capabilities()` 承担，不在阶段代码里
 * 写 `provider === 'qoder'`：两条运行时都是「一个 driver + runStage」。
 */
function usesQoder(task: Task): boolean {
  return d().runtimeProvider(task) === 'qoder'
}

/**
 * Pi 运行时的一轮阶段执行（与 Qoder 侧 `QoderOrchestrator.run*` 同构）。
 *
 * 阶段边界 / 等回合 / 取产物都在 `PiTaskAgent` 里；本层只负责「拼阶段正文」与
 * 「把产物交回状态机」，不再直接拿会话对象发 prompt。
 */
async function runPiStage(input: PiStageInput): Promise<TaskAgentResult> {
  return piTaskAgent().runStage(input)
}

/** 实现阶段跑完 → 进收尾（与 Qoder 一样：由编排层显式调，不靠事件层反向驱动）。 */
async function runPiImplementation(
  task: Task,
  body: string,
  options?: { signal?: AbortSignal; trigger?: 'resume' | 'followup'; round?: number }
): Promise<void> {
  const result = await runPiStage({
    taskId: task.id,
    phase: 'implementation',
    body,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.trigger ? { trigger: options.trigger } : {}),
    ...(options?.round ? { round: options.round } : {})
  })
  await finishImplementation(task.id, result.responseTexts, options?.signal)
}

/** 实现阶段正文：`lead` + 任务信息 + 计划 + 验收标准（`withOutcome` 控制是否附收尾指令）。 */
function implementationBody(task: Task, lead: string, options?: { withOutcome?: boolean }): string {
  const criteria = `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`
  return [
    lead,
    task.title,
    task.description,
    task.planContent ? `Approved implementation plan:\n${task.planContent}` : '',
    criteria,
    options?.withOutcome === false ? '' : implementationOutcomeInstruction
  ]
    .filter(Boolean)
    .join('\n\n')
}

async function runPiPlan(taskId: string, prompt: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const result = await runPiStage({ taskId, phase: 'planning', body: prompt, signal })
  const plan = result.responseTexts.join('').trim()
  if (!plan) throw new Error('Agent 未返回有效计划')
  await savePlanDecision(taskId, [plan])
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
  if (usesQoder(task)) {
    await d()
      .qoderOrch.runAutoFix(taskId, fixPrompt, signal, used + 1)
      .catch((error: unknown) =>
        emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
      )
    return
  }
  signal?.throwIfAborted()
  await runPiImplementation(
    task,
    await buildAgentPrompt(task, implementationBody(task, fixPrompt, { withOutcome: false })),
    {
      ...(signal ? { signal } : {}),
      round: used + 1
    }
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
  // 交接产物（§4.1）：先把「实际改了什么」落盘。Test 自 P2 起是独立阶段实例，
  // 不再继承整段实现推理，只看这份摘要 + 改动清单。
  await writeExecSummary(
    d().dataDir,
    taskId,
    [
      '## 实现结论',
      '',
      decision.content || `Agent 结论：${decision.outcome}`,
      '',
      `## 改动文件（${changedFiles.length}）`,
      '',
      ...changedFiles.map((file) => `- ${file.repositoryName}: ${file.path} (${file.status})`)
    ].join('\n')
  ).catch(() => undefined)
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
  if (await runTestCoverageCheck(taskId, signal)) {
    // 「写用例」阶段唯一允许的 no-op 判据是已有覆盖（§2.2）；跳过时必须落一条说清「测了、只是没重写」，
    // 否则 Timeline 上只看到「跳过生成」，用户会以为整个测试阶段没做。
    d().addTaskEvent({
      taskId,
      kind: 'status',
      title: '已有测试覆盖，本次不新增用例',
      detail: '仍会执行现有测试与 Lint / Build。'
    })
    const validated = await d().taskWorkflow.runValidation(taskId, signal)
    await advanceAfterValidation(taskId, validated.state, signal)
    return
  }
  await runTestCaseGenerationThenValidate(taskId, signal)
}

async function runTestCaseGenerationThenValidate(taskId: string, signal?: AbortSignal): Promise<void> {
  const task = d().store.getTask(taskId)
  if (!task) return
  try {
    d().taskWorkflow.beginTestCaseGeneration(taskId)
    // 阶段级 provider 分支：Test 与 Plan/Exec 一样属于任务执行链路，必须跟着任务的运行时走。
    // 此前无条件借 Qoder 编排器跑，Pi 任务要么抛「运行时不支持」，要么悄悄在另一条链路上生成用例。
    const result =
      d().runtimeProvider(task) === 'qoder'
        ? await d().qoderOrch.runTestCases(taskId, signal)
        : await runPiTestCaseGeneration(task, signal)
    d().taskWorkflow.finishTestCaseGeneration(taskId, result)
    // 用例清单也是阶段产物：Review / 重跑不需要重新解析模型输出就能对账。
    await writeTestCases(d().dataDir, taskId, {
      files: result.files,
      ...(result.commitSha ? { commitSha: result.commitSha } : {}),
      summary: result.summary,
      finishedAt: new Date().toISOString()
    }).catch(() => undefined)
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

/**
 * OpenAI(Pi) 任务的测试用例生成：一个独立阶段实例，输入是 `exec.summary.md` + 计划。
 *
 * 与 Qoder 侧 `runTestGenerationStage` 同一契约：不让测试阶段靠「继承整段实现推理」
 * 来知道改了什么，而是递给它产物摘要（fork 失败时这份输入就是全部上下文）。
 */
async function runPiTestCaseGeneration(task: Task, signal?: AbortSignal): Promise<TestCaseGenerationResult> {
  signal?.throwIfAborted()
  d().addTaskEvent({ taskId: task.id, kind: 'status', title: '正在生成测试用例' })
  const execSummary = await readExecSummary(d().dataDir, task.id).catch(() => undefined)
  const body = [
    `任务:${task.title}`,
    task.description,
    task.planContent ? `Approved implementation plan:\n${task.planContent}` : '',
    execSummary ? `本次实现实际改动（exec.summary.md）:\n${execSummary}` : '',
    testCaseGenerationInstruction
  ]
    .filter(Boolean)
    .join('\n\n')
  const result = await runPiStage({
    taskId: task.id,
    phase: 'test_generation',
    body: await buildAgentPrompt(task, body),
    ...(signal ? { signal } : {})
  })
  const text = result.responseTexts.join('')
  if (!text.trim()) throw new Error('Agent 未返回测试用例生成结果')
  return parseTestCaseGeneration([text])
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
  d().store.updateTask(taskId, { reviewFixCount: 0 })
  // 离开 `draft` 就丢弃澄清会话：它的上下文只属于任务定义阶段，带进实现阶段只会污染计划。
  closeTaskIntake(taskId)
  // `begin()` 恒进 `planning`：固定链路下「直接开始」分支已删，启动入参不再有 `mode`。
  const task = await runTaskOperation(taskId, (signal) =>
    d().taskWorkflow.begin(taskId, { repositoryCommands: options.repositoryCommands }, signal)
  )
  if (d().runtimeProvider(task) === 'qoder') {
    void runTaskOperation(taskId, (signal) => d().qoderOrch.runPlan(taskId, undefined, signal)).catch(
      (error: unknown) =>
        emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  try {
    await runTaskOperation(taskId, async (signal) => {
      signal.throwIfAborted()
      await runPiPlan(taskId, await buildAgentPrompt(task, planBody(task)), signal)
    })
  } catch (error) {
    failPlanGeneration(taskId, error)
    emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
  }
}

const resumeImplementationInstruction =
  '任务此前执行失败/中断。请先检查当前工作区与代码状态（已完成的改动应保留），定位失败原因后继续完成剩余工作；不要重新执行已完成的部分，也不要重复安装依赖或重建环境。'

/** 计划阶段正文：只读约束 + §4.3 三段契约 + 任务信息（三条入口共用，避免文案漂移）。 */
function planBody(task: Task, extra?: string): string {
  return `你处于只读计划模式。禁止修改文件、安装依赖或运行会改变工作区的命令。最终只输出 JSON：代码已满足要求时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n${PLAN_SECTION_REQUIREMENT}\n\n${extra ?? `任务：${task.title}\n${task.description}`}`
}

async function resumeTask(taskId: string): Promise<void> {
  const current = d().store.getTask(taskId)
  if (!current || current.state !== 'failed') throw new Error('只有失败的任务可以继续执行')
  qoderTokenGuard(current)
  d().store.updateTask(taskId, { sessionUsage: undefined })
  // 旧条件里的 `startMode === 'plan' && !planContent` 一并删：固定链路下所有任务都是 plan 档，
  // 阶段判断只看 `failureStage`；旧的「没计划就算挂在计划阶段」会把实现阶段失败误判成计划阶段失败。
  const failedDuringPlanning = current.failureStage === 'planning'
  d().store.updateTask(taskId, { failureStage: undefined })
  if (failedDuringPlanning) {
    const task = await runTaskOperation(taskId, (signal) => d().taskWorkflow.begin(taskId, {}, signal))
    if (d().runtimeProvider(task) === 'qoder') {
      void runTaskOperation(taskId, (signal) => d().qoderOrch.runPlan(taskId, undefined, signal, 'resume')).catch(
        (error: unknown) =>
          emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
      )
      return
    }
    await runTaskOperation(taskId, async (signal) => {
      signal.throwIfAborted()
      await runPiPlan(taskId, await buildAgentPrompt(task, planBody(task)), signal)
    }).catch((error) => {
      failPlanGeneration(taskId, error)
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    })
    return
  }
  const task = await runTaskOperation(taskId, (signal) => d().taskWorkflow.prepare(taskId, signal))
  if (usesQoder(task)) {
    void runTaskOperation(taskId, (signal) => d().qoderOrch.resume(taskId, signal)).catch((error: unknown) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    await runPiImplementation(
      task,
      await buildAgentPrompt(task, implementationBody(task, resumeImplementationInstruction)),
      { signal, trigger: 'resume' }
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
  // 暂停只停这个任务自己的会话（旧写法靠「当前活动任务」判定，并行任务会误停别人）。
  d().qoderOrch.pause(taskId)
  await releasePiSession(taskId)
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
  if (usesQoder(task)) {
    void runTaskOperation(taskId, (signal) => d().qoderOrch.resumePaused(taskId, signal)).catch((error: unknown) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted()
    await runPiImplementation(
      task,
      await buildAgentPrompt(task, implementationBody(task, resumeImplementationInstruction)),
      { signal, trigger: 'resume' }
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
  // 人工闸门也是阶段接口（§4.2）：立即重新导出新版产物并标 editedBy:'user'，
  // Exec 阶段据此写明「用户已编辑，以本版为准」，而不是只靠会话里的旧讨论。
  const edited = d().store.getTask(taskId)
  if (edited)
    await exportPlanArtifact(d().dataDir, edited, { editedBy: 'user' }).catch((error: unknown) => {
      d().addTaskEvent({
        taskId,
        kind: 'error',
        title: '计划产物导出失败',
        detail: `${error instanceof Error ? error.message : String(error)}\n执行阶段起跑前会重试导出。`
      })
    })
}

async function approveTaskPlan(taskId: string): Promise<void> {
  const before = d().store.getTask(taskId)
  if (!before?.planContent) throw new Error('当前任务没有可批准的计划')
  d().store.updateTask(taskId, { reviewFixCount: 0 })
  const approval = d().store.addApproval({ taskId, kind: 'plan', context: before.planContent })
  d().store.resolveApproval(approval.id, 'approved')
  const task = await runTaskOperation(taskId, (signal) => d().taskWorkflow.approvePlan(taskId, signal))
  if (usesQoder(task)) {
    void runTaskOperation(taskId, (signal) => d().qoderOrch.approvePlan(taskId, signal)).catch((error: unknown) =>
      emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  // 计划批准 = Plan → Exec 的阶段边界：`PiTaskAgent` 会看计划三段齐不齐，
  // 齐则从计划会话 fork 一个新阶段实例，缺则不拆（存量任务不重探仓库）。
  void runTaskOperation(taskId, async (signal) =>
    runPiImplementation(task, await buildAgentPrompt(task, implementationBody(task, '')), { signal })
  ).catch((error: unknown) =>
    emitPi({ type: 'agent_error', taskId, message: error instanceof Error ? error.message : String(error) })
  )
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
      await runPiPlan(
        taskId,
        await buildAgentPrompt(
          task,
          `你处于只读计划模式。根据调整意见重新判断，禁止修改文件。最终只输出 JSON：无需修改时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n${PLAN_SECTION_REQUIREMENT}\n\n任务：${task.title}\n${task.description}\n\n上一版计划：\n${task.planContent ?? ''}\n\n调整意见：\n${feedback}`
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

/**
 * `draft` 阶段的澄清对话入口（§2.4）。
 *
 * 与 `sendTaskMessage` 分家是两处不可调和的差异：那条入口会把状态推到 `implementing`
 * （它的语义是「实现期跟进」），而澄清改状态就等于替用户启动链路；两者也不能共用会话，
 * 执行会话的上下文要留给实现阶段（澄清走 `${taskId}:intake`）。
 *
 * 澄清只走 Qoder 路径：它靠的是一套自定义工具注入，Pi 侧没有对应能力；宁可直接报错，
 * 也不退化成「看起来发了但永远没反应」。输出不落流式通道，整轮回复落一条事件。
 */
export async function sendTaskIntake(taskId: string, message: string): Promise<void> {
  const task = d().store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  assertDraftIntake(task.state)
  const token = d().protectedValue('qoderToken')
  if (!token) throw new Error('澄清对话使用 Qoder 模型，请先配置 Qoder Token')
  const repositories = d().store.listTaskRepositories(taskId)
  addDraftEvent({
    taskId,
    kind: 'message',
    title: '你',
    detail: message,
    payload: { type: 'draft-message', role: 'user' } satisfies TaskDraftEventPayload
  })
  // 等整轮跑完才回 IPC：澄清不接流式通道，也就没有 `agent_start` / `message_update` 那套 busy 信号，
  // 这条 promise 挂多久就是「Agent 在想」多久。它失败时直接 rejection 上抛，
  // 比广播一个只有当前页能听见的 `agent_error` 更容易让人知道没说出去的原因。
  await runTaskOperation(taskId, (signal) =>
    runTaskIntakeTurn(
      {
        task,
        repositories,
        availableRepositories: d().store.listRepositoryProfiles(),
        token,
        model: stripQoderModelPrefix(d().agentService.resolveModelForTask(task, repositories)),
        addEvent: addDraftEvent
      },
      message,
      signal
    )
  )
}

/**
 * 澄清记录的落库出口。
 *
 * 不能用 `d().addTaskEvent`：那个 deps 只发一次 `task_changed` 通知，而 Timeline 的事件是从
 * trace span 合成的——`draft` 阶段根本没有 trace，走那条路等于话说完就消失。
 */
function addDraftEvent(event: Omit<AgentEvent, 'id' | 'createdAt'>): void {
  d().store.addEvent(event)
  d().emitTaskChanged(event.taskId)
}

/** 取出一条事件载荷里的建议体；不是建议时返回 `undefined`。 */
function draftEventPayload(event: AgentEvent): Partial<TaskDraftEventPayload> | undefined {
  return event.payload && typeof event.payload === 'object'
    ? (event.payload as Partial<TaskDraftEventPayload>)
    : undefined
}

/**
 * 采纳 / 丢弃一条澄清建议（§2.4 第 3 条）。
 *
 * 只认事件 id、不认 renderer 传回来的建议体：否则 renderer 可以自己拼字段让主进程写库，
 * 「字段写入与白名单校验都在主进程」这句话就白写了。`keys` 是逐项采纳的勾选结果，
 * 它只能从存量建议里挑键，不在名单里的键一律当作没勾（而不是新字段）。
 */
export async function resolveDraftSuggestion(
  taskId: string,
  eventId: string,
  action: 'apply' | 'discard',
  keys?: TaskDraftFieldKey[]
): Promise<void> {
  const task = d().store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  assertDraftIntake(task.state)
  const events = d().store.listEvents(taskId)
  const index = events.findIndex((event) => event.id === eventId)
  if (index < 0) throw new Error('这条建议已经不存在，请刷新后重试')
  const payload = draftEventPayload(events[index]!)
  if (payload?.type !== 'draft-suggestion') throw new Error('这条事件不是待采纳的任务建议')
  if (events.slice(index + 1).some((later) => draftEventPayload(later)?.type === 'draft-suggestion-resolved'))
    throw new Error('这条建议已经处置过了')
  const available = d().store.listRepositoryProfiles()
  const rawFields = (payload.fields ?? {}) as Record<string, unknown>
  if (action === 'discard') {
    // 再过一次清洗：库里这份 payload 是上一个版本写的可能性不大，但字段名单只能有一处。
    addDraftEvent({
      taskId,
      kind: 'status',
      title: '已忽略 Agent 的任务定义建议',
      detail: describeDraftFields(pickDraftFields(rawFields, available)),
      payload: { type: 'draft-suggestion-resolved', action: 'discarded' } satisfies TaskDraftEventPayload
    })
    return
  }
  // 交集、空勾选、仓库脏数据三条判据都在 `adoptDraftFields` 里：它才是「点一下采纳会写什么」的答案。
  const { fields: adopted, error } = adoptDraftFields(rawFields, keys, available)
  if (error) throw new Error(error)
  d().store.updateTask(taskId, {
    ...(adopted.title ? { title: adopted.title } : {}),
    ...(adopted.description ? { description: adopted.description } : {}),
    ...(adopted.keywords ? { keywords: adopted.keywords } : {}),
    ...(adopted.acceptanceCriteria ? { acceptanceCriteria: adopted.acceptanceCriteria } : {})
  } satisfies Partial<Task>)
  if (adopted.repositoryIds) applyDraftRepositories(taskId, adopted.repositoryIds)
  addDraftEvent({
    taskId,
    kind: 'status',
    title: '已采纳 Agent 的任务定义建议',
    // 记的是实际写进去的那几项，不是建议原文：用户只勾两项时摘要里不该出现第三项。
    detail: describeDraftFields(adopted),
    payload: { type: 'draft-suggestion-resolved', action: 'applied' } satisfies TaskDraftEventPayload
  })
}

/** 建议里的仓库列表当作最终结果用：缺的补上、多的 detach，不只做增量。 */
function applyDraftRepositories(taskId: string, repositoryIds: string[]): void {
  const attached = d()
    .store.listTaskRepositories(taskId)
    .map((repo) => repo.repositoryId)
  for (const id of repositoryIds) if (!attached.includes(id)) d().store.attachRepository(taskId, id)
  for (const id of attached) if (!repositoryIds.includes(id)) d().store.detachRepository(taskId, id)
}

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
    // 追加消息 = 实现阶段内的续接（不拆阶段实例），跑完同样交回收尾状态机。
    await runPiImplementation(task, `${message}\n\n${implementationOutcomeInstruction}`, {
      signal,
      trigger: 'followup'
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
  // 澄清会话不在 qoderOrch 手里（它只持执行会话），停止 / 取消 / 删除时要单独丢。
  closeTaskIntake(taskId)
  // 停止只影响这个任务：旧写法用「当前活动任务」当闸门，并行任务时会连它人的会话一起关。
  const result = await d().qoderOrch.stop(taskId, markFailed)
  const qoderAbort = result.abortedController
  const qoderQuery = result.abortedQuery
  qoderAbort?.abort(new Error(markFailed ? '任务已停止' : '任务已删除'))
  try {
    await qoderQuery?.interrupt()
  } catch {
    /* The query may already be closed. */
  }
  if (qoderQuery) await closeQoderQuerySafely(qoderQuery, 5_000)
  await releasePiSession(taskId)
  piTaskAgent().forgetTask(taskId)
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

/**
 * 任务级会话即时回收（§4.4）：删任务 / 重新执行时把两条运行时的会话一起清掉。
 *
 * Qoder 侧只删 worktree / 工作区目录下的会话：任务的 `localPath`（用户仓库本身）也会出现在
 * 会话 cwd 里，带上它就会把用户自己的对话会话一并删掉（`purgeTaskSessions` 里还有一道护栏）。
 * Pi 侧先按会话文件首行 header.cwd 归因删（一个任务只存一个 `piSessionPath`，fork 前驱靠指针始终管不到），
 * 再按 DB 指针补删一份。
 * 回收不干净的交给 main.ts 的周期 sweep 兜底，但失败必须落事件（不静默）。
 */
export async function purgeTaskSessionsFor(taskId: string): Promise<void> {
  const dataDir = d().dataDir
  const workspacesRoots = [join(dataDir, 'workspaces'), join(dataDir, 'worktrees')]
  const pi = purgePiTaskSessionFiles({
    piSessionsDir: join(dataDir, 'pi-sessions'),
    workspacesRoots,
    taskId
  })
  deletePiTaskSessionFile(taskId)
  const dirs = [
    taskWorkspace(taskId),
    join(dataDir, 'worktrees', taskId),
    ...d()
      .store.listTaskRepositories(taskId)
      .map((repo) => repo.worktreePath ?? '')
  ].filter(Boolean)
  const result = await purgeTaskSessions({ dirs, workspacesRoots })
  const failed = [
    ...result.failed.map((item) => `${item.sessionId}：${item.error}`),
    ...pi.failed.map((item) => `${item.file}：${item.error}`)
  ]
  if (failed.length === 0) return
  d().addTaskEvent({
    taskId,
    kind: 'status',
    title: '旧会话未能全部回收',
    detail: failed.join('\n').slice(0, 2000)
  })
}

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
  // 会话先于任务行回收：它要从 DB 拿 worktree 路径当查找目录。
  await purgeTaskSessionsFor(taskId)
  d().store.deleteTask(taskId)
  await d().traceService.deleteTrace(taskId)
  d().memoryService.deleteConversationMemories(`task:${taskId}`)
  // 阶段产物随任务一起走：DB 删了留着一堆 md 只会误导复盘（§4.4）。
  await removeTaskArtifacts(d().dataDir, taskId)
  piTaskAgent().forgetTask(taskId)
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
