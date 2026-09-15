/**
 * Pi task agent driver（P3：与 Qoder 运行时同一契约）。
 *
 * 为什么单独一层：Pi 侧此前没有 driver，阶段执行直接写在 `task-lifecycle.ts` 里
 * （`startPi(taskId)` + `getPiSession().prompt(...)`），于是
 *  1. 「阶段边界 = 会话边界」在 Pi 上不存在 —— Plan 到 Exec 一直复用同一会话；
 *  2. 完成判定靠 `emitPi` 里碰 `agent_end`（事件层反向驱动状态机，两个任务并行会串）；
 *  3. 同一套阶段语义要写两遍（Qoder 分支 / Pi 分支），§6 的「一致化」无从谈起。
 *
 * 分层：
 *  - 机制（开会话 / fork 会话文件 / 事件路由 / UI 桥）→ `pi-session.ts`
 *  - 本文件（阶段实例标识、是否拆边界、送 prompt、等回合结束、按阶段取产物）
 *  - 状态机与产物落盘 → `task-lifecycle.ts`
 *
 * 与 Qoder driver 的能力差异只有一处：Pi 没有「按会话设权限」的原语，
 * `perPhasePermission: false`（见 `capabilities()`），阶段级只读靠 prompt + L1 判定。
 */

import type { TaskStore } from '@task-pipeline/core'
import type { TaskAgentCapabilities, TaskAgentPhase, TaskAgentResult } from '../agents/task-agent/task-agent-driver.js'
import { checkPlanSections } from './stage-artifacts.js'
import type { StagePhase } from './stage-instance.js'
import { stageInstanceId, stagePhaseOf } from './stage-instance.js'
import {
  beginPiCapture,
  endPiCapture,
  ensurePiSession,
  forkPiStage,
  getPiSessionInfo,
  releasePiSession,
  takePiAgentEndTexts
} from './pi-session.js'

// ── 阶段边界判定（纯函数，可单测） ───────────────────────────────────────────

/**
 * 本阶段是否拆新会话（fork），以及为什么。
 *
 * 与 Qoder 侧 `planLaunch` 同构，只是 Pi 的「fork」是文件层复制（`SessionManager.forkFrom`），
 * 不需要 anchor uuid 也能继承前缀（V13 实测），所以判定里少一档「anchor 不可用」。
 */
export type PiForkReason =
  /** 本任务还没有任何阶段实例（首次执行 / 应用重启后）。 */
  | 'first-stage'
  /** 同一阶段实例内续接（重跑计划、auto-fix 多轮、暂停恢复、追加消息）。 */
  | 'same-stage-reuse'
  /** 阶段边界：从上一阶段会话 fork。 */
  | 'stage-boundary'
  /** 计划正文缺 §4.3 三段 → 本阶段不拆实例（存量任务不重探仓库）。 */
  | 'plan-schema-incomplete'
  /** 上一阶段没有可 fork 的会话文件 → 直接新开会话。 */
  | 'no-parent-session'

export function decidePiFork(input: {
  phase: TaskAgentPhase
  /** 当前活着的阶段实例归属阶段（无实例时 undefined）。 */
  currentPhase?: StagePhase
  trigger?: 'resume' | 'followup'
  /** 任务上是否还有可继承的会话（活会话或 `piSessionPath`）。 */
  hasParentSession: boolean
  /** 计划正文是否含必需三段。 */
  planComplete: boolean
}): { fork: boolean; reason: PiForkReason } {
  const stagePhase = stagePhaseOf(input.phase)
  if (input.trigger) return { fork: false, reason: 'same-stage-reuse' }
  if (input.currentPhase === stagePhase) return { fork: false, reason: 'same-stage-reuse' }
  if (stagePhase === 'planning') {
    // 计划是链路上第一个阶段：永远在原会话里重跑，不从任何东西 fork。
    return { fork: false, reason: 'first-stage' }
  }
  if (stagePhase === 'implementation' && !input.planComplete) {
    return { fork: false, reason: 'plan-schema-incomplete' }
  }
  if (!input.hasParentSession) return { fork: false, reason: 'no-parent-session' }
  return { fork: true, reason: 'stage-boundary' }
}

// ── driver ──────────────────────────────────────────────────────────────────

