import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePiSessionCwd, purgePiTaskSessionFiles, sweepOrphanPiSessions } from './pi-session-sweep.js'

/**
 * Pi 会话文件回收单测。
 *
 * 归因来自文件首行 header 的 `cwd`（实测 `forkFrom` / `createBranchedSession` 产物同样带），
 * 所以这里既测注入 IO 的判据分支，也测一次真实目录：证明默认的首块读取路径真能解析出 header。
 */

const NOW = 1_760_000_000_000
const DAY = 86_400_000
const ROOTS = ['/data/workspaces', '/data/worktrees']
const DIR = '/data/pi-sessions'

function header(cwd: string): string {
  return `${JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: 't', cwd })}\n{"type":"message"}\n`
}

type Fake = { files: Record<string, string>; removed: string[]; mtimes?: Record<string, number> }

function io(fake: Fake) {
  return {
    listFiles: () => Object.keys(fake.files).map((f) => f.split('/').pop()!),
    readHead: (file: string) => fake.files[file] ?? '',
    statMtimeMs: (file: string) => fake.mtimes?.[file] ?? NOW,
    removeFile: (file: string) => {
      if (!(file in fake.files)) throw new Error(`ENOENT: ${file}`)
      delete fake.files[file]
      fake.removed.push(file)
    }
  }
}

describe('parsePiSessionCwd', () => {
  it('取首行 header 的 cwd（多行 jsonl 只看第一行）', () => {
    expect(parsePiSessionCwd(header('/data/workspaces/task-9/repo'))).toBe('/data/workspaces/task-9/repo')
  })

  it('空串 / 非 JSON / cwd 缺失或空 一律返回 undefined', () => {
    expect(parsePiSessionCwd('')).toBeUndefined()
    expect(parsePiSessionCwd('not json')).toBeUndefined()
    expect(parsePiSessionCwd('{"type":"session"}\n')).toBeUndefined()
    expect(parsePiSessionCwd('{"cwd":""}\n')).toBeUndefined()
  })
})

describe('sweepOrphanPiSessions', () => {
  it('只删「任务已不存在 + 超活动期」的文件，活任务和新鲜的都保留', () => {
    const fake: Fake = {
      files: {
        [`${DIR}/orphan.jsonl`]: header(`${ROOTS[0]}/gone-9/repo`),
        [`${DIR}/live.jsonl`]: header(`${ROOTS[0]}/task-1/repo`),
        [`${DIR}/recent.jsonl`]: header(`${ROOTS[0]}/gone-1/repo`)
      },
      removed: [],
      mtimes: {
        [`${DIR}/orphan.jsonl`]: NOW - 15 * DAY,
        [`${DIR}/live.jsonl`]: NOW - 15 * DAY,
        [`${DIR}/recent.jsonl`]: NOW - DAY
      }
    }
    const result = sweepOrphanPiSessions({
      piSessionsDir: DIR,
      workspacesRoots: ROOTS,
      listTaskIds: () => ['task-1'],
      now: () => NOW,
      ...io(fake)
    })
    expect(result.deleted).toEqual([`${DIR}/orphan.jsonl`])
    expect(result.scanned).toBe(3)
    expect(result.skipped).toBe(2)
  })

  it('归因失败的三种形态都保留：无 cwd、cwd 不在工作区根下、cwd 指到别人家目录', () => {
    const fake: Fake = {
      files: {
        [`${DIR}/nohdr.jsonl`]: '{"type":"session"}\n',
        [`${DIR}/other.jsonl`]: header('/Users/robin/Documents/my-repo'),
        [`${DIR}/escape.jsonl`]: header('/elsewhere/task-1/repo')
      },
      removed: []
    }
    const result = sweepOrphanPiSessions({
      piSessionsDir: DIR,
      workspacesRoots: ROOTS,
      listTaskIds: () => [],
      now: () => NOW,
      ...io(fake)
    })
    expect(result.deleted).toEqual([])
    expect(result.skipped).toBe(3)
  })

  it('mtime 拿不到时保留（宁可留垃圾，不可删错）', () => {
    const fake: Fake = { files: { [`${DIR}/a.jsonl`]: header(`${ROOTS[0]}/gone/repo`) }, removed: [] }
    const result = sweepOrphanPiSessions({
      piSessionsDir: DIR,
      workspacesRoots: ROOTS,
      listTaskIds: () => [],
      now: () => NOW,
      ...io(fake),
      // 文件刚被其它进程删掉：stat 直接报 ENOENT，不能让它冒到调用方。
      statMtimeMs: () => {
        throw new Error('ENOENT: no such file or directory')
      }
    })
    expect(result.deleted).toEqual([])
    expect(result.skipped).toBe(1)
  })

  it('删除失败只记账不抛出：后台清理不能打断应用', () => {
    const fake: Fake = {
      files: { [`${DIR}/a.jsonl`]: header(`${ROOTS[0]}/gone/repo`) },
      removed: [],
      mtimes: { [`${DIR}/a.jsonl`]: NOW - 15 * DAY }
    }
    const result = sweepOrphanPiSessions({
      piSessionsDir: DIR,
      workspacesRoots: ROOTS,
      listTaskIds: () => [],
      now: () => NOW,
      ...io(fake),
      removeFile: () => {
        throw new Error('EBUSY: resource busy')
      }
    })
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].error).toContain('EBUSY')
  })

  it('目录不存在 = 没跑过 Pi 任务，返回空结果而不是抛错', () => {
    const result = sweepOrphanPiSessions({
      piSessionsDir: DIR,
      workspacesRoots: ROOTS,
      listTaskIds: () => [],
      listFiles: () => {
        throw new Error('ENOENT: no such file or directory')
      }
    })
    expect(result).toEqual({ scanned: 0, deleted: [], skipped: 0, failed: [] })
  })

  it('非 .jsonl 文件不进扫描计数', () => {
    const fake: Fake = {
      files: { [`${DIR}/note.txt`]: header(`${ROOTS[0]}/gone/repo`) },
      removed: []
    }
    const result = sweepOrphanPiSessions({
      piSessionsDir: DIR,
      workspacesRoots: ROOTS,
      listTaskIds: () => [],
      now: () => NOW,
      ...io(fake)
    })
    expect(result.scanned).toBe(0)
  })
})

