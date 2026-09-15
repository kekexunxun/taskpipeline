/**
 * 任务会话回收（P4，§4.4）。
 *
 * 为什么需要：qodercli 把每个会话写成 `~/.qoder/projects/<cwd 编码>/<sessionId>.jsonl`，
 * **没有任何自动回收**（V6 实测：单是空目录 bucket 就 266 个、本仓库 88 个会话）。
 * 阶段实例化（P1）之后每次阶段执行都会新增一个会话，累积速度更快，所以回收必须和它同期落地。
 *
 * 三条实测约束决定了实现形态（V14，scripts/qoder-session-store-probe.mjs）：
 *  1. `listSessions()` 不带 dir 时跨全部项目聚合，且 `SDKSessionInfo.cwd` 都有值 —— 因此
 *     「按 cwd 判断归属」可行，不需要我们去反解项目目录名；
 *  2. 目录名是 cwd 的**有损**编码（非字母数字 → `-`），不能从目录名推回 cwd —— 所以删除时
 *     必须用 `info.cwd`，不能用目录名；
 *  3. `deleteSession(id)` 不传 dir 必然报 `Session <id> not found`（它不跨项目搜），
 *     且 id 必须是 UUID —— 所以每条删除都显式带 `{ dir: info.cwd }`。
 *
 * 只回收「本应用任务工作区里、对应任务已不存在、且久未活动」的会话：
 * 用户自己的对话会话、其它项目的会话一律不碰。判定失败时一律保留（宁可留垃圾，不可删错）。
 *
 * 另有一套 Pi 侧回收（`task/pi-session-sweep.ts`）：Pi 会话文件不在 `~/.qoder` 而在
 * `<dataDir>/pi-sessions`，名字里没有任务 id，但**首行 header 带 `cwd`**（临时目录实测：
 * `forkFrom` / `createBranchedSession` 的产物也一样带），所以那边直接复用本文件的
 * `taskOwnerOfCwd()` 与 `isAgedOut()`，两条回收路径共用同一套护栏。
 */

import { relative, sep } from 'node:path'
import { deleteSession, listSessions } from '@qoder-ai/qoder-agent-sdk'
import type { SDKSessionInfo } from '@qoder-ai/qoder-agent-sdk'

/** 缺省回收阈值：比任务重跑窗口宽得多，避免删掉「上周的任务这周还想续」。 */
export const DEFAULT_MAX_AGE_DAYS = 14

/** 一次列全量的上限：`listSessions` 默认 limit 太小，V14 实测本机已有 385 条。 */
const SWEEP_LIMIT = 5000

export type SessionSweepDeps = {
  /** 任务工作区根目录集合（`<dataDir>/workspaces`，含历史的 `<dataDir>/worktrees`）。 */
  workspacesRoots: string[]
  /** DB 里仍存在的任务 id：判定「孤儿」的唯一依据。 */
  listTaskIds: () => string[]
  /** 活动期超过多少天才回收。 */
  maxAgeDays?: number
  /** 注入时钟（单测用）。 */
  now?: () => number
  /** 注入 SDK 原语（单测用；线上走默认实现）。 */
  list?: () => Promise<SDKSessionInfo[]>
  remove?: (sessionId: string, options: { dir: string }) => Promise<unknown>
  log?: (message: string) => void
}

export type SessionSweepResult = {
  scanned: number
  deleted: string[]
  /** 命中孤儿规则但缺 sessionId 因而没法删的条数（`deleteSession` 只认 UUID，实测约束 3）。 */
  skipped: number
  failed: Array<{ sessionId: string; error: string }>
}

const DAY_MS = 86_400_000

/** 是否已超出活动期（时间戳不可用时一律保留：宁可留垃圾，不可删错）。 */
export function isAgedOut(input: { now: number; lastModified: number; maxAgeDays: number }): boolean {
  if (!Number.isFinite(input.lastModified)) return false
  return input.now - input.lastModified > input.maxAgeDays * DAY_MS
}

/**
 * cwd 是否落在某个任务工作区里，是则返回归属的 taskId。
 *
 * 形如 `<dataDir>/workspaces/<taskId>/<repo>`（一层仓库目录）或直接就是
 * `<dataDir>/workspaces/<taskId>`，所以取相对路径的第一段。
 */
export function taskOwnerOfCwd(cwd: string | undefined, workspacesRoots: string[]): string | undefined {
  if (!cwd) return undefined
  for (const root of workspacesRoots) {
    if (!root) continue
    const rel = relative(root, cwd)
    if (!rel || rel.startsWith('..') || rel.includes(':')) continue // 不在该根下（含跨盘符形态）
    const owner = rel.split(sep)[0]
    if (owner) return owner
  }
  return undefined
}

