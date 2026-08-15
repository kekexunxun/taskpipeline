/**
 * Qoder Task Agent Driver — TaskAgentDriver 的 Qoder SDK 实现(常驻会话引擎版)。
 *
 * 职责(全部封在本文件内):
 *  - runPlan / runImplementation / runTestGeneration: 每个 taskId 常驻一个
 *    `QoderSession`(见 ../qoder/qoder-session.ts),三阶段在同一会话内按"回合"推进 ——
 *    阶段 = 一条用户消息(指令),上下文由 Qoder 会话端管理,不再每阶段全量拼 prompt;
 *  - 会话控制作为底层能力:plan 是任务起点(重置该 taskId 会话);implementation / test
 *    复用 plan 会话;任务恢复(resume)时用保存的 sessionId 恢复会话;`interruptSession`
 *    暂停时停止当前回复、保留会话;`closeSession` 任务终态时释放;
 *  - 事件上报:emit `TaskAgentEvent`(agent_start / agent_text / agent_end);每条 SDK 消息
 *    经 onMessage 钩子写日志 / 更新用量 / 写任务事件 / emitPi(子任务分组逻辑在 log.ts);
 *  - Phase 2 HITL:PermissionRequest hook 由上层(main.ts)弹 UI 确认;
 *  - collectResult(phase) 让调用方拿到累积的 `responseTexts / sessionId`。
 *
 * 不负责:任务工作流(状态机 / 计划 / 实现后续的校验、Review、MR) — 这些仍在 main.ts 里。
 */

import { QoderCliProcessError, type Query, type SDKMessage } from '@qoder-ai/qoder-agent-sdk'
import type { HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput } from '@qoder-ai/qoder-agent-sdk'
import type { Task, TaskRepository, TaskStore, AgentSpan } from '@task-pipeline/core'
import { implementationOutcomeInstruction } from '../task-readiness.js'
import { QoderSession, QoderSessionRegistry } from '../qoder/qoder-session.js'
import type { DriverPart } from '../chat/chat-types.js'
import type { TracePipeline } from '../trace/bus/trace-pipeline.js'
import { QoderTraceBuilder } from '../trace/instrument/qoder-trace-builder.js'
import type {
  TaskAgentDriver,
  TaskAgentDeps,
  TaskAgentEvent,
  TaskAgentResult,
  TaskAgentPhase,
  RunPlanInput,
  RunImplementationInput,
  RunTestGenerationInput
} from './task-agent-driver.js'
import { logQoderMessage, qoderLogFile, recordQoderMessage } from './log.js'

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
   * `signal` 为 SDK 传入的会话中止信号：任务被 abort 时确认框应立刻按拒绝处理。
   * 未注入时所有 PermissionRequest hook 直接放行（保持原行为）。
   */
  onPermissionRequest?: (
    taskId: string,
    toolName: string,
    toolInput: unknown,
    signal?: AbortSignal
  ) => Promise<'allow' | 'deny'>
  /**
   * 测试用例生成阶段的 Agent 上下文（角色定义 + 领域指引）。
   * 存在时优先使用，回退现有 resolveAgentContext。
   */
  resolveTestContext?: (task: Task, repos: TaskRepository[]) => Promise<{ sections: string[] }>
  /** 埋点管线：任务路径 span 采集（可选）。一次任务执行 = 一个 Trace（traceId = task.id）。 */
  tracePipeline?: TracePipeline
}

