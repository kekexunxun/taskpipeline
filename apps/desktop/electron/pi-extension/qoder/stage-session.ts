/**
 * 阶段实例与会话归属（P1）。
 *
 * 会话粒度从「一任务一常驻会话」改为「一阶段实例一会话」：
 *  - 阶段内续接（plan 重跑、auto-fix、暂停恢复）→ 同一会话，省掉重复探索；
 *  - 阶段间分叉（Plan → Exec）→ 从上一阶段的会话 fork 出新会话，继承其上下文前缀，
 *    但权限、脏轨迹、审批互不串味（见 docs/task-stage-session-boundary-plan.md §2、§3）。
 *
 * 本文件只放「与会话生命周期算法有关」的部分：阶段实例标识、fork 点选取、降级阶梯。
 * 实际的会话创建在 qoder-session.ts，编排在 qoder-task-agent.ts。
 */

import { QoderCliProcessError, getSessionMessages } from '@qoder-ai/qoder-agent-sdk'
import type { StagePhase } from '../../task/stage-instance.js'

// 阶段实例标识与阶段名是运行时无关的契约，定在 `task/stage-instance.ts`（Qoder / Pi 共用）；
// 本文件只留 Qoder 会话原语（launch / anchor / 降级阶梯）。
export type { StagePhase }
export { stagePhaseOf, stageInstanceId, stageIdOfTask } from '../../task/stage-instance.js'

/** 一次阶段执行 = 一个阶段实例；会话绑阶段实例，不绑任务。 */
export type StageSessionRef = {
  /** `${taskId}:${phase}:${seq}` —— 会话注册表的 key。 */
  id: string
  phase: StagePhase
  /** 本阶段实例自己的会话 id（新建 / fork 后由 `system/init` 落定）。 */
  qoderSessionId?: string
  /** 上一阶段实例的会话 id：fork 的父，或续接时的 resume 目标。 */
  parentSessionId?: string
  /** fork 点：被保留的最后一个 turn 的「最后一条 entry」uuid。 */
  anchorEntryUuid?: string
}

/**
 * 会话启动方式：`launch` 是一次尝试的全部输入。
 *
 * 阶梯顺序（每档降级都必须落 Trace，禁止静默）：
 *   fork(anchor) → fork(无 anchor，全量继承) → 全量 prompt 重放（新建会话）
 *   resume → 全量 prompt 重放
 *   continue（复用存活会话） → resume → 全量 prompt 重放
 */
export type SessionLaunch = {
  mode: 'new' | 'continue' | 'resume' | 'fork'
  stageInstanceId: string
  /** 只有 resume / fork 需要：要继续或分叉自哪个会话。 */
  resume?: string
  forkSession?: boolean
  resumeSessionAt?: string
  anchorEntryUuid?: string
  /** 本档是第几次降级（0 = 首选方案）。 */
  downgradeStep?: number
  /** 降级原因（downgradeStep > 0 时必填）。 */
  fallback?: ForkFallbackReason
}

export type ForkFallbackReason =
  /** 上一阶段会话已不在磁盘上（被清理 / 换机器 / 从未落盘）。 */
  | 'parent-session-missing'
  /** 读不到会话条目，算不出 fork 点。 */
  | 'anchor-unavailable'
  /** 带 anchor 的 fork 被 CLI 拒绝（V3：范围不以被保留 turn 的 prompt 开头等）。 */
  | 'anchor-rejected'
  /** fork 启动期整体失败（transport / 权限 / 未知）。 */
  | 'fork-failed'
  /** 续接的会话已经死了，改为按 sessionId 恢复。 */
  | 'session-lost'
  /** 恢复历史会话失败，改为全量 prompt 重放。 */
  | 'resume-failed'
  /**
   * 计划正文缺 §4.3 的必需三段 → 本阶段不拆实例，继续共享上一阶段会话。
   *
   * 与其他值不同：这不是「启动方式失败后的重试」，而是起跑前就判定的契约缺省，
   * 目的是让存量任务（旧 plan 没有三段）不至于因为拆边界而重新探索一遍仓库。
   */
  | 'plan_schema_incomplete'
  /**
   * 父会话上下文占用超预算（P4）→ 不再 fork，改用「产物 + 摘要」新建会话。
   *
   * 与 `plan_schema_incomplete` 同为起跑前判定。理由：V8 实测 headless 会话不会自动压缩
   * （`autoCompact.enabled = false`），fork 是「继承前缀」而不是「丢弃前缀」，因此上下文
   * 已膨胀的父会话 fork 出来的子会话会一直带着那份膨胀 —— 此时阶段产物才是更便宜的输入。
   */
  | 'context-budget'

/**
 * 阶段级会话权限（P4，§5 表）。
 *
 * 为什么在 `query()` 创建时定，而不是中途 `setPermissionMode`：会话已绑阶段实例，
 * 一个阶段实例的权限从头到尾不变；中途切会重建 tools 并破 prompt cache（V10 的缺陷
 * 正是「acceptEdits 全阶段贯通」，Plan 阶段能直接写文件）。
 *
 * `disallowedTools` 是 CLI 层硬边界（模型侧根本看不到这些工具），与 core 的 L1 判定互补：
 * 前者管 Qoder，后者管两条引擎的全部工具入口（含 Pi 与 MCP）。
 */
export type StagePermission = {
  permissionMode: 'default' | 'acceptEdits'
  disallowedTools?: string[]
}

