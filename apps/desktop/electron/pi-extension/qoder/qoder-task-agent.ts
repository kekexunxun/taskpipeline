/**
 * Qoder Task Agent Driver — TaskAgentDriver 的 Qoder SDK 实现(阶段实例会话引擎版)。
 *
 * 职责(全部封在本文件内):
 *  - runStage: 会话绑「阶段实例」不绑任务
 *    (id = `${taskId}:${phase}:${seq}`,算法在 stage-session.ts)—— 阶段内续接(同一会话追加回合),
 *    阶段间分叉(Plan→Exec 从上一阶段会话 fork,继承前缀但不共享权限/脏轨迹/审批),
 *    只有拿不到父会话时才降级为全量 prompt 重放;
 *  - 会话控制作为底层能力:一个阶段实例一个 `QoderSession`(见 ./qoder-session.ts);
 *    `task.qoderSessionId` = 「最后一个结束的阶段实例会话指针」,不再当任务会话用;
 *    `interruptSession` 暂停时停止当前回复、保留会话;`closeSession` 任务终态时释放该任务全部阶段会话;
 *  - 事件上报:emit `TaskAgentEvent`(agent_start / agent_text / agent_end),每条都自带 taskId;
 *    每条 SDK 消息经 onMessage 钩子写日志 / 更新用量 / 写任务事件 / emitPi(子任务分组逻辑在 log.ts);
 *  - Phase 2 HITL:PermissionRequest hook 由上层(main.ts)弹 UI 确认;
 *  - runStage 直接返回本阶段产物(`responseTexts / sessionId`),`collectResult` 只作重入读缓存用。
 *
 * 不负责:任务工作流(状态机 / 计划 / 实现后续的校验、Review、MR) — 这些仍在 main.ts 里。
 */

import { QoderCliProcessError, type Query, type SDKMessage } from '@qoder-ai/qoder-agent-sdk'
import type { HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput } from '@qoder-ai/qoder-agent-sdk'
import type { Task, TaskRepository, TaskStore, AgentSpan } from '@task-pipeline/core'
import type { DriverPart } from '../../chat/chat-types.js'
import type { TracePipeline } from '../../trace/bus/trace-pipeline.js'
import type {
  TaskAgentDriver,
  TaskAgentDeps,
  TaskAgentEvent,
  TaskAgentResult,
  TaskAgentPhase,
  TaskAgentCapabilities,
  TaskStageInput
} from '../../agents/task-agent/task-agent-driver.js'
import { implementationOutcomeInstruction, testCaseGenerationInstruction } from '../../task/task-readiness.js'
import {
  PlanArtifactMismatchError,
  PLAN_SECTION_REQUIREMENT,
  checkPlanSections,
  readExecSummary,
  reconcilePlanArtifact,
  writeStageInputSnapshot
} from '../../task/stage-artifacts.js'
import type { PlanReconcile } from '../../task/stage-artifacts.js'
import { CODEBASE_SEARCH_STEERING } from '../../codeindex/codebase-search-tool.js'
import { QoderSession, QoderSessionRegistry } from './qoder-session.js'
import { buildToolSourceMcp } from './tool-source-mcp.js'
import {
  describeLaunch,
  hasSessionTranscript,
  inheritsContext,
  isResumableStartupFailure,
  nextLaunch,
  permissionsForStage,
  resolveForkAnchorUuid,
  stageIdOfTask,
  stageInstanceId,
  stagePhaseOf
} from './stage-session.js'
import type { ForkFallbackReason, SessionLaunch, StagePhase, StageSessionRef } from './stage-session.js'
import { QoderTraceBuilder } from './trace-builder.js'
import { logQoderMessage, qoderLogFile, recordQoderMessage } from './log.js'

/** 上下文预算缺省阈值（§5 建议值）：超过它就不 fork，改用产物重建会话。 */
export const CONTEXT_BUDGET_RATIO = 0.6

/**
 * Driver 注入的依赖(由 main.ts 在构造时传入,driver 不 import 顶层常量)。
 *
 * - `qoderTokenProvider`: 每次创建会话时重新拿一次 token(用户可在系统设置里改 qoderToken);
 * - `dataDir`: 日志根目录;
 * - `addTaskEvent`: 写任务事件;
 * - `emitPi`: emit qoder_event 给前端。
 */
export type QoderTaskAgentDeps = TaskAgentDeps & {
  store: TaskStore
  qoderTokenProvider: () => string | undefined
  dataDir: string
  /**
   * 上下文预算阈值（P4）：父会话最近一个回合的 `context_usage_ratio` 超过它就不再 fork，
   * 改用「产物 + 摘要」新建会话。缺省 0.6（§5 建议值）；可注入是为了单测能拿边界值跑。
   */
  contextBudgetRatio?: number
  addTaskEvent: (event: {
    taskId: string
    kind: 'message' | 'status' | 'error' | 'tool' | 'diff'
    title: string
    detail?: string
    parentTaskId?: string
    subtaskId?: string
    sdkSubtype?: string
    payload?: unknown
  }) => void
  emitPi: (event: { type: 'qoder_event'; taskId: string; message: SDKMessage }) => void
  /** 会话创建/关闭时给上层信号,让 main.ts 维护 activeQoderQuery 状态(中断/探测用)。 */
  onQueryStarted?: (query: Query, abort: AbortController) => void
  onQueryFinished?: (query: Query) => void
  /**
   * Phase 2 HITL：工具调用确认回调。
   * 返回 "allow" 放行该工具调用，返回 "deny" 拒绝（SDK 会把拒绝消息反馈给 agent，让它换方案）。
   * AskUserQuestion 返回 { type: 'askUser', answers } —— hook 组装为 SDK 的 allow + updatedInput。
   * 拒绝时返回 { type: 'deny', message } —— 使用自定义拒绝消息。
   * `signal` 为 SDK 传入的会话中止信号：任务被 abort 时确认框应立刻按拒绝处理。
   * 未注入时所有 PermissionRequest hook 直接放行（保持原行为）。
   */
  onPermissionRequest?: (
    taskId: string,
    toolName: string,
    toolInput: unknown,
    signal?: AbortSignal
  ) => Promise<'allow' | 'deny' | { type: 'askUser'; answers: string[] } | { type: 'deny'; message: string }>
  /**
   * 测试用例生成阶段的 Agent 上下文（角色定义 + 领域指引）。
   * 存在时优先使用，回退现有 resolveAgentContext。
   */
  resolveTestContext?: (task: Task, repos: TaskRepository[]) => Promise<{ sections: string[] }>
  /** 埋点管线：任务路径 span 采集（可选）。一次任务执行 = 一个 Trace（traceId = task.id）。 */
  tracePipeline?: TracePipeline
}

const PLAN_TIMEOUT_MS = 5 * 60_000

/** 任务会话注册的 `search_memory` MCP server 的 mcpServers 记录键。 */
const MEMORY_MCP_KEY = 'memory_search'

/**
 * 静态记忆工具使用指引（不依赖检索结果,恒在）：提醒模型涉及项目历史约定/经验时
 * 先调用 search_memory,而非凭空假设——取代旧的任务启动前记忆预注入。
 */
const MEMORY_SEARCH_TOOL_GUIDANCE =
  '如需项目历史约定、编码规范或过往经验,先调用 search_memory 工具检索再据此行动,不要凭空假设项目约定。'

/** 去掉 model value 上的 `qoder:` provider 前缀,让 qodercli 能识别。 */
export function stripQoderModelPrefix(model: string | undefined): string | undefined {
  if (!model) return undefined
  return model.startsWith('qoder:') ? model.slice('qoder:'.length) : model
}

type PhaseBuffers = {
  responseTexts: string[]
  sessionId?: string
}

/** 提取 DriverPart 的可见正文文本(agent_text / responseTexts 用;thinking 不入正文,与旧 qoderText 一致)。 */
function partTextOf(part: DriverPart): string | undefined {
  if (part.type === 'text') return part.text
  return undefined
}

