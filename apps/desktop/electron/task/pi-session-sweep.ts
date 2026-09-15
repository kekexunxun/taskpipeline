/**
 * Pi 会话文件回收（P4-4 的 Pi 侧，方案 §4.4）。
 *
 * 为什么单独一个文件：Pi 的会话不在 qodercli 的 `~/.qoder/projects/**`，而在我们自己的
 * `<dataDir>/pi-sessions/<ISO时间>_<uuid>.jsonl`，没有 SDK 的 `listSessions` 可列 —— 只能扫目录。
 *
 * 归属信息在哪：文件名里没有 taskId，但**首行 header 带 `cwd`**（临时目录实测，见方案 §4.4 更正）：
 * header 字段集固定为 `type,version,id,timestamp,cwd[,parentSession]`，且 `forkFrom` /
 * `createBranchedSession` 的产物同样带 `cwd`。cwd 形态与 Qoder 侧一致
 * （`<dataDir>/workspaces/<taskId>/<repoName>`），所以归因直接复用 `taskOwnerOfCwd()`，
 * 不需要另建一套索引。
 *
 * 为什么不能只靠 DB 指针：一个任务只有一个 `task.piSessionPath`，而 `forkPiStage` 每次阶段边界
 * 都把它换成新文件 —— 前驱文件当场变孤儿。本机实测：3 个文件 / 2 个任务，两个任务的指针**都是空**，
 * 即 100% 靠 DB 管不到。
 *
 * 护栏与 Qoder 侧同一条：归因必须落在任务工作区根下、任务已不存在、且超出活动期；
 * header 解析不出 cwd 的文件一律保留（宁可留垃圾，不可删错）。
 */

import { closeSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MAX_AGE_DAYS, isAgedOut, taskOwnerOfCwd } from '../pi-extension/qoder/session-sweep.js'

/** 只读文件首块：header 是首行 JSON，远小于这个窗口；读不满就按解析失败保留。 */
const HEADER_BYTES = 8_192

export type PiSessionSweepResult = {
  scanned: number
  /** 已删除的文件路径。 */
  deleted: string[]
  /** 留在盘上但没判定为孤儿（含 header 解析失败）的条数。 */
  skipped: number
  failed: Array<{ file: string; error: string }>
}

/** 目录 IO 注入点（单测用）；线上走默认实现。 */
type PiFileIo = {
  listFiles?: (dir: string) => string[]
  readHead?: (file: string) => string
  statMtimeMs?: (file: string) => number
  removeFile?: (file: string) => void
}

export type PiSessionSweepDeps = PiFileIo & {
  /** `<dataDir>/pi-sessions`。 */
  piSessionsDir: string
  workspacesRoots: string[]
  /** DB 里仍存在的任务 id：判定「孤儿」的唯一依据。 */
  listTaskIds: () => string[]
  maxAgeDays?: number
  now?: () => number
  log?: (message: string) => void
}

export type PiSessionPurgeDeps = PiFileIo & {
  piSessionsDir: string
  workspacesRoots: string[]
  /** 要清掉哪个任务的会话文件（任务删除 / 重置的即时级联，不看活动期）。 */
  taskId: string
  log?: (message: string) => void
}

/** 解析会话文件首行 header 的 cwd；拿不到就返回 undefined（调用方保留文件）。 */
export function parsePiSessionCwd(head: string): string | undefined {
  const line = head.split('\n', 1)[0]?.trim()
  if (!line) return undefined
  try {
    const parsed = JSON.parse(line) as { cwd?: unknown }
    return typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : undefined
  } catch {
    return undefined
  }
}

function readHeadDefault(file: string): string {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(HEADER_BYTES)
    const bytes = readSync(fd, buf, 0, HEADER_BYTES, 0)
    return buf.subarray(0, bytes).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 已关闭 */
      }
    }
  }
}

/**
 * 扫一遍目录，按 `accept(owner, mtimeMs)` 决定删谁。
 *
 * 周期 sweep 与任务级 purge 只差判据，共用这一份扫描，避免两条路径的护栏漂移。
 */
function reclaimPiSessionFiles(
  deps: PiFileIo & { piSessionsDir: string; workspacesRoots: string[] },
  accept: (owner: string, mtimeMs: number) => boolean
): PiSessionSweepResult {
  const listFiles = deps.listFiles ?? ((dir: string) => readdirSync(dir))
  const readHead = deps.readHead ?? readHeadDefault
  const statMtimeMs = deps.statMtimeMs ?? ((file: string) => statSync(file).mtimeMs)
  const removeFile = deps.removeFile ?? ((file: string) => rmSync(file, { force: true }))
  const result: PiSessionSweepResult = { scanned: 0, deleted: [], skipped: 0, failed: [] }

  let names: string[]
  try {
    names = listFiles(deps.piSessionsDir)
  } catch {
    // 目录不存在 = 这台机器还没跑过 Pi 任务，不是错误。
    return result
  }

  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(deps.piSessionsDir, name)
    result.scanned += 1
    const owner = taskOwnerOfCwd(parsePiSessionCwd(readHead(file)), deps.workspacesRoots)
    if (!owner) {
      result.skipped += 1
      continue
    }
    let mtimeMs = Number.NaN
    try {
      mtimeMs = statMtimeMs(file)
    } catch {
      result.skipped += 1
      continue
    }
    if (!accept(owner, mtimeMs)) {
      result.skipped += 1
      continue
    }
    try {
      removeFile(file)
      result.deleted.push(file)
    } catch (error) {
      result.failed.push({ file, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/** 周期回收：属于已删除任务、且超出活动期的 Pi 会话文件。 */
export function sweepOrphanPiSessions(deps: PiSessionSweepDeps): PiSessionSweepResult {
  const maxAgeDays = deps.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const now = (deps.now ?? Date.now)()
  const liveTaskIds = new Set(deps.listTaskIds())
  const result = reclaimPiSessionFiles(deps, (owner, mtimeMs) => {
    if (liveTaskIds.has(owner)) return false
    return isAgedOut({ now, lastModified: mtimeMs, maxAgeDays })
  })
  deps.log?.(
    `Pi 会话回收：扫描 ${result.scanned}，删除 ${result.deleted.length}，保留 ${result.skipped}，失败 ${result.failed.length}`
  )
  // 这是对用户数据的不可逆操作，只报个数不够：删了哪些要能事后对账。
  if (result.deleted.length) deps.log?.(`Pi 会话回收明细：${result.deleted.map((f) => f.split('/').pop()).join(', ')}`)
  if (result.failed.length)
    deps.log?.(`Pi 会话回收失败：${result.failed.map((f) => `${f.file}(${f.error})`).join(', ')}`)
  return result
}

/**
 * 任务删除 / 重置的即时级联：清掉属于这个任务的全部 Pi 会话文件（含 fork 前驱）。
 *
 * 不看活动期 —— 任务都没了就没有「这周还想续」的顾虑；但归因失败的文件仍然保留。
 */
export function purgePiTaskSessionFiles(deps: PiSessionPurgeDeps): PiSessionSweepResult {
  const result = reclaimPiSessionFiles(deps, (owner) => owner === deps.taskId)
  if (result.deleted.length) deps.log?.(`任务 ${deps.taskId} 回收 ${result.deleted.length} 个 Pi 会话文件`)
  if (result.failed.length)
    deps.log?.(`任务 ${deps.taskId} Pi 会话删除失败：${result.failed.map((f) => `${f.file}(${f.error})`).join(', ')}`)
  return result
}