export interface PiTaskAgentDeps {
  store: TaskStore
  /** 阶段级降级 / 不拆边界的原因写进任务事件（静默降级是本方案要治的第一条）。 */
  logStage: (taskId: string, title: string, detail: string) => void
}

/** 一次 Pi 阶段执行：`body` 是编排层拼好的阶段正文（Agent 指引 + 任务信息 + 阶段指令）。 */
export type PiStageInput = {
  taskId: string
  phase: TaskAgentPhase
  body: string
  signal?: AbortSignal
  /** resume/followup：同一阶段实例续接，不拆边界。 */
  trigger?: 'resume' | 'followup'
  /** auto-fix 重跑轮次：仅用于日志区分 ReExec #n。 */
  round?: number
}

const SILENT_STAGE_LABEL: Record<TaskAgentPhase, string> = {
  planning: '计划',
  implementation: '实现',
  test_generation: '测试用例'
}

function describeFallback(reason: PiForkReason): string | undefined {
  if (reason === 'plan-schema-incomplete') return '计划缺少必需三段，本阶段与上一阶段共用会话（不拆实例）'
  if (reason === 'no-parent-session') return '上一阶段会话文件已不存在，本阶段新开会话（全量上下文重放）'
  return undefined
}

/**
 * Pi 运行时的阶段 driver。
 *
 * 一个任务同时只有一个活会话（Pi 的 `AgentSession` 自带回合语义），但归属记在
 * 「阶段实例」上：阶段内多次 `runStage` 续接同一实例，阶段之间 fork 出新实例。
 */
export class PiTaskAgent {
  private readonly deps: PiTaskAgentDeps
  /** taskId → 当前阶段实例。 */
  private readonly current = new Map<string, { id: string; phase: StagePhase; seq: number }>()
  /** `${taskId}:${phase}` → 已完成的最近一次产物（`collectResult` 的只读来源）。 */
  private readonly results = new Map<string, TaskAgentResult>()
  /** taskId → 各阶段实例序号计数。 */
  private readonly seqs = new Map<string, Map<StagePhase, number>>()

  constructor(deps: PiTaskAgentDeps) {
    this.deps = deps
  }

  readonly id = 'pi' as const
  readonly displayName = 'Pi Agent'

  capabilities(): TaskAgentCapabilities {
    // fork / 按叶子截断分支原生可用（V13 实测：`SessionManager.forkFrom` 与
    // `createBranchedSession(leafId)` 都产出新会话文件）；按阶段设权限没有原语。
    return { fork: true, truncateAt: true, perPhasePermission: false }
  }

  /** 本阶段当前实例 id（未跑过任何阶段时 undefined）。 */
  stageOf(taskId: string): string | undefined {
    return this.current.get(taskId)?.id
  }