/** Phase 2 HITL:PermissionRequest hook —— 危险工具由上层(main.ts)弹 UI 确认,其余直接 allow。 */
function buildPermissionHooks(
  onPermissionRequest: NonNullable<QoderTaskAgentDeps['onPermissionRequest']>,
  taskId: string,
  /** HITL 拒绝标记:deny 时写入 toolUseID,onMessage 据此补标 is_error。 */
  deniedCallIds: Set<string>
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PermissionRequest: [
      {
        hooks: [
          async (
            input: Parameters<HookCallback>[0],
            toolUseID?: string,
            options?: { signal: AbortSignal }
          ): Promise<HookJSONOutput> => {
            if (input.hook_event_name !== 'PermissionRequest') {
              return {
                hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
              }
            }
            const decision = await onPermissionRequest(taskId, input.tool_name, input.tool_input, options?.signal)
            // AskUserQuestion：用户回答通过 allow + updatedInput 注入（官方 SDK 协议），
            // answers 的 key 是完整的 question 文本，SDK 据此生成正常的 tool_result（非 error）。
            if (typeof decision === 'object' && decision.type === 'askUser') {
              const toolInputObj = (
                typeof input.tool_input === 'object' && input.tool_input ? input.tool_input : {}
              ) as Record<string, any>
              const questions = Array.isArray(toolInputObj.questions) ? toolInputObj.questions : []
              const answers: Record<string, string> = {}
              questions.forEach((q: any, i: number) => {
                if (q.question && decision.answers[i] !== undefined) {
                  answers[q.question] = decision.answers[i]
                }
              })
              return {
                hookSpecificOutput: {
                  hookEventName: 'PermissionRequest',
                  decision: { behavior: 'allow', updatedInput: { questions, answers } }
                }
              }
            }
            if (typeof decision === 'object' && decision.type === 'deny') {
              // 自定义拒绝消息（如 AskUserQuestion 取消）
              if (toolUseID) deniedCallIds.add(toolUseID)
              return {
                hookSpecificOutput: {
                  hookEventName: 'PermissionRequest',
                  decision: { behavior: 'deny', message: decision.message, interrupt: false }
                }
              }
            }
            if (decision === 'deny') {
              // HITL 拒绝标记:记录 toolUseID,onMessage 据此补标 is_error。
              if (toolUseID) deniedCallIds.add(toolUseID)
              return {
                hookSpecificOutput: {
                  hookEventName: 'PermissionRequest',
                  decision: { behavior: 'deny', message: '用户拒绝了此操作，请改用其他方案', interrupt: false }
                }
              }
            }
            return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
          }
        ]
      }
    ]
  } satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>
}

/**
 * Qoder Task Agent Driver(常驻会话版)。
 */
export class QoderTaskAgentDriver implements TaskAgentDriver {
  readonly id = 'qoder' as const
  readonly displayName = 'Qoder Agent SDK'

  private readonly sessions = new QoderSessionRegistry()
  /** taskId → 当前阶段实例（会话的归属单位；阶段切换即换新实例）。 */
  private readonly currentStage = new Map<string, StageSessionRef>()
  /** taskId → 阶段实例序号（单调递增，保证 stageInstanceId 在一次运行内唯一）。 */
  private readonly stageSeqByTask = new Map<string, number>()
  /**
   * `taskId:planRevision` → Plan→Exec 交接对账结果（产物路径 / sha / 三段完整性）。
   *
   * 按 revision 缓存：一次计划最多对账一次，auto-fix 多轮重跑不重复读盘；
   * 用户编辑计划会 bump revision，天然让缓存失效。
   */
  private readonly planHandoff = new Map<string, PlanReconcile>()
  /** 阶段产物按 (taskId, phase) 隔离:driver 是进程级单例,不同任务可并发。 */
  private readonly buffers = new Map<string, PhaseBuffers>()
  /** 回合上下文按 taskId 隔离(onMessage 钩子读 recordText 用;不同任务可并发,不能用单字段)。 */
  private readonly turnCtxByTaskId = new Map<string, { recordText: boolean; phase: TaskAgentPhase }>()
  /** 已开启任务 trace 的 taskId（一次任务执行 = 一个 Trace，只 begin 一次）。 */
  private readonly traceStarted = new Set<string>()
  /** taskId → Qoder span 转换器。 */
  private readonly traceBuilders = new Map<string, QoderTraceBuilder>()
  /** taskId → 当前阶段 agent.run span。 */
  private readonly traceAgentSpans = new Map<string, AgentSpan>()
  /** (taskId, phase) → 已执行次数：阶段 span meta.attempt（同 phase 第几次执行，恢复/续接展示用）。 */
  private readonly phaseAttempts = new Map<string, number>()
  /** 已做过「关键词提取 + 记忆上下文注入」的任务（每任务只做一次；finishTrace 清理，任务重跑会重置）。 */
  private readonly keywordInjected = new Set<string>()
  /** taskId → HITL 拒绝的工具调用 ID 集合(hooks deny / canUseTool deny 时写入)。 */
  private readonly deniedCallIdsByTask = new Map<string, Set<string>>()
  /**
   * stageInstanceId → 本实例最近一个回合的上下文占用比（P4 预算）。
   *
   * 只能用 ratio：V7 实测 `input_tokens / total_cost_usd / contextWindow` 全为 0。
   * 按实例而不是按任务记：预算要评的是「将要 fork 的那个父会话有多满」。
   */
  private readonly contextRatio = new Map<string, number>()

  /**
   * Qoder 走 SDK 的 `resume + forkSession(+ resumeSessionAt)`：阶段边界能分叉、能截断（§1 V1–V4）。
   * P4 后会话权限按阶段实例给定（`permissionsForStage`），Plan 阶段写类工具从 CLI 层就禁掉。
   */
  capabilities(): TaskAgentCapabilities {
    return { fork: true, truncateAt: true, perPhasePermission: true }
  }

  /**
   * 按阶段实例执行一次（§6）：三个旧 `runPlan / runImplementation / runTestGeneration` 收敛到这里，
   * 编排层不再按运行时方法名分支，只看 `capabilities()`。
   */
  async runStage(input: TaskStageInput): Promise<TaskAgentResult> {
    switch (input.phase) {
      case 'planning':
        return this.runPlanningStage(input)
      case 'test_generation':
        return this.runTestGenerationStage(input)
      default:
        return this.runImplementationStage(input)
    }
  }

  constructor(private readonly deps: QoderTaskAgentDeps) {
    if (!deps) throw new Error('QoderTaskAgentDriver requires deps')
    if (!deps.qoderTokenProvider) throw new Error('QoderTaskAgentDriver requires qoderTokenProvider')
  }

  /** 任务 trace 惰性开启：begin + task.run 根 span（仅首次）；恢复/续接时复用历史根。 */
  private ensureTaskTrace(task: Task): void {
    const pipeline = this.deps.tracePipeline
    if (!pipeline) return
    if (!this.traceStarted.has(task.id)) {
      this.traceStarted.add(task.id)
      pipeline.beginTrace({
        traceId: task.id,
        kind: 'task',
        title: task.title,
        source: 'qoder',
        ...(task.qoderModel ? { model: stripQoderModelPrefix(task.qoderModel) } : {})
      })
    }
    // 根 span 恢复安全：任务终态后 driver 内存标记被清（finishTrace），恢复/续接
    // （含应用重启后）再进 ensureTaskTrace 时，存储中已有历史 task.run 根——
    // ensureRootSpan 复用历史根并挂回栈底，不再向同一 JSONL 追加第二个根（Bug A）。
    pipeline.ensureRootSpan(task.id, {
      type: 'task.run',
      name: '任务执行',
      meta: { source: 'qoder' }
    })
    if (!this.traceBuilders.has(task.id)) {
      this.traceBuilders.set(
        task.id,
        new QoderTraceBuilder(pipeline, task.id, 'task', 'qoder', stripQoderModelPrefix(task.qoderModel))
      )
    }
  }