describe('purgePiTaskSessionFiles', () => {
  it('任务删除级联：属于该任务的全部文件都删（含 fork 前驱），且不看活动期', () => {
    const fake: Fake = {
      files: {
        [`${DIR}/plan.jsonl`]: header(`${ROOTS[0]}/task-1/repo`),
        [`${DIR}/exec.jsonl`]: header(`${ROOTS[0]}/task-1/other-repo`),
        [`${DIR}/other.jsonl`]: header(`${ROOTS[0]}/task-2/repo`)
      },
      removed: [],
      // plan/exec 都是刚写的：任务都没了，不该再等 14 天。
      mtimes: { [`${DIR}/plan.jsonl`]: NOW, [`${DIR}/exec.jsonl`]: NOW, [`${DIR}/other.jsonl`]: NOW }
    }
    const result = purgePiTaskSessionFiles({
      piSessionsDir: DIR,
      workspacesRoots: ROOTS,
      taskId: 'task-1',
      ...io(fake)
    })
    expect(result.deleted.sort()).toEqual([`${DIR}/exec.jsonl`, `${DIR}/plan.jsonl`])
    expect(fake.removed).toEqual(expect.arrayContaining([`${DIR}/plan.jsonl`, `${DIR}/exec.jsonl`]))
    expect(result.skipped).toBe(1)
  })

  it('归因失败的文件即使任务被删也保留', () => {
    const fake: Fake = { files: { [`${DIR}/broken.jsonl`]: '' }, removed: [] }
    const result = purgePiTaskSessionFiles({
      piSessionsDir: DIR,
      workspacesRoots: ROOTS,
      taskId: 'task-1',
      ...io(fake)
    })
    expect(result.deleted).toEqual([])
    expect(fake.removed).toEqual([])
  })
})

describe('真实目录冒烟（默认 IO）', () => {
  it('首块读取能吃下真实 header：孤儿删掉、活任务的文件留在盘上', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-sweep-'))
    const workspaces = join(dir, 'workspaces')
    try {
      const write = (name: string, taskId: string, ageDays: number): string => {
        const file = join(dir, name)
        writeFileSync(file, header(join(workspaces, taskId, 'repo')), 'utf8')
        // 只改 mtime，内容保持真实可读（走默认 IO 才能验到首块读取）。
        const at = (NOW - ageDays * DAY) / 1000
        utimesSync(file, at, at)
        return file
      }
      const orphan = write('orphan.jsonl', 'gone-task', 15)
      const live = write('live.jsonl', 'task-1', 15)
      const result = sweepOrphanPiSessions({
        piSessionsDir: dir,
        workspacesRoots: [workspaces],
        listTaskIds: () => ['task-1'],
        now: () => NOW
      })
      expect(result.deleted).toEqual([orphan])
      expect(result.scanned).toBe(2)
      expect(() => readFileSync(orphan, 'utf8')).toThrow()
      expect(readFileSync(live, 'utf8')).toContain('task-1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