/** 是否该被回收：属于任务工作区 + 任务已不在 DB + 超过活动期（时间缺失一律保留）。 */
export function isReclaimableSession(
  info: SDKSessionInfo,
  options: { workspacesRoots: string[]; liveTaskIds: Set<string>; maxAgeDays: number; now: number }
): boolean {
  const owner = taskOwnerOfCwd(info.cwd, options.workspacesRoots)
  if (!owner || options.liveTaskIds.has(owner)) return false
  return isAgedOut({ now: options.now, lastModified: info.lastModified, maxAgeDays: options.maxAgeDays })
}

/**
 * 执行一次回收。
 *
 * 失败只记账不抛出：这是后台清理，任何异常都不该影响应用启动或任务执行。
 */
export async function sweepOrphanTaskSessions(deps: SessionSweepDeps): Promise<SessionSweepResult> {
  const maxAgeDays = deps.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const now = (deps.now ?? Date.now)()
  const sessions = await (deps.list ?? (() => listSessions({ limit: SWEEP_LIMIT })))()
  const liveTaskIds = new Set(deps.listTaskIds())
  const result: SessionSweepResult = { scanned: sessions.length, deleted: [], skipped: 0, failed: [] }

  for (const info of sessions) {
    if (!isReclaimableSession(info, { workspacesRoots: deps.workspacesRoots, liveTaskIds, maxAgeDays, now })) continue
    // 两道硬要求都要在类型上窄化：`deleteSession` 只认 UUID（实测约束 3），dir 只能取会话自己的 cwd。
    if (!info.sessionId || !info.cwd) {
      result.skipped += 1
      continue
    }
    try {
      // dir 必传（实测约束 3）：它就是会话自己的 cwd，SDK 据此定位项目目录。
      await (deps.remove ?? deleteSession)(info.sessionId, { dir: info.cwd })
      result.deleted.push(info.sessionId)
    } catch (error) {
      result.failed.push({ sessionId: info.sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  deps.log?.(
    `会话回收：扫描 ${result.scanned}，删除 ${result.deleted.length}，跳过 ${result.skipped}，失败 ${result.failed.length}`
  )
  // 删了哪些要能事后对账：这是对用户数据的不可逆操作，只报个数不够。
  if (result.deleted.length) deps.log?.(`会话回收明细：${result.deleted.join(', ')}`)
  if (result.failed.length)
    deps.log?.(`会话回收失败：${result.failed.map((f) => `${f.sessionId}(${f.error})`).join(', ')}`)
  return result
}

export type SessionPurgeDeps = {
  /** 要清理的目录（任务 worktree / 工作区）；不在工作区根下的会被直接拒绝。 */
  dirs: string[]
  workspacesRoots: string[]
  listByDir?: (dir: string) => Promise<SDKSessionInfo[]>
  remove?: (sessionId: string, options: { dir: string }) => Promise<unknown>
  log?: (message: string) => void
}

/**
 * 任务删除 / reset 的即时级联（§4.4）：清掉这个任务工作区目录里的全部会话。
 *
 * 两道护栏：
 *  - `dirs` 必须落在任务工作区根下 —— 任务的 `localPath`（用户仓库本身）也在会话 cwd 里，
 *    不拦就会把用户自己的对话会话一并删掉；
 *  - 失败只记录不抛出：删不掉的交给周期回收兜底。
 */
export async function purgeTaskSessions(deps: SessionPurgeDeps): Promise<SessionSweepResult> {
  const list = deps.listByDir ?? ((dir: string) => listSessions({ dir, limit: SWEEP_LIMIT }))
  const result: SessionSweepResult = { scanned: 0, deleted: [], skipped: 0, failed: [] }
  const seen = new Set<string>()
  for (const dir of deps.dirs) {
    if (!dir) continue
    if (!taskOwnerOfCwd(dir, deps.workspacesRoots)) {
      result.skipped += 1
      deps.log?.(`会话回收跳过 ${dir}：不在任务工作区根下`)
      continue
    }
    let sessions: SDKSessionInfo[]
    try {
      sessions = await list(dir)
    } catch (error) {
      result.failed.push({ sessionId: dir, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    result.scanned += sessions.length
    for (const info of sessions) {
      if (!info.sessionId || seen.has(info.sessionId)) continue
      seen.add(info.sessionId)
      try {
        await (deps.remove ?? deleteSession)(info.sessionId, { dir })
        result.deleted.push(info.sessionId)
      } catch (error) {
        result.failed.push({
          sessionId: info.sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
  return result
}