  /**
   * keyword 阶段容器：包裹记忆/Agent 上下文解析段（含关键词提取 llm 调用）。
   * 容器 = agent.run span + meta.phase='keyword'；解析期间 llm span 挂栈顶自然落入容器，
   * 执行 Tab / Trace 页据此把「关键词提取并注入」渲染为独立顶层阶段卡，而非与 Plan 混排。
   */
  private async withKeywordStage<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const pipeline = this.deps.tracePipeline
    if (!pipeline || !this.traceStarted.has(taskId)) return fn()
    const span = pipeline.startSpan(taskId, {
      type: 'agent.run',
      name: '关键词提取并注入',
      meta: { source: 'qoder', phase: 'keyword' }
    })
    try {
      return await fn()
    } finally {
      pipeline.endSpan(taskId, span)
    }
  }

  /**
   * 任务上下文解析（Agent 指引注入每任务只做一次 trace 容器）：
   * - 首次：keyword 阶段容器内解析 —— Agent 指引（记忆不再预注入，改由会话注册的
   *   search_memory 工具按需检索）；
   * - 之后：仅组装 Agent 指引；任务终态 finishTrace 清标记，任务重跑会重新解析。
   */
  private async resolveTaskContext(
    task: Task,
    repos: TaskRepository[]
  ): Promise<{ agentContext: { sections: string[] } | undefined }> {
    if (this.keywordInjected.has(task.id)) {
      const agentContext = await this.deps.resolveAgentContext?.(task, repos)
      return { agentContext }
    }
    this.keywordInjected.add(task.id)
    return this.withKeywordStage(task.id, async () => {
      const agentContext = await this.deps.resolveAgentContext?.(task, repos)
      return { agentContext }
    })
  }

  private async runPlanningStage(input: TaskStageInput): Promise<TaskAgentResult> {
    const { task, repos, signal, feedback, trigger } = input
    // 任务 trace 提前 begin：在记忆/Agent 上下文检索之前就绪（幂等），
    // 让 Trace 页在首个 SDK 消息到达前就能看到任务执行记录。
    this.ensureTaskTrace(task)
    // Plan 阶段的会话策略(统一走 planLaunch,不因 feedback 而分岵):
    //  - 同一 plan 实例已存活 → continue（追加一条修订指令）;
    //  - 无存活实例但有持久化会话（应用重启后重新出计划）→ resume 后追加;
    //  - 两者都没有（首次 plan）→ 新建会话 + 全量任务上下文。
    // 无条件 init 会导致此前分析/计划数据全部丢失。
    const launch = await this.planLaunch(task, 'planning', repos)

    return this.runTurn({
      task,
      repos,
      phase: 'planning',
      stageInstanceId: launch.stageInstanceId,
      launch,
      promptFor: (current, report) => this.planPrompt(task, repos, feedback, current, report),
      signal,
      recordText: false,
      hardTimeoutMs: PLAN_TIMEOUT_MS,
      ...(trigger ? { trigger } : {})
    })
  }

  /** Plan 阶段 prompt:继承上下文时只发阶段指令,全量重放时才拼任务上下文。 */
  private async planPrompt(
    task: Task,
    repos: TaskRepository[],
    feedback: string | undefined,
    launch: SessionLaunch,
    report: { injected: string[] }
  ): Promise<string> {
    // 三段约束两个分支都要给：续接分支同样在重出计划，产物缺段会让下一阶段无法拆边界（§4.3）。
    if (inheritsContext(launch)) {
      report.injected.push('planSectionRequirement')
      return [
        feedback
          ? `根据以下调整意见，重新生成实施计划（沿用此前已分析的任务上下文）：\n${feedback}`
          : '请基于当前会话上下文重新审视，并输出一份更完善的实施计划。',
        '禁止修改文件，禁止执行安装、构建或其他会改变工作区的命令。',
        '最终只输出一个 JSON 对象，不要输出过程说明或 Markdown 代码块。若代码已满足要求，输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；否则输出 {"outcome":"changes_required","plan":"完整实施计划"}。',
        PLAN_SECTION_REQUIREMENT
      ].join('\n\n')
    }
    // 全量重放（首次 plan / fork 不可用）：任务上下文只能在这里重新注入，Agent 指引每任务只做一次。
    const { agentContext } = await this.resolveTaskContext(task, repos)
    report.injected.push('agentContext', 'taskContext', 'planSectionRequirement')
    return [
      ...(agentContext?.sections ?? []),
      MEMORY_SEARCH_TOOL_GUIDANCE,
      CODEBASE_SEARCH_STEERING,
      '请只读分析以下 Coding 任务。可委派内置 Plan 子代理(Agent 工具)协助制定计划,也可直接分析输出。',
      `任务:${task.title}`,
      task.description,
      `验收标准:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
      feedback ? `上一次计划的调整意见:\n${feedback}` : '',
      '禁止修改文件，禁止执行安装、构建或其他会改变工作区的命令。',
      '最终只输出一个 JSON 对象，不要输出过程说明或 Markdown 代码块。若代码已满足要求，输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；否则输出 {"outcome":"changes_required","plan":"完整实施计划"}。',
      PLAN_SECTION_REQUIREMENT
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  private async runImplementationStage(input: TaskStageInput): Promise<TaskAgentResult> {
    const { task, repos, signal, resumeSessionId, extraPrompt, trigger, round } = input
    // 任务 trace 提前 begin（幂等）：实现阶段与计划阶段共享同一 Trace。
    this.ensureTaskTrace(task)
    const launch = await this.planLaunch(task, 'implementation', repos, resumeSessionId)

    return this.runTurn({
      task,
      repos,
      phase: 'implementation',
      stageInstanceId: launch.stageInstanceId,
      launch,
      promptFor: (current, report) =>
        this.implementationPrompt(task, repos, extraPrompt, resumeSessionId, current, report),
      signal,
      recordText: true,
      ...(trigger ? { trigger } : {}),
      ...(round !== undefined ? { round } : {})
    })
  }

  /** Implementation 阶段 prompt。 */
  private async implementationPrompt(
    task: Task,
    repos: TaskRepository[],
    extraPrompt: string | undefined,
    resumeSessionId: string | undefined,
    launch: SessionLaunch,
    report: { injected: string[] }
  ): Promise<string> {
    const handoff = await this.planHandoffFor(task)
    const planPath = handoff.meta?.planPath
    if (resumeSessionId && launch.mode !== 'new') {
      // 恢复:会话上下文已包含原 Agent 指引,不重新拼。
      report.injected.push('resumeInstruction')
      return extraPrompt ?? '任务此前执行失败/中断，请基于当前会话上下文继续完成剩余工作。'
    }
    if (inheritsContext(launch)) {
      // 同会话续接 / 从 plan 会话 fork:上下文已在会话前缀里,但**已批准的计划正文必须重新给**。
      // 用户在 EditPlanDialog 手改后写回 task.planContent,而会话里存的是修改前的对话文本 ——
      // 只说「严格按 Plan 执行」会让人批的文本与模型跑的内容不一致。
      report.injected.push('planContent')
      if (planPath) report.injected.push('planArtifactPath')
      return [
        '现在开始执行 Implementation 阶段。',
        '1. 严格按照以下已批准的实施计划执行;若计划与你的判断冲突,以计划为准并在回复中说明冲突点。',
        task.planContent ?? '',
        // 产物路径是给「需要更多细节时局部 Read」用的；人工编辑过必须显式说，
        // 否则模型会优先相信会话里那份修改前的讨论。
        planPath
          ? `计划正文的当前版本在 ${planPath}${
              handoff.meta?.editedBy === 'user' ? '；用户已手动编辑过本版，会话中的旧计划讨论一律作废' : ''
            }。`
          : '',
        '2. 按依赖顺序逐个修改文件，每完成一个文件简要说明修改内容。',
        '3. 如遇到方案中未覆盖的问题，主动询问后再继续。',
        extraPrompt ? `4. 用户附加要求:\n${extraPrompt}` : '',
        implementationOutcomeInstruction
      ]
        .filter(Boolean)
        .join('\n')
    }
    // 全量重放(未经过 plan 直接执行,或 fork 降级到底):无会话可继承,全量上下文兜底。
    const { agentContext } = await this.resolveTaskContext(task, repos)
    report.injected.push('agentContext', 'taskContext')
    if (task.planContent) report.injected.push('planContent')
    return [
      ...(agentContext?.sections ?? []),
      MEMORY_SEARCH_TOOL_GUIDANCE,
      CODEBASE_SEARCH_STEERING,
      task.title,
      task.description,
      task.planContent ? `Approved implementation plan:\n${task.planContent}` : '',
      `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
      extraPrompt ? `Additional request:\n${extraPrompt}` : '',
      implementationOutcomeInstruction
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  private async runTestGenerationStage(input: TaskStageInput): Promise<TaskAgentResult> {
    const { task, repos, signal } = input
    // 任务 trace 提前 begin（幂等）：测试阶段与实现阶段共享同一 Trace。
    this.ensureTaskTrace(task)
    const launch = await this.planLaunch(task, 'test_generation', repos)

    return this.runTurn({
      task,
      repos,
      phase: 'test_generation',
      stageInstanceId: launch.stageInstanceId,
      launch,
      promptFor: (current, report) => this.testGenerationPrompt(task, repos, current, report),
      signal,
      recordText: true
    })
  }

  /** Test 阶段 prompt（P2：独立阶段实例，从 implementation 会话 fork，输入是改动摘要）。 */
  private async testGenerationPrompt(
    task: Task,
    repos: TaskRepository[],
    launch: SessionLaunch,
    report: { injected: string[] }
  ): Promise<string> {
    // exec.summary.md 由实现收尾时写入（改动文件清单 + Agent 结论），拆边界后它就是 Test 的全部输入。
    const execSummary = await readExecSummary(this.deps.dataDir, task.id)
    const changedLines = this.changedFilesLines(repos)
    if (inheritsContext(launch)) {
      report.injected.push('testInstruction')
      if (execSummary) report.injected.push('execSummary')
      if (changedLines.length > 0) report.injected.push('changedFiles')
      return [
        '现在进入 Test 阶段。以下为本次实现的实际改动：',
        changedLines.length > 0 ? `改动仓库与摘要：\n${changedLines.join('\n')}` : '',
        execSummary ?? '',
        '只针对上述改动产出最小测试集，不要修改业务逻辑。',
        testCaseGenerationInstruction
      ]
        .filter(Boolean)
        .join('\n\n')
    }
    // 无会话兜底(重启后直接补测、或 fork 降级到底):全量上下文。
    const agentContext = this.deps.resolveTestContext
      ? await this.deps.resolveTestContext(task, repos)
      : await this.deps.resolveAgentContext?.(task, repos)
    report.injected.push('agentContext', 'taskContext', 'testInstruction')
    if (task.planContent) report.injected.push('planContent')
    if (execSummary) report.injected.push('execSummary')
    return [
      ...(agentContext?.sections ?? []),
      task.title,
      task.description,
      task.planContent ? `Approved implementation plan:\n${task.planContent}` : '',
      changedLines.length > 0 ? `改动仓库与摘要：\n${changedLines.join('\n')}` : '',
      execSummary ?? '',
      testCaseGenerationInstruction
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  /** 从 DB 里的仓库改动摘要拼测试阶段输入（不起 git 进程，driver 不依赖 GitService）。 */
  private changedFilesLines(repos: TaskRepository[]): string[] {
    return repos.filter((repo) => repo.changeSummary).map((repo) => `- ${repo.name}: ${repo.changeSummary}`)
  }

  /** 缓冲按 `${taskId}:${phase}` 存，重入路径（同一阶段跑完再看产物）读同一份。 */
  collectResult(taskId: string, phase: TaskAgentPhase): TaskAgentResult {
    const buffers = this.buffers.get(`${taskId}:${phase}`)
    return {
      responseTexts: buffers?.responseTexts ? [...buffers.responseTexts] : [],
      ...(buffers?.sessionId ? { sessionId: buffers.sessionId } : {})
    }
  }

  /**
   * 只释放一个阶段实例的会话（同任务的其它阶段不动）。
   *
   * 当前没有调用方在阶段中途释放：阶段结束后会话还要留着给同阶段续接（auto-fix / 追问），
   * 真正的释放点是 `closeSession`（任务终态级联）。接口先按契约提供，不假装它已被使用。
   */
  releaseStage(stageInstanceId: string): void {
    if (this.currentStage.get(stageInstanceId.split(':')[0] ?? '')?.id === stageInstanceId)
      this.currentStage.delete(stageInstanceId.split(':')[0] ?? '')
    this.contextRatio.delete(stageInstanceId)
    void this.sessions.close(stageInstanceId)
  }

  /** 关闭指定任务的全部阶段会话(任务完成 / 失败 / 取消时由 main.ts 调用),并清理其阶段产物。 */
  closeSession(taskId: string): void {
    // 会话注册表以阶段实例为 key:同一任务可能同时有 plan / exec 两个会话,按前缀级联关。
    void this.sessions.closeMatching((id) => stageIdOfTask(id, taskId))
    // 阶段实例归属一起丢:任务终态后的再次执行属于新一轮阶段，不该续旧会话。
    this.currentStage.delete(taskId)
    // 释放该任务累积的阶段产物,避免 Map 无限增长。
    for (const key of this.buffers.keys()) {
      if (key.startsWith(`${taskId}:`)) this.buffers.delete(key)
    }
    this.deniedCallIdsByTask.delete(taskId)
    // 交接对账结果不跨任务终态：重置/完成后重新出的计划必须重新导出。
    for (const key of this.planHandoff.keys()) {
      if (key.startsWith(`${taskId}:`)) this.planHandoff.delete(key)
    }
    for (const key of this.contextRatio.keys()) {
      if (key.startsWith(`${taskId}:`)) this.contextRatio.delete(key)
    }
  }

  /** 任务终态收尾 trace 采集：关闭 builder 未收尾的 llm/工具/子任务 span，并清理 taskId 相关状态。 */
  finishTrace(taskId: string): void {
    const builder = this.traceBuilders.get(taskId)
    if (builder) {
      try {
        builder.finish()
      } catch {
        /* trace 收尾失败不影响任务 */
      }
      this.traceBuilders.delete(taskId)
    }
    this.traceStarted.delete(taskId)
    this.keywordInjected.delete(taskId)
    this.deniedCallIdsByTask.delete(taskId)
    this.traceAgentSpans.delete(taskId)
    this.stageSeqByTask.delete(taskId)
    for (const key of this.phaseAttempts.keys()) {
      if (key.startsWith(`${taskId}:`)) this.phaseAttempts.delete(key)
    }
  }

  /** 停止指定任务当前回复、保留会话(暂停任务时由 main.ts 调用)。 */
  interruptSession(taskId: string): void {
    const stage = this.currentStage.get(taskId)
    const session = stage ? this.sessions.get(stage.id) : undefined
    if (session) void session.interrupt()
  }

  /** 当前阶段实例(会话归属)；上层查询用。 */
  getStageSession(taskId: string): StageSessionRef | undefined {
    return this.currentStage.get(taskId)
  }

  /** 查询指定任务的 HITL 拒绝 ID 集合(暂停兜底用:延迟二次扫描精确覆盖漏标的 isError)。 */
  getDeniedCallIds(taskId: string): Set<string> {
    return this.deniedCallIdsByTask.get(taskId) ?? new Set()
  }

  dispose(): void {
    void this.sessions.dispose()
  }

  // === 内部实现 =============================================================

  private emit(event: TaskAgentEvent): void {
    this.deps.emit(event)
  }

  private ensureBuffers(taskId: string, phase: TaskAgentPhase): PhaseBuffers {
    const key = `${taskId}:${phase}`
    let buffers = this.buffers.get(key)
    if (!buffers) {
      buffers = { responseTexts: [] }
      this.buffers.set(key, buffers)
    }
    return buffers
  }

  /**
   * 打开（或复用）本阶段实例的会话。
   *
   * 注册表 key = stageInstanceId：同一任务的 plan / exec 会话互不可见；降级重试时
   * 沿用同一 id（前一次尝试的会话已先关闭），保证一个阶段实例始终只对应一个活会话。
   *
   * 权限按**实际执行的阶段**取（`stagePhase`），不按实例归属阶段：`plan_schema_incomplete`
   * 会让实现阶段沿用计划的实例 id，若权限也跟着实例走，实现阶段就拿到一个只读会话（改不了
   * 文件）。那种情形下 `planLaunch` 已先把旧会话关掉改成 resume，因此不会走到 `existing`。
   */
  private ensureSession(
    task: Task,
    repos: TaskRepository[],
    launch: SessionLaunch,
    stagePhase: StagePhase
  ): QoderSession {
    const existing = this.sessions.get(launch.stageInstanceId)
    if (existing) return existing
    if (repos.length === 0) throw new Error('任务未关联代码仓库')
    const primary = repos[0]!
    const token = this.deps.qoderTokenProvider()
    if (!token) throw new Error('请先配置 Qoder Token')
    const logFile = qoderLogFile(this.deps.dataDir, task.id)
    // HITL 拒绝标记:hooks deny 时写入 toolUseID,onMessage 据此补标 is_error。
    // 提升到 driver 级别,pauseTask 延迟二次扫描可跨异步时序查询。
    const deniedCallIds = new Set<string>()
    this.deniedCallIdsByTask.set(task.id, deniedCallIds)
    const permissionHooks = this.deps.onPermissionRequest
      ? buildPermissionHooks(this.deps.onPermissionRequest, task.id, deniedCallIds)
      : undefined
    // 记忆检索工具：任务会话创建时注册为自定义 MCP 工具（取代旧的任务启动前预注入）。
    const memoryDeclarations = this.deps.resolveMemoryTools?.(task, repos) ?? []
    const memoryMcp = memoryDeclarations.length ? buildToolSourceMcp(MEMORY_MCP_KEY, memoryDeclarations) : undefined
    const session = new QoderSession(launch.stageInstanceId, {
      token,
      cwd: primary.worktreePath ?? primary.localPath,
      additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath),
      ...(this.deps.resolveModel ? { model: stripQoderModelPrefix(this.deps.resolveModel(task)) } : {}),
      ...(launch.resume ? { resume: launch.resume } : {}),
      ...(launch.forkSession ? { forkSession: true } : {}),
      ...(launch.resumeSessionAt ? { resumeSessionAt: launch.resumeSessionAt } : {}),
      ...permissionsForStage(stagePhase),
      // 预授权 Agent 工具:让模型可委派内置子代理(Plan 等);不限制其它默认工具。
      // search_memory 由宿主自己检索、无副作用,同样预授权免弹框。
      allowedTools: ['Agent', ...(memoryMcp?.toolNames ?? [])],
      ...(memoryMcp
        ? {
            mcpServers: { [MEMORY_MCP_KEY]: memoryMcp.server },
            allowedMcpServerNames: [MEMORY_MCP_KEY]
          }
        : {}),
      ...(permissionHooks ? { hooks: permissionHooks } : {}),
      onMessage: (message) => {
        // HITL 拒绝补标:hooks deny 时 SDK 不一定设 is_error,由 deniedCallIds 补标。
        // 在 recordQoderMessage 之前修改,保证 task event 带 isError: true。
        const msgContent = (message as unknown as Record<string, any>)?.message?.content
        if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (
              block &&
              typeof block === 'object' &&
              block.type === 'tool_result' &&
              typeof block.tool_use_id === 'string' &&
              deniedCallIds.has(block.tool_use_id)
            ) {
              block.is_error = true
              deniedCallIds.delete(block.tool_use_id)
            }
          }
        }
        logQoderMessage(logFile, message)
        const ctx = this.turnCtxByTaskId.get(task.id)
        if (ctx) {
          recordQoderMessage(this.deps.store, task.id, message, {
            recordText: ctx.recordText,
            pipelinePhase: ctx.phase,
            addTaskEvent: this.deps.addTaskEvent,
            emitPi: this.deps.emitPi
          })
        }
        // 任务 trace：SDKMessage 逐条喂给 span 转换器。
        try {
          this.traceBuilders.get(task.id)?.onMessage(message as never)
        } catch {
          /* 忽略:trace 采集失败不能影响任务 */
        }
      },
      onQueryStarted: (query, abort) => this.deps.onQueryStarted?.(query, abort),
      onQueryFinished: (query) => this.deps.onQueryFinished?.(query)
    })
    this.sessions.register(launch.stageInstanceId, session)
    return session
  }

  /** 开一个新的阶段实例（同任务单调递增序号），并登记为当前阶段。 */
  private beginStageInstance(taskId: string, phase: StagePhase, parentSessionId?: string): StageSessionRef {
    const seq = (this.stageSeqByTask.get(taskId) ?? 0) + 1
    this.stageSeqByTask.set(taskId, seq)
    const ref: StageSessionRef = { id: stageInstanceId(taskId, phase, seq), phase }
    if (parentSessionId) ref.parentSessionId = parentSessionId
    this.currentStage.set(taskId, ref)
    return ref
  }

  /**
   * 只有「刚出计划、尚未实现」的持久化会话才能当 fork 父。
   *
   * `task.qoderSessionId` 是「最后一个结束的阶段实例会话」，除 `awaiting_plan_approval` 外
   * 它完全可能指向上一轮实现会话 —— 继承它就是 §2.3 要治的脏轨迹继承。
   */
  private persistedPlanSession(task: Task): string | undefined {
    return task.state === 'awaiting_plan_approval' ? task.qoderSessionId : undefined
  }

  /**
   * Plan → Exec 交接对账（§4.2）：导出/校验 `plan.v<n>.md` + `.json`，DB 始终是真值。
   *
   * 同一 revision 只跑一次；sha 对不上时抛 PlanArtifactMismatchError 让阶段失败——
   * 「静默取其一」正是本轮要根治的缺陷。写盘 I/O 失败则降为「无产物」继续跑（计划正文
   * 本来就在 DB 里），但缺段判定仍按 DB 正文算，不能因为读不到文件就当契约完整。
   */
  private async planHandoffFor(task: Task): Promise<PlanReconcile> {
    const key = `${task.id}:${task.planRevision ?? 0}`
    const cached = this.planHandoff.get(key)
    if (cached) return cached
    let reconcile: PlanReconcile
    try {
      reconcile = await reconcilePlanArtifact(this.deps.dataDir, task)
    } catch (error) {
      if (error instanceof PlanArtifactMismatchError) {
        this.deps.addTaskEvent({
          taskId: task.id,
          kind: 'error',
          title: '计划产物与已批准计划不一致',
          detail: `${error.message}\n已拒绝启动实现阶段：请重新生成计划，或删除旧产物后重试。`
        })
        throw error
      }
      this.deps.addTaskEvent({
        taskId: task.id,
        kind: 'error',
        title: '计划产物读写失败，本阶段改用数据库里的计划正文',
        detail: error instanceof Error ? error.message : String(error)
      })
      reconcile = { status: 'absent', sections: checkPlanSections(task.planContent) }
    }
    if (reconcile.status === 'repaired') {
      // 写盘未完成（md 缺失/被截断）：按 DB 重新导出。这不算静默取值，但必须留痕。
      this.deps.addTaskEvent({
        taskId: task.id,
        kind: 'status',
        title: '计划产物已按数据库重新导出',
        detail: `第 ${reconcile.meta?.revision ?? 0} 版：${reconcile.meta?.planPath ?? ''}`
      })
    }
    this.planHandoff.set(key, reconcile)
    return reconcile
  }

  /** 复用当前阶段实例：会话还活着就续接，否则按 sessionId resume。 */
  private async reuseLaunch(ref: StageSessionRef, resumeHint?: string): Promise<SessionLaunch> {
    if (this.sessions.get(ref.id)) return { mode: 'continue', stageInstanceId: ref.id }
    const resume = resumeHint ?? ref.qoderSessionId
    return resume ? { mode: 'resume', stageInstanceId: ref.id, resume } : { mode: 'continue', stageInstanceId: ref.id }
  }

  /**
   * 决定本次阶段执行的会话启动方式（§3 + §4.3，docs/task-stage-session-boundary-plan.md）。
   *
   * 必须在拼 prompt 之前完成：继承上下文（continue/resume/fork）只发阶段指令，
   * 全量重放（new）才重新注入任务/记忆/Agent 上下文。
   */
  private async planLaunch(
    task: Task,
    phase: TaskAgentPhase,
    repos: TaskRepository[],
    explicitResume?: string
  ): Promise<SessionLaunch> {
    const stagePhase = stagePhaseOf(phase)
    const current = this.currentStage.get(task.id)

    // 1. 同一阶段实例内：续接（plan 重跑 / auto-fix / 暂停恢复 / test 重跑）。
    if (current && current.phase === stagePhase) return this.reuseLaunch(current, explicitResume ?? task.qoderSessionId)

    // 2. 阶段切换。Exec 拆边界的前提是「计划契约完整」（三段齐，§4.3）：那是纯正文
    //    判定，必须在关旧会话之前算完 —— 存量任务缺三段时不拆边界，继续共享当前会话，
    //    只在 Trace / 事件上标 plan_schema_incomplete（宁可少一层隔离，也不造「输入缺上下文」的新会话）。
    if (stagePhase === 'implementation' && current && !checkPlanSections(task.planContent).complete) {
      // 沿旧实例但不沿旧权限（P4）：活着的计划会话带只读边界，直接续接会让实现阶段改不了文件。
      // 改成按 sessionId resume：上下文前缀照样保留（这正是「不拆边界」要省的探索），只重建工具权限。
      // 关旧会话必须排在读盘 / 对账之前（与下面的「先关再碰磁盘」同一条理由）：旧会话一旦被 await 让出，
      // 就会继续消费自己的输出流，把本该属于新会话的内容读进已废弃的回合缓冲。
      if (this.sessions.get(current.id) && current.phase !== stagePhase && current.qoderSessionId) {
        const resume = current.qoderSessionId
        await this.sessions.close(current.id)
        await this.planHandoffFor(task)
        return {
          mode: 'resume',
          stageInstanceId: current.id,
          resume,
          downgradeStep: 1,
          fallback: 'plan_schema_incomplete'
        }
      }
      await this.planHandoffFor(task)
      const reuse = await this.reuseLaunch(current, explicitResume)
      return { ...reuse, downgradeStep: 1, fallback: 'plan_schema_incomplete' }
    }

    // 先关上一实例的会话，再碰磁盘：对账失败也不该让旧会话带着脏上下文继续活着。
    if (current) await this.sessions.close(current.id)
    const handoff =
      stagePhase === 'implementation' || stagePhase === 'test' ? await this.planHandoffFor(task) : undefined
    const cwd = repos[0]?.worktreePath ?? repos[0]?.localPath

    if (stagePhase === 'planning') {
      // Plan 是任务起点，永不 fork；重启后重新出计划时按持久化指针 resume。
      const ref = this.beginStageInstance(task.id, 'planning')
      const resume = current ? undefined : (explicitResume ?? task.qoderSessionId)
      return resume ? { mode: 'resume', stageInstanceId: ref.id, resume } : { mode: 'new', stageInstanceId: ref.id }
    }

    // 3. Implementation / Test：优先从上一阶段会话 fork（Exec 父=plan 会话，Test 父=Exec 会话）。
    if (!current && explicitResume) {
      // 重启后恢复一个已失败的实现任务：没有阶段实例可续，按会话 id resume（失败则全量重放）。
      const ref = this.beginStageInstance(task.id, stagePhase)
      return { mode: 'resume', stageInstanceId: ref.id, resume: explicitResume }
    }
    // Test 不能回退到 plan 会话：它需要的是「改了什么」，不是「打算改什么」。
    const parentSessionId =
      current?.qoderSessionId ?? (stagePhase === 'implementation' ? this.persistedPlanSession(task) : undefined)
    if (!parentSessionId || !cwd) {
      const ref = this.beginStageInstance(task.id, stagePhase)
      return {
        mode: 'new',
        stageInstanceId: ref.id,
        ...(handoff && !handoff.sections.complete
          ? { downgradeStep: 1, fallback: 'plan_schema_incomplete' as const }
          : {})
      }
    }
    const ref = this.beginStageInstance(task.id, stagePhase, parentSessionId)
    // 3.1 上下文预算（P4，§5）：父会话已装得很满时，fork 不是省成本 —— 它是「继承前缀」
    //     而不是「丢弃前缀」（V8：headless 会话不自动压缩），子会话会一直带着那份膨胀。
    //     此时阶段产物就是更便宜的输入：改走全量重建，并落事件让降级可见。
    const parentRatio =
      current && current.qoderSessionId === parentSessionId ? this.contextRatio.get(current.id) : undefined
    const budget = this.deps.contextBudgetRatio ?? CONTEXT_BUDGET_RATIO
    if (parentRatio !== undefined && parentRatio > budget) {
      this.deps.addTaskEvent({
        taskId: task.id,
        kind: 'status',
        title: '阶段会话改用全量重建（上下文超预算）',
        detail: `上一阶段会话上下文占用 ${(parentRatio * 100).toFixed(1)}%，超过阈值 ${(budget * 100).toFixed(
          0
        )}%：不再 fork，改为从阶段产物重建上下文（本阶段会重新探索一次仓库）。`
      })
      return { mode: 'new', stageInstanceId: ref.id, downgradeStep: 1, fallback: 'context-budget' }
    }
    if (!(await hasSessionTranscript(parentSessionId, cwd)))
      return { mode: 'new', stageInstanceId: ref.id, downgradeStep: 1, fallback: 'parent-session-missing' }
    const anchor = await resolveForkAnchorUuid(parentSessionId, cwd)
    return anchor
      ? {
          mode: 'fork',
          stageInstanceId: ref.id,
          resume: parentSessionId,
          forkSession: true,
          resumeSessionAt: anchor,
          anchorEntryUuid: anchor
        }
      : {
          mode: 'fork',
          stageInstanceId: ref.id,
          resume: parentSessionId,
          forkSession: true,
          downgradeStep: 1,
          fallback: 'anchor-unavailable'
        }
  }

  /**
   * 阶段输入快照：`<dataDir>/tasks/<taskId>/stages/<stageInstanceId>.json`。
   *
   * 只存「输入是怎么拼出来的」（启动方式 / fork 点 / 降级原因 / 注入块清单），
   * prompt 全文已在 span 的 `input` 里，不重复占磁盘。
   */
  private async writeStageSnapshot(
    task: Task,
    phase: TaskAgentPhase,
    attempt: { launch: SessionLaunch; promptChars: number; injected: string[] } | undefined
  ): Promise<string | undefined> {
    if (!attempt) return undefined
    const handoff = this.planHandoff.get(`${task.id}:${task.planRevision ?? 0}`)
    return writeStageInputSnapshot(this.deps.dataDir, {
      stageInstanceId: attempt.launch.stageInstanceId,
      taskId: task.id,
      phase,
      sessionMode: attempt.launch.mode,
      ...(attempt.launch.resume ? { parentSessionId: attempt.launch.resume } : {}),
      ...(attempt.launch.anchorEntryUuid ? { anchorEntryUuid: attempt.launch.anchorEntryUuid } : {}),
      ...(attempt.launch.downgradeStep ? { downgradeStep: attempt.launch.downgradeStep } : {}),
      ...(attempt.launch.fallback ? { fallback: attempt.launch.fallback } : {}),
      promptChars: attempt.promptChars,
      injected: attempt.injected,
      ...(handoff?.meta?.planPath ? { planPath: handoff.meta.planPath, planSha256: handoff.meta.sha256 } : {}),
      ...(handoff ? { planSectionsComplete: handoff.sections.complete } : {})
    })
  }

  /** 降级原因分类：只能从 CLI 的 stderr 区分「anchor 被拒」与「其他启动失败」。 */
  private fallbackReasonFor(launch: SessionLaunch, error: unknown): ForkFallbackReason {
    if (launch.mode === 'resume') return 'resume-failed'
    if (launch.mode !== 'fork') return 'session-lost'
    const text =
      error instanceof Error
        ? `${error.message} ${(error as QoderCliProcessError & { stderr?: string }).stderr ?? ''}`
        : String(error)
    return /resume rejected|resume-drops-turn|does not start with/i.test(text) ? 'anchor-rejected' : 'fork-failed'
  }

  /** 降级必须可见：落任务事件 + 累到阶段 span meta（禁止静默换引擎）。 */
  private recordSessionFallback(task: Task, from: SessionLaunch, to: SessionLaunch, error: unknown): void {
    const detail = [
      `${describeLaunch(from)} → ${describeLaunch(to)}`,
      `原因:${to.fallback ?? 'unknown'}`,
      error instanceof Error ? error.message : String(error)
    ].join('\n')
    this.deps.addTaskEvent({
      taskId: task.id,
      kind: 'status',
      title: `阶段会话降级(${from.mode}→${to.mode})`,
      detail
    })
  }

  /** qodercli 进程非 0 退出时(常见 exit 42), SDK 丢出的错误带 .stderr = CLI 日志尾部。
   * 上层 main.ts 只用 error.message,会把 stderr 丢掉 —— 这里拼进去让面板报错能看到真正原因。 */
  private enrichProcessError(error: unknown): unknown {
    if (error instanceof QoderCliProcessError && error.stderr) {
      const tail = error.stderr.trim().slice(-2000)
      const enriched = new Error(`${error.message}\n\nqodercli stderr (tail):\n${tail}`)
      ;(enriched as Error & { cause?: unknown }).cause = error
      return enriched
    }
    return error
  }

  private async runTurn(options: {
    task: Task
    repos: TaskRepository[]
    phase: TaskAgentPhase
    /** 本阶段实例 id（= `launch.stageInstanceId`，显式传是为了返回值里不依赖降级后的可变入参）。 */
    stageInstanceId: string
    /** 会话启动方式（planLaunch 的结论）；降级阶梯会就地推进它。 */
    launch: SessionLaunch
    /** 按最终启动方式拼 prompt —— 降级到全量重放时必须重拼（要带任务上下文）。
     * `report.injected` 让 prompt 构造器回报「实际注入了哪几块」，供阶段输入快照。 */
    promptFor: (launch: SessionLaunch, report: { injected: string[] }) => Promise<string>
    signal?: AbortSignal
    recordText: boolean
    hardTimeoutMs?: number
    /** 恢复/续接标记：'resume'（失败后继续/暂停恢复）| 'followup'（续接对话追加指令）。 */
    trigger?: 'resume' | 'followup'
    /** auto-fix 重跑轮次（reviewFixCount）：渲染层区分 Exec / ReExec #n。 */
    round?: number
  }): Promise<TaskAgentResult> {
    const { task, repos, phase, stageInstanceId, promptFor, signal, recordText, hardTimeoutMs, trigger, round } =
      options
    let launch = options.launch
    const stagePhase = stagePhaseOf(phase)
    const buffers = this.ensureBuffers(task.id, phase)

    // abort 预检必须在 emit agent_start 之前:signal 已中止时直接失败,
    // 避免发出 agent_start 后 agent_end 永远不来导致事件不配对。
    signal?.throwIfAborted()

    this.turnCtxByTaskId.set(task.id, { recordText, phase })
    this.emit({ type: 'agent_start', taskId: task.id, phase })
    // 任务 trace：惰性开启（一次任务 = 一个 Trace）+ 阶段 agent.run span。
    // 阶段实例按时间追加：首跑与恢复/续接/auto-fix 重跑各自产生一个阶段 span（同 phase 多实例），
    // meta.attempt 标记同 phase 第几次执行，trigger/round 供展示层显示「执行（续接）」「ReExec #n」。
    // meta 额外带会话归属（stageInstanceId / sessionMode / 父会话 / anchor），
    // 不然「这一阶段到底继承了什么上下文」在 Trace 上完全看不出来。
    if (this.deps.tracePipeline) {
      this.ensureTaskTrace(task)
      const attemptKey = `${task.id}:${phase}`
      const attempt = (this.phaseAttempts.get(attemptKey) ?? 0) + 1
      this.phaseAttempts.set(attemptKey, attempt)
      const agentSpan = this.deps.tracePipeline.startSpan(task.id, {
        type: 'agent.run',
        name: `Agent ${phase}`,
        meta: {
          source: 'qoder',
          phase,
          attempt,
          stageInstanceId,
          sessionMode: launch.mode,
          ...(trigger ? { trigger } : {}),
          ...(round !== undefined ? { round } : {}),
          ...(launch.resume ? { parentSessionId: launch.resume } : {}),
          ...(launch.anchorEntryUuid ? { anchorEntryUuid: launch.anchorEntryUuid } : {}),
          ...(launch.fallback ? { sessionFallback: launch.fallback } : {})
        }
      })
      this.traceAgentSpans.set(task.id, agentSpan)
    }

    // 回合级中止信号:父级(任务取消/暂停)abort + 硬超时(plan 超时强制中止)。
    // 超时预算覆盖整条降级阶梯（一次阶段执行的总上限），不为每一档重新计时。
    const internalAbort = new AbortController()
    const onParentAbort = () => internalAbort.abort(signal?.reason)
    signal?.addEventListener('abort', onParentAbort, { once: true })
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const hardTimeout = hardTimeoutMs
      ? new Promise<never>((_, reject) => {
          hardTimer = setTimeout(() => {
            timedOut = true
            internalAbort.abort()
            reject(new Error(`计划生成超时(>${hardTimeoutMs / 1000}s)，已强制中止当前 query`))
          }, hardTimeoutMs)
        })
      : undefined
    let session: QoderSession | undefined
    /** 最后一次尝试的 prompt 构成（阶段输入快照的正文，降级重试后以最后一档为准）。 */
    let lastAttempt: { launch: SessionLaunch; promptChars: number; injected: string[] } | undefined
    /** 回合产物：在 finally 里落定（会话 id、降级后的启动方式都要到那里才知道），正常路径原样返回。 */
    let stageResult: TaskAgentResult | undefined

    try {
      // 降级阶梯：fork(anchor) → fork(全量继承) → 全量重放；resume → 全量重放。
      for (;;) {
        // 阶段产物按回合重置：collectResult 只应拿到本回合文本。缓冲此前只增不清，
        // 第二次 plan（feedback 修订）会解析「旧+新」拼接文本，兜底正则先匹配到旧计划的
        // "plan" 字段，导致新版计划内容与旧版完全相同。降级重试同样要清，否则半截输出会污染解析。
        buffers.responseTexts.length = 0
        const report = { injected: [] as string[] }
        const prompt = await promptFor(launch, report)
        lastAttempt = { launch, promptChars: prompt.length, injected: [...report.injected] }
        const progress = { emitted: false }
        session = this.ensureSession(task, repos, launch, stagePhase)
        try {
          await this.consumeTurn({
            task,
            phase,
            prompt,
            buffers,
            session,
            internalAbort,
            hardTimeout,
            progress,
            isTimedOut: () => timedOut
          })
          break
        } catch (error) {
          const reason = this.fallbackReasonFor(launch, error)
          // 只有「启动期失败且零输出」才能安全重放：CLI 在 resume/fork 参数被拒时直接 exit 42，
          // 此时模型没产出、也没副作用；一旦已有输出必须原样上抛，避免同一个 Edit 执行两遍。
          const retryable =
            !progress.emitted && !timedOut && !internalAbort.signal.aborted && isResumableStartupFailure(error)
          const next = retryable ? nextLaunch(launch, reason) : undefined
          if (!next) throw this.enrichProcessError(error)
          this.recordSessionFallback(task, launch, next, error)
          await this.sessions.close(launch.stageInstanceId)
          launch = next
        }
      }
    } finally {
      signal?.removeEventListener('abort', onParentAbort)
      if (hardTimer) clearTimeout(hardTimer)
      // 阶段输入快照（§4.2）：无论成败都落盘 —— 出错时「这一档到底读了什么」最需要复盘。
      const snapshotPath = await this.writeStageSnapshot(task, phase, lastAttempt).catch(() => undefined)
      // 用量取一次、两处用：进 span meta（可观测）+ 进预算表（下一次 fork 决策的输入）。
      // 放在 trace 块外：tracePipeline 未启用时预算判定仍需运转。
      const turnUsage = session?.getTurnUsage()
      if (turnUsage?.contextUsageRatio !== undefined)
        this.contextRatio.set(launch.stageInstanceId, turnUsage.contextUsageRatio)
      // 阶段 agent.run span 收尾。运行时事实与用量口径只能事后拿（init 在首个回合内到达、
      // result 在回合尾），因此到收尾时一并写进 span meta（endSpan 的 meta 是覆盖语义，需合并）。
      if (this.deps.tracePipeline) {
        const agentSpan = this.traceAgentSpans.get(task.id)
        if (agentSpan) {
          this.traceAgentSpans.delete(task.id)
          const runtime = session?.getRuntimeInfo()
          const handoff = this.planHandoff.get(`${task.id}:${task.planRevision ?? 0}`)
          this.deps.tracePipeline.endSpan(task.id, agentSpan, {
            ...(snapshotPath ? { output: snapshotPath } : {}),
            meta: {
              ...agentSpan.meta,
              // 降级后的最终启动方式覆盖开 span 时写入的那一份。
              sessionMode: launch.mode,
              ...(launch.fallback ? { sessionFallback: launch.fallback } : {}),
              ...(launch.downgradeStep ? { downgradeStep: launch.downgradeStep } : {}),
              ...(handoff?.meta?.planPath ? { planPath: handoff.meta.planPath } : {}),
              ...(handoff?.meta?.sha256 ? { planSha256: handoff.meta.sha256 } : {}),
              ...(handoff ? { planSectionsComplete: handoff.sections.complete } : {}),
              ...(runtime?.transport ? { transport: runtime.transport } : {}),
              ...(runtime?.cliVersion ? { cliVersion: runtime.cliVersion } : {}),
              ...(runtime?.protocolVersion ? { protocolVersion: runtime.protocolVersion } : {}),
              ...(runtime?.capabilities ? { capabilities: runtime.capabilities } : {}),
              ...(runtime?.tools ? { tools: runtime.tools } : {}),
              // 环境注入可观测（§5）：任务会话跑在用户 ~/.qoder 上，到底被带进了几条技能
              // 必须先看得到数据，再决定要不要动 settingSources / skills 旋钮。
              ...(runtime?.skills ? { skills: runtime.skills } : {}),
              ...(runtime?.permissionMode ? { permissionMode: runtime.permissionMode } : {}),
              ...(turnUsage?.contextUsageRatio !== undefined ? { contextUsageRatio: turnUsage.contextUsageRatio } : {}),
              ...(turnUsage?.credits !== undefined ? { credits: turnUsage.credits } : {}),
              ...(turnUsage?.totalCredits !== undefined ? { totalCredits: turnUsage.totalCredits } : {})
            }
          })
        }
      }
      // HITL 兜底：回合结束（abort / 暂停 / HITL 超时）后，扫描事件表，
      // 为只有 tool_use 无 tool_result 的调用补发 error 结果。
      // 避免前端配对时因无 result + 非 streaming → 状态 'done' → 误显示「已编辑」。
      // 同时检查 deniedCallIds：被 HITL 拒绝的调用即使已有 result 但未标记 isError，
      // 也补发 error 事件覆盖（onMessage mutation 竞态未命中的兜底）。
      try {
        const events = this.deps.store.listEvents(task.id)
        const toolUseIds = new Set<string>()
        const toolResultIds = new Set<string>()
        const errorResultIds = new Set<string>()
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
            if (payload?.isError === true) errorResultIds.add(toolUseId)
          }
        }
        // 1. 无 result 的 tool_use → 补发 error
        for (const toolUseId of toolUseIds) {
          if (toolResultIds.has(toolUseId)) continue
          this.deps.addTaskEvent({
            taskId: task.id,
            kind: 'tool',
            title: toolNames.get(toolUseId) ?? 'tool',
            payload: {
              toolUseId,
              toolName: toolNames.get(toolUseId) ?? 'tool',
              phase: 'result',
              output: '工具调用未执行（回合中断）',
              isError: true
            }
          })
        }
        // 2. HITL 拒绝但 result 未标记 isError → 补发 error 覆盖
        const deniedIds = this.deniedCallIdsByTask.get(task.id)
        if (deniedIds) {
          for (const id of deniedIds) {
            if (errorResultIds.has(id)) continue
            this.deps.addTaskEvent({
              taskId: task.id,
              kind: 'tool',
              title: toolNames.get(id) ?? 'tool',
              payload: {
                toolUseId: id,
                toolName: toolNames.get(id) ?? 'tool',
                phase: 'result',
                output: '工具调用被拒绝（HITL 拒绝）',
                isError: true
              }
            })
          }
        }
      } catch {
        /* 事件扫描失败不影响主流程 */
      }
      this.turnCtxByTaskId.delete(task.id)
      // 阶段结束统一收尾(成功与失败路径一致,保持旧行为):先落 sessionId 再收 agent_session / agent_end。
      if (session) buffers.sessionId = session.getSessionId()
      if (buffers.sessionId) {
        // 会话 id 回到阶段实例上：同阶段下一回合续接它，下一阶段从它 fork。
        const stage = this.currentStage.get(task.id)
        if (stage && stage.id === launch.stageInstanceId) {
          stage.qoderSessionId = buffers.sessionId
          if (launch.anchorEntryUuid) stage.anchorEntryUuid = launch.anchorEntryUuid
        }
        // 带 taskId 持久化,避免依赖 main.ts 的全局 activeTaskId(任务串扰风险)。
        this.emit({ type: 'agent_session', taskId: task.id, sessionId: buffers.sessionId })
      }
      this.emit({ type: 'agent_end', taskId: task.id, phase })
      // 本阶段产物在 finally 里算好、在 try 外返回：在 finally 里 `return` 会吞掉抛出的错误。
      stageResult = {
        responseTexts: [...buffers.responseTexts],
        ...(buffers.sessionId ? { sessionId: buffers.sessionId } : {}),
        stageInstanceId,
        sessionMode: launch.mode
      }
    }
    return stageResult
  }

  /**
   * 消费一个回合:把会话输出转成事件 / 缓冲。
   *
   * `progress.emitted` 一旦置上就不再允许降级重试（已经产生输出 = 可能已有副作用）。
   */
  private async consumeTurn(args: {
    task: Task
    phase: TaskAgentPhase
    prompt: string
    buffers: PhaseBuffers
    session: QoderSession
    internalAbort: AbortController
    hardTimeout?: Promise<never>
    progress: { emitted: boolean }
    isTimedOut: () => boolean
  }): Promise<void> {
    const { task, phase, prompt, buffers, session, internalAbort, hardTimeout, progress, isTimedOut } = args
    const loop = (async () => {
      // 文本按"段落"聚合后再 emit agent_text:流式 text_delta 每增量一条事件会让
      // 执行 tab / Trace 显示大量碎片消息。段落边界 = 非文本 part(工具调用/思考等)或回合结束,
      // 与旧实现"每条 assistant 消息一段"的展示粒度对齐。responseTexts 仍按碎片累积(解析侧已兼容拼接)。
      let textBuffer: string[] = []
      const flushText = () => {
        if (textBuffer.length === 0) return
        this.emit({ type: 'agent_text', taskId: task.id, phase, text: textBuffer.join('') })
        textBuffer = []
      }
      // 本阶段发送给模型的完整 prompt：作该阶段首个 llm span 的 input
      // （SDK 不回显 user 文本消息，任务各阶段的 Prompt 此前在 span 详情里看不到）。
      this.traceBuilders.get(task.id)?.setTurnInput(prompt)
      for await (const chunk of session.turn({ text: prompt, signal: internalAbort.signal })) {
        progress.emitted = true
        if (chunk.type === 'part') {
          const text = partTextOf(chunk.part)
          if (text) {
            buffers.responseTexts.push(text)
            textBuffer.push(text)
            // markdown 段落边界(空行):长回复按段落分段出现,执行 tab 不至于整段最后一次性弹出。
            if (/\n\s*\n/.test(textBuffer.join(''))) flushText()
            continue
          }
        }
        // 非文本 part(thinking / tool-use / tool-result / task-created …):先落一段文本再继续。
        flushText()
      }
      flushText()
    })()
    // race 中 hardTimeout 先 reject 后,loop 若随后抛错(SDK 消费循环失败)会产生 unhandledRejection:
    // 仅在超时已触发时吞掉 loop 的 rejection;正常路径的错误必须继续上抛。
    const guarded = loop.catch((error) => {
      if (isTimedOut()) return
      throw error
    })
    if (hardTimeout) await Promise.race([guarded, hardTimeout])
    else await guarded
  }
}