/**
 * Plan 阶段禁掉的写类工具名。
 *
 * 取自 V10 实测的 init `tools` 清单（`Edit` / `Write` / `NotebookEdit`）；SDK 类型里没有
 * `MultiEdit`，因此不能按 `WRITE_TOOL_FRAGMENT` 那份正则去猜名字 —— 猜错的名字不会报错，
 * 只会静默地不禁（那比不配更危险）。
 */
const PLAN_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit']

export function permissionsForStage(phase: StagePhase): StagePermission {
  if (phase === 'planning') return { permissionMode: 'default', disallowedTools: [...PLAN_DISALLOWED_TOOLS] }
  // Test 阶段的「只改测试文件」是路径级约束，CLI 工具粒度到不了（`Edit` 不能按路径分档），
  // 因此这一条仍由 core 的 `evaluateExecutionPermission({ phase: 'test' })` 承担。
  return { permissionMode: 'acceptEdits' }
}

/**
 * 本档启动方式是否继承了已有会话上下文。
 *
 * 继承（continue / resume / fork）意味着任务上下文、Agent 指引、记忆注入都已在会话前缀里，
 * 阶段 prompt 只需发「阶段指令」；只有 `new`（全量 prompt 重放）才要重新拼全套上下文。
 */
export function inheritsContext(launch: SessionLaunch): boolean {
  return launch.mode !== 'new'
}

/**
 * fork 点选取（必须照这个算法，否则 CLI exit 42）。
 *
 * SDK 文档对 `resumeSessionAt` 的措辞是「Use the last entry belonging to the turn
 * that must be kept」：指向某个 turn 的 user 条目会被判为「丢弃范围不以该 turn 的
 * prompt 开头」而拒绝（实测 stderr：`Resume rejected by --resume-drops-turn: range
 * does not start with the declared turn prompt`）。所以要取「最后一个 turn 的尾部」。
 *
 * @returns anchor uuid；会话不存在或无 user turn 时返回 undefined
 */
export async function resolveForkAnchorUuid(parentSessionId: string, cwd: string): Promise<string | undefined> {
  try {
    const entries = await getSessionMessages(parentSessionId, { dir: cwd })
    if (entries.length === 0) return undefined
    let lastUserIdx = -1
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index]?.type === 'user') lastUserIdx = index
    }
    if (lastUserIdx < 0) return entries[entries.length - 1]?.uuid
    for (let index = entries.length - 1; index >= lastUserIdx; index -= 1) {
      const entry = entries[index]
      if (entry && (entry.type === 'user' || entry.type === 'assistant')) return entry.uuid
    }
    return undefined
  } catch {
    // 读会话文件失败（权限 / 磁盘 / 格式）与「会话不存在」同档处理：降级而不是让任务失败。
    return undefined
  }
}

/** 会话文件里是否还有这个会话（决定要不要直接跳到「全量重放」档）。 */
export async function hasSessionTranscript(parentSessionId: string, cwd: string): Promise<boolean> {
  try {
    return (await getSessionMessages(parentSessionId, { dir: cwd })).length > 0
  } catch {
    return false
  }
}

/**
 * 只有「启动期失败」才能安全降级重试：CLI 在 resume/fork 参数被拒时直接退出（exit 42），
 * 此时模型一条输出都没产出，重放不会重复执行已产生的副作用（改文件 / commit）。
 * 一旦已有输出，必须原样上抛，交给上层判定，避免出现「同一个 Edit 执行两遍」。
 */
export function isResumableStartupFailure(error: unknown): boolean {
  return error instanceof QoderCliProcessError
}

/** 下一档降级方案；返回 undefined 表示阶梯到头。 */
export function nextLaunch(current: SessionLaunch, reason: ForkFallbackReason): SessionLaunch | undefined {
  const step = (current.downgradeStep ?? 0) + 1
  const stageInstanceId = current.stageInstanceId
  switch (current.mode) {
    case 'fork':
      // 带 anchor 被拒 → 去掉 anchor 全量继承；再失败（或本来就没 anchor）→ 全量 prompt 重放。
      if (current.resumeSessionAt && current.resume)
        return {
          mode: 'fork',
          stageInstanceId,
          resume: current.resume,
          forkSession: true,
          downgradeStep: step,
          fallback: reason
        }
      return { mode: 'new', stageInstanceId, downgradeStep: step, fallback: reason }
    case 'resume':
      return { mode: 'new', stageInstanceId, downgradeStep: step, fallback: reason }
    case 'continue':
      return current.resume
        ? {
            mode: 'resume',
            stageInstanceId,
            resume: current.resume,
            downgradeStep: step,
            fallback: reason
          }
        : { mode: 'new', stageInstanceId, downgradeStep: step, fallback: reason }
    default:
      return undefined
  }
}

/** 启动方式的中文名（任务事件 / Trace 展示用，避免只剩一个英文枚举）。 */
export function describeLaunch(launch: SessionLaunch): string {
  const base =
    launch.mode === 'fork'
      ? launch.resumeSessionAt
        ? 'fork（截断到 anchor）'
        : 'fork（全量继承）'
      : launch.mode === 'continue'
        ? '同会话续接'
        : launch.mode === 'resume'
          ? 'resume 历史会话'
          : '全量 prompt 重放'
  return launch.downgradeStep ? `${base}（降级第 ${launch.downgradeStep} 档）` : base
}