const TEST_CASE_GENERATION_PROMPT = [
  '你是一个测试用例生成 Agent，专为当前 Coding 任务生成最小测试集。',
  '硬性约束：',
  '1. 不得修改任何业务逻辑文件、不得重构、不得调整非测试相关的配置。',
  '2. 仅为本次改动产出可被现有 testCommand 跑通的最小测试集（单元测试为主，必要时一个集成测试）。',
  '3. 若现有 testCommand 不存在或无法识别测试文件，请按仓库常见约定新增。',
  '4. 所有新增文件必须以 _test.* / .test.* / .spec.* 结尾，并放到合理的测试目录。',
  '5. 完成后请把测试相关的修改 commit 到当前 feature 分支（一个 commit 即可），commit message 形如 `test: <简短说明>`。',
  '',
  '请在最后输出一个 JSON 对象（不要输出额外说明）：',
  '{"files":["path/to/test1", "path/to/test2"], "commitSha":"<短 sha 或全 sha>", "summary":"<一句话概述>"}',
  '若没有任何可测试的逻辑面，输出 {"files":[], "summary":"<解释原因>"}。'
].join('\n')

const PLAN_TIMEOUT_MS = 5 * 60_000

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
  taskId: string
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PermissionRequest: [
      {
        hooks: [
          async (
            input: Parameters<HookCallback>[0],
            _toolUseID?: string,
            options?: { signal: AbortSignal }
          ): Promise<HookJSONOutput> => {
            if (input.hook_event_name !== 'PermissionRequest') {
              return {
                hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
              }
            }
            const decision = await onPermissionRequest(taskId, input.tool_name, input.tool_input, options?.signal)
            return decision === 'deny'
              ? {
                  hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'deny', message: '用户拒绝了此操作，请改用其他方案', interrupt: false }
                  }
                }
              : { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
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
   * 任务上下文解析（记忆提取注入每任务只做一次）：
   * - 首次：keyword 阶段容器内全量解析 —— LLM 关键词提取 + 记忆/Repowiki 检索注入 + Agent 指引；
   * - 之后：仅组装 Agent 指引，跳过记忆检索（省掉重复的关键词提取 LLM 调用——Plan/Exec 重跑、
   *   feedback 再触发时不再重复提取注入）；任务终态 finishTrace 清标记，任务重跑会重新提取。
   */
  private async resolveTaskContext(
    task: Task,
    repos: TaskRepository[]
  ): Promise<{ memoryContext: string | undefined; agentContext: { sections: string[] } | undefined }> {
    if (this.keywordInjected.has(task.id)) {
      const agentContext = await this.deps.resolveAgentContext?.(task, repos)
      return { memoryContext: undefined, agentContext }
    }
    this.keywordInjected.add(task.id)
    return this.withKeywordStage(task.id, async () => {
      const memoryContext = await this.deps.resolveMemoryContext?.(task, repos)
      const agentContext = await this.deps.resolveAgentContext?.(task, repos)
      return { memoryContext, agentContext }
    })
  }

  async runPlan(input: RunPlanInput): Promise<void> {
    const { task, repos, signal, feedback, trigger } = input
    // 任务 trace 提前 begin：在记忆/Agent 上下文检索之前就绪（幂等），
    // 让 Trace 页在首个 SDK 消息到达前就能看到任务执行记录。
    this.ensureTaskTrace(task)
    // 会话策略(无论是否 feedback 都统一):
    //  - 该任务已有有效会话 → 追加消息(保留此前全部对话上下文,绝不 init 重来);
    //  - 无会话但 task.qoderSessionId 存在(应用重启 / 会话被释放后) → resume 恢复后追加;
    //  - 两者都没有(首次 plan) → 新建会话。
    // 无条件 init 会导致此前分析/计划数据全部丢失。
    const hasSession = Boolean(this.sessions.get(task.id))

    // 任务上下文解析：记忆（关键词提取 + 检索注入）只做一次，Agent 指引每次组装。
    // keyword 阶段容器：首次解析（含关键词提取 llm 调用）归入独立阶段卡，与 Plan/Exec 顶层平铺。
    const { memoryContext, agentContext } = await this.resolveTaskContext(task, repos)
    const prompt = hasSession
      ? [
          feedback
            ? `根据以下调整意见，重新生成实施计划（沿用此前已分析的任务上下文）：\n${feedback}`
            : '请基于当前会话上下文重新审视，并输出一份更完善的实施计划。',
          '禁止修改文件，禁止执行安装、构建或其他会改变工作区的命令。',
          '最终只输出一个 JSON 对象，不要输出过程说明或 Markdown 代码块。若代码已满足要求，输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；否则输出 {"outcome":"changes_required","plan":"完整实施计划，包含涉及文件、实施步骤、验证方式和风险"}。'
        ].join('\n\n')
      : [
          ...(agentContext?.sections ?? []),
          memoryContext ?? '',
          '请只读分析以下 Coding 任务。可委派内置 Plan 子代理(Agent 工具)协助制定计划,也可直接分析输出。',
          `任务:${task.title}`,
          task.description,
          `验收标准:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
          feedback ? `上一次计划的调整意见:\n${feedback}` : '',
          '禁止修改文件，禁止执行安装、构建或其他会改变工作区的命令。',
          '最终只输出一个 JSON 对象，不要输出过程说明或 Markdown 代码块。若代码已满足要求，输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；否则输出 {"outcome":"changes_required","plan":"完整实施计划，包含涉及文件、实施步骤、验证方式和风险"}。'
        ]
          .filter(Boolean)
          .join('\n\n')

    await this.runTurn({
      task,
      repos,
      phase: 'planning',
      prompt,
      signal,
      recordText: false,
      hardTimeoutMs: PLAN_TIMEOUT_MS,
      ...(trigger ? { trigger } : {}),
      // 无活跃会话时尝试 resume(恢复历史会话后同样追加消息,不丢失上下文)。
      resume: hasSession ? undefined : task.qoderSessionId
    })
  }

  async runImplementation(input: RunImplementationInput): Promise<void> {
    const { task, repos, signal, resumeSessionId, extraPrompt, trigger, round } = input
    // 任务 trace 提前 begin（幂等）：实现阶段与计划阶段共享同一 Trace。
    this.ensureTaskTrace(task)

    const hasSession = Boolean(this.sessions.get(task.id))
    let prompt: string
    if (resumeSessionId) {
      // 恢复:会话上下文已包含原 Agent 指引,不重新拼。
      prompt = extraPrompt ?? '任务此前执行失败/中断，请基于当前会话上下文继续完成剩余工作。'
    } else if (hasSession) {
      // 三阶段共享会话:plan 已把任务上下文送入会话,这里只发阶段指令。
      prompt = [
        '现在开始执行 Implementation 阶段。',
        '1. 严格按照上轮 Plan 制定的方案执行。',
        '2. 按依赖顺序逐个修改文件，每完成一个文件简要说明修改内容。',
        '3. 如遇到方案中未覆盖的问题，主动询问后再继续。',
        implementationOutcomeInstruction
      ].join('\n')
    } else {
      // 无会话(直接进入实现阶段,未经过 plan):全量上下文兜底。
      const { agentContext, memoryContext } = await this.resolveTaskContext(task, repos)
      prompt = [
        ...(agentContext?.sections ?? []),
        memoryContext ?? '',
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

    await this.runTurn({
      task,
      repos,
      phase: 'implementation',
      prompt,
      signal,
      resume: resumeSessionId,
      recordText: true,
      ...(trigger ? { trigger } : {}),
      ...(round !== undefined ? { round } : {})
    })
  }

  async runTestGeneration(input: RunTestGenerationInput): Promise<void> {
    const { task, repos, signal } = input
    // 任务 trace 提前 begin（幂等）：测试阶段与实现阶段共享同一 Trace。
    this.ensureTaskTrace(task)

    const hasSession = Boolean(this.sessions.get(task.id))
    let prompt: string
    if (hasSession) {
      // 三阶段共享会话:实现上下文已在会话里,只发测试阶段指令。
      prompt = ['现在进入 Test 阶段。为 Implementation 阶段修改的代码生成测试。', TEST_CASE_GENERATION_PROMPT].join(
        '\n\n'
      )
    } else {
      // 无会话兜底:全量上下文。
      const agentContext = this.deps.resolveTestContext
        ? await this.deps.resolveTestContext(task, repos)
        : await this.deps.resolveAgentContext?.(task, repos)
      prompt = [
        ...(agentContext?.sections ?? []),
        task.title,
        task.description,
        task.planContent ? `Approved implementation plan:\n${task.planContent}` : '',
        TEST_CASE_GENERATION_PROMPT
      ]
        .filter(Boolean)
        .join('\n\n')
    }

    await this.runTurn({ task, repos, phase: 'test_generation', prompt, signal, recordText: true })
  }

  collectResult(taskId: string, phase: 'plan' | 'implementation' | 'test'): TaskAgentResult {
    const phaseKey: TaskAgentPhase =
      phase === 'plan' ? 'planning' : phase === 'test' ? 'test_generation' : 'implementation'
    const buffers = this.buffers.get(`${taskId}:${phaseKey}`)
    return {
      responseTexts: buffers?.responseTexts ? [...buffers.responseTexts] : [],
      ...(buffers?.sessionId ? { sessionId: buffers.sessionId } : {})
    }
  }

  /** 关闭指定任务的常驻会话(任务完成 / 失败 / 取消时由 main.ts 调用),并清理其阶段产物。 */
  closeSession(taskId: string): void {
    void this.sessions.close(taskId)
    // 释放该任务累积的阶段产物,避免 Map 无限增长。
    for (const key of this.buffers.keys()) {
      if (key.startsWith(`${taskId}:`)) this.buffers.delete(key)
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
    this.traceAgentSpans.delete(taskId)
    for (const key of this.phaseAttempts.keys()) {
      if (key.startsWith(`${taskId}:`)) this.phaseAttempts.delete(key)
    }
  }

  /** 停止指定任务当前回复、保留会话(暂停任务时由 main.ts 调用)。 */
  interruptSession(taskId: string): void {
    const session = this.sessions.get(taskId)
    if (session) void session.interrupt()
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

  private ensureSession(task: Task, repos: TaskRepository[], resume?: string): QoderSession {
    const existing = this.sessions.get(task.id)
    if (existing) return existing
    if (repos.length === 0) throw new Error('任务未关联代码仓库')
    const primary = repos[0]!
    const token = this.deps.qoderTokenProvider()
    if (!token) throw new Error('请先配置 Qoder Token')
    const logFile = qoderLogFile(this.deps.dataDir, task.id)
    const permissionHooks = this.deps.onPermissionRequest
      ? buildPermissionHooks(this.deps.onPermissionRequest, task.id)
      : undefined
    const session = new QoderSession(task.id, {
      token,
      cwd: primary.worktreePath ?? primary.localPath,
      additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath),
      ...(this.deps.resolveModel ? { model: stripQoderModelPrefix(this.deps.resolveModel(task)) } : {}),
      ...(resume ? { resume } : {}),
      permissionMode: 'acceptEdits',
      // 预授权 Agent 工具:让模型可委派内置子代理(Plan 等);不限制其它默认工具。
      allowedTools: ['Agent'],
      ...(permissionHooks ? { hooks: permissionHooks } : {}),
      onMessage: (message) => {
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
    this.sessions.register(task.id, session)
    return session
  }

  private async runTurn(options: {
    task: Task
    repos: TaskRepository[]
    phase: TaskAgentPhase
    prompt: string
    signal?: AbortSignal
    resume?: string
    recordText: boolean
    hardTimeoutMs?: number
    /** 恢复/续接标记：'resume'（失败后继续/暂停恢复）| 'followup'（续接对话追加指令）。 */
    trigger?: 'resume' | 'followup'
    /** auto-fix 重跑轮次（reviewFixCount）：渲染层区分 Exec / ReExec #n。 */
    round?: number
  }): Promise<void> {
    const { task, repos, phase, prompt, signal, resume, recordText, hardTimeoutMs, trigger, round } = options
    const buffers = this.ensureBuffers(task.id, phase)
    const session = this.ensureSession(task, repos, resume)

    // abort 预检必须在 emit agent_start 之前:signal 已中止时直接失败,
    // 避免发出 agent_start 后 agent_end 永远不来导致事件不配对。
    signal?.throwIfAborted()

    this.turnCtxByTaskId.set(task.id, { recordText, phase })
    this.emit({ type: 'agent_start', phase })
    // 任务 trace：惰性开启（一次任务 = 一个 Trace）+ 阶段 agent.run span。
    // 阶段实例按时间追加：首跑与恢复/续接/auto-fix 重跑各自产生一个阶段 span（同 phase 多实例），
    // meta.attempt 标记同 phase 第几次执行，trigger/round 供展示层显示「执行（续接）」「ReExec #n」。
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
          ...(trigger ? { trigger } : {}),
          ...(round !== undefined ? { round } : {})
        }
      })
      this.traceAgentSpans.set(task.id, agentSpan)
    }

    // 回合级中止信号:父级(任务取消/暂停)abort + 硬超时(plan 超时强制中止)。
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

    try {
      const loop = (async () => {
        // 文本按"段落"聚合后再 emit agent_text:流式 text_delta 每增量一条事件会让
        // 执行 tab / Trace 显示大量碎片消息。段落边界 = 非文本 part(工具调用/思考等)或回合结束,
        // 与旧实现"每条 assistant 消息一段"的展示粒度对齐。responseTexts 仍按碎片累积(解析侧已兼容拼接)。
        let textBuffer: string[] = []
        const flushText = () => {
          if (textBuffer.length === 0) return
          this.emit({ type: 'agent_text', phase, text: textBuffer.join('') })
          textBuffer = []
        }
        // 本阶段发送给模型的完整 prompt：作该阶段首个 llm span 的 input
        // （SDK 不回显 user 文本消息，任务各阶段的 Prompt 此前在 span 详情里看不到）。
        this.traceBuilders.get(task.id)?.setTurnInput(prompt)
        for await (const chunk of session.turn({ text: prompt, signal: internalAbort.signal })) {
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
        if (timedOut) return
        throw error
      })
      if (hardTimeout) await Promise.race([guarded, hardTimeout])
      else await guarded
    } catch (error) {
      // qodercli 进程非 0 退出时(常见 exit 42), SDK 会丢出一个
      // QoderCliProcessError,其 .stderr 字段是 qodercli 输出的尾部日志。
      // 上层 main.ts 只用 error.message,会把 stderr 丢掉,看不到真正原因。
      // 这里把 stderr 拼到 message 后面,面板报错里能直接看到。
      if (error instanceof QoderCliProcessError && error.stderr) {
        const tail = error.stderr.trim().slice(-2000)
        const enriched = new Error(`${error.message}\n\nqodercli stderr (tail):\n${tail}`)
        ;(enriched as Error & { cause?: unknown }).cause = error
        throw enriched
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', onParentAbort)
      if (hardTimer) clearTimeout(hardTimer)
      // 阶段 agent.run span 收尾。
      if (this.deps.tracePipeline) {
        const agentSpan = this.traceAgentSpans.get(task.id)
        if (agentSpan) {
          this.traceAgentSpans.delete(task.id)
          this.deps.tracePipeline.endSpan(task.id, agentSpan)
        }
      }
      this.turnCtxByTaskId.delete(task.id)
      // 阶段结束统一收尾(成功与失败路径一致,保持旧行为):先落 sessionId 再收 agent_session / agent_end。
      buffers.sessionId = session.getSessionId()
      if (buffers.sessionId) {
        // 带 taskId 持久化,避免依赖 main.ts 的全局 activeTaskId(任务串扰风险)。
        this.emit({ type: 'agent_session', taskId: task.id, sessionId: buffers.sessionId })
      }
      this.emit({ type: 'agent_end', phase })
    }
  }
}