  async runStage(input: PiStageInput): Promise<TaskAgentResult> {
    const store = this.deps.store
    const task = store.getTask(input.taskId)
    if (!task) throw new Error('Task not found')
    const stagePhase = stagePhaseOf(input.phase)
    const previous = this.current.get(input.taskId)
    const decision = decidePiFork({
      phase: input.phase,
      currentPhase: previous?.phase,
      trigger: input.trigger,
      hasParentSession: !!getPiSessionInfo(input.taskId) || !!task.piSessionPath,
      planComplete: checkPlanSections(task.planContent).complete
    })
    const fallback = describeFallback(decision.reason)
    if (fallback) {
      this.deps.logStage(
        input.taskId,
        `${SILENT_STAGE_LABEL[input.phase]}阶段未拆会话边界`,
        `${fallback}（原因：${decision.reason}）`
      )
    }
    // 拆边界：先 fork（内部会释放旧会话并把新会话文件写回 task.piSessionPath）。
    const fork = decision.fork ? await forkPiStage(input.taskId) : undefined
    const forked = fork?.file
    if (decision.fork && !forked) {
      // fork 失败不该让任务失败：退化成新开会话，但必须留下原因（§9 降级 100% 可观测）。
      this.deps.logStage(
        input.taskId,
        `${SILENT_STAGE_LABEL[input.phase]}阶段 fork 失败`,
        `已退化为新开会话（全量上下文重放），本阶段不继承上一阶段前缀：${fork?.error ?? '未知原因'}`
      )
    }
    // 沿用上一阶段实例只有两档：同阶段续接，以及「计划契约不完整 → 宁可不拆一层隔离」。
    // `no-parent-session` / fork 失败都不算：那时会话是全新的，继续挂旧实例 id 会让
    // Trace 把「实现」显示成「计划」的第 N 次执行，掩盖真实的全量重放。
    const keepsPrevious =
      previous && (decision.reason === 'same-stage-reuse' || decision.reason === 'plan-schema-incomplete')
    const ref = keepsPrevious ? previous : this.newInstance(input.taskId, stagePhase)
    // 启动方式以实际发生的事为准：打算 fork 但 `forkPiStage` 返回空 = 新会话，不是 fork。
    const sessionMode: TaskAgentResult['sessionMode'] = forked ? 'fork' : keepsPrevious ? 'continue' : 'new'
    const session = await ensurePiSession(input.taskId, { stageInstanceId: ref.id, phase: input.phase })
    const capturePhase = input.phase === 'planning' || input.phase === 'test_generation' ? input.phase : undefined
    if (capturePhase) beginPiCapture(input.taskId, capturePhase)
    try {
      await session.prompt(input.body, { source: 'rpc' })
      // `prompt()` 在扩展命令吞掉输入或流式排队（steer/followUp）时会提前返回，
      // 只有 `waitForIdle()` 返回才是「本回合真的跑完」。
      await session.waitForIdle()
      input.signal?.throwIfAborted()
      const result: TaskAgentResult = capturePhase
        ? (() => {
            const { text, error } = endPiCapture(input.taskId)
            if (error) throw new Error(error)
            return { responseTexts: text ? [text] : [], stageInstanceId: ref.id, sessionMode }
          })()
        : {
            responseTexts: takePiAgentEndTexts(input.taskId),
            stageInstanceId: ref.id,
            sessionMode
          }
      const info = getPiSessionInfo(input.taskId)
      const finalResult = { ...result, ...(info?.sessionId ? { sessionId: info.sessionId } : {}) }
      this.results.set(`${input.taskId}:${input.phase}`, finalResult)
      return finalResult
    } finally {
      if (capturePhase) endPiCapture(input.taskId)
    }
  }

  /** 只读访问最近一次阶段产物（与 `runStage` 返回值同源）。 */
  collectResult(taskId: string, phase: TaskAgentPhase): TaskAgentResult {
    return this.results.get(`${taskId}:${phase}`) ?? { responseTexts: [] }
  }

  /** 释放某阶段实例的会话：Pi 一个任务只有一个活会话，只回收当前实例。 */
  releaseStage(stageId: string): void {
    const taskId = stageId.split(':')[0] ?? ''
    if (this.current.get(taskId)?.id === stageId) this.current.delete(taskId)
    void releasePiSession(taskId)
  }

  /** 任务终态 / 重置：关掉该任务的 Pi 会话（会话文件保留，供下次续接与对账）。 */
  closeSession(taskId: string): void {
    this.current.delete(taskId)
    void releasePiSession(taskId)
  }

  /** 应用退出。 */
  dispose(): void {
    for (const taskId of [...this.current.keys()]) this.closeSession(taskId)
    this.results.clear()
    this.seqs.clear()
  }

  /** 任务 / 会话被清理时同步丢掉阶段实例（`resetTask` 之后必须从新会话开始）。 */
  forgetTask(taskId: string): void {
    this.current.delete(taskId)
    this.seqs.delete(taskId)
    for (const key of [...this.results.keys()]) if (key.startsWith(`${taskId}:`)) this.results.delete(key)
  }

  private newInstance(taskId: string, phase: StagePhase): { id: string; phase: StagePhase; seq: number } {
    const byPhase = this.seqs.get(taskId) ?? new Map<StagePhase, number>()
    const seq = (byPhase.get(phase) ?? 0) + 1
    byPhase.set(phase, seq)
    this.seqs.set(taskId, byPhase)
    const ref = { id: stageInstanceId(taskId, phase, seq), phase, seq }
    this.current.set(taskId, ref)
    return ref
  }
}

let driver: PiTaskAgent | undefined

export function initPiTaskAgent(deps: PiTaskAgentDeps): PiTaskAgent {
  driver = new PiTaskAgent(deps)
  return driver
}

export function piTaskAgent(): PiTaskAgent {
  if (!driver) throw new Error('pi task agent not initialized')
  return driver
}
