import { describe, expect, it, vi } from 'vitest'

/**
 * 会话回收单测（P4，§4.4）。
 *
 * SDK 的 `listSessions` / `deleteSession` 全部走注入；默认实现只在这两个函数上包一层，
 * 所以 mock 掉它们就足以锁住「删谁、带不带 dir、失败怎么记」这三件事。
 */
vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  listSessions: async () => [],
  deleteSession: async () => undefined
}))

const { isReclaimableSession, purgeTaskSessions, sweepOrphanTaskSessions, taskOwnerOfCwd } = await import(
  './session-sweep.js'
)

type Session = { sessionId: string; summary: string; lastModified: number; cwd?: string }

const NOW = Date.parse('2026-09-14T00:00:00.000Z')
const DAY = 86_400_000
const ROOTS = ['/data/workspaces', '/data/worktrees']

const session = (overrides: Partial<Session> & { sessionId: string }): Session =>
  ({ summary: 's', lastModified: NOW, cwd: '/data/workspaces/task-1/repo', ...overrides }) as Session

describe('taskOwnerOfCwd', () => {
  it('从任务工作区路径里取归属任务', () => {
    expect(taskOwnerOfCwd('/data/workspaces/task-1/repo', ROOTS)).toBe('task-1')
    expect(taskOwnerOfCwd('/data/workspaces/task-1', ROOTS)).toBe('task-1')
    // 历史目录名也要认：旧任务把 worktree 建在 worktrees/ 下
    expect(taskOwnerOfCwd('/data/worktrees/task-9/repo', ROOTS)).toBe('task-9')
  })

  it('工作区之外的路径一律不归因', () => {
    expect(taskOwnerOfCwd('/Users/robin/Documents/codingagent', ROOTS)).toBeUndefined()
    expect(taskOwnerOfCwd('/data/workspaces', ROOTS)).toBeUndefined()
    expect(taskOwnerOfCwd(undefined, ROOTS)).toBeUndefined()
    expect(taskOwnerOfCwd('/data/workspaces-extra/task-1', ROOTS)).toBeUndefined()
  })
})

describe('isReclaimableSession', () => {
  const base = { workspacesRoots: ROOTS, liveTaskIds: new Set<string>(['task-1']), maxAgeDays: 14, now: NOW }

  it('只认「任务已不在 DB + 超过活动期」的任务工作区会话', () => {
    expect(
      isReclaimableSession(
        session({ sessionId: 'a', cwd: '/data/workspaces/gone/repo', lastModified: NOW - 15 * DAY }),
        base
      )
    ).toBe(true)
    expect(
      isReclaimableSession(
        session({ sessionId: 'b', cwd: '/data/worktrees/gone/repo', lastModified: NOW - 15 * DAY }),
        base
      )
    ).toBe(true)
  })

  it('活着的任务、别人的项目、太新的会话都保留', () => {
    expect(isReclaimableSession(session({ sessionId: 'c' }), base)).toBe(false)
    expect(isReclaimableSession(session({ sessionId: 'd', cwd: '/Users/robin/blog' }), base)).toBe(false)
    expect(
      isReclaimableSession(session({ sessionId: 'e', cwd: '/data/workspaces/gone', lastModified: NOW - DAY }), base)
    ).toBe(false)
  })

  it('时间戳缺失时保留（宁可留垃圾，不可删错）', () => {
    expect(
      isReclaimableSession(session({ sessionId: 'f', cwd: '/data/workspaces/gone' }), {
        ...base,
        now: Number.NaN
      })
    ).toBe(false)
  })
})

describe('sweepOrphanTaskSessions', () => {
  it('只删孤儿会话，且每条删除都带上它自己的 cwd', async () => {
    const removed: Array<{ id: string; dir?: string }> = []
    const result = await sweepOrphanTaskSessions({
      workspacesRoots: ROOTS,
      listTaskIds: () => ['task-1'],
      now: () => NOW,
      list: async () =>
        [
          session({ sessionId: 'live', cwd: '/data/workspaces/task-1/repo' }),
          session({ sessionId: 'orphan', cwd: '/data/workspaces/gone/repo', lastModified: NOW - 30 * DAY }),
          session({ sessionId: 'recent', cwd: '/data/workspaces/gone/repo', lastModified: NOW - DAY }),
          session({ sessionId: 'chat', cwd: '/Users/robin/blog', lastModified: NOW - 90 * DAY }),
          // 连 cwd 都没有：无法归因到任务，既不能删也不计入孤儿
          { sessionId: 'headless', summary: '', lastModified: NOW - 90 * DAY }
        ] as never[],
      remove: async (sessionId, options) => {
        removed.push({ id: sessionId, dir: options.dir })
      }
    })
    expect(result.deleted).toEqual(['orphan'])
    expect(removed).toEqual([{ id: 'orphan', dir: '/data/workspaces/gone/repo' }])
    expect(result.scanned).toBe(5)
    expect(result.skipped).toBe(0)
  })

  it('删除失败只记账并继续，不影响其余会话', async () => {
    const result = await sweepOrphanTaskSessions({
      workspacesRoots: ROOTS,
      listTaskIds: () => [],
      now: () => NOW,
      list: async () =>
        [
          session({ sessionId: 'bad', cwd: '/data/workspaces/gone', lastModified: NOW - 30 * DAY }),
          session({ sessionId: 'good', cwd: '/data/workspaces/gone2', lastModified: NOW - 30 * DAY })
        ] as never[],
      remove: async (sessionId) => {
        if (sessionId === 'bad') throw new Error('Invalid sessionId')
      }
    })
    expect(result.deleted).toEqual(['good'])
    expect(result.failed).toEqual([{ sessionId: 'bad', error: 'Invalid sessionId' }])
  })

  it('无 sessionId 的孤儿计入 skipped：UUID 是 deleteSession 的硬要求（实测）', async () => {
    const removed: string[] = []
    const result = await sweepOrphanTaskSessions({
      workspacesRoots: ROOTS,
      listTaskIds: () => [],
      now: () => NOW,
      list: async () =>
        [{ sessionId: '', summary: '', lastModified: NOW - 30 * DAY, cwd: '/data/workspaces/gone' }] as never[],
      remove: async (sessionId) => {
        removed.push(sessionId)
      }
    })
    expect(removed).toEqual([])
    expect(result.skipped).toBe(1)
  })
})

describe('purgeTaskSessions（任务删除 / reset 的即时级联）', () => {
  it('按目录列出并删除，dir 用传入目录本身', async () => {
    const removed: Array<{ id: string; dir?: string }> = []
    const result = await purgeTaskSessions({
      dirs: ['/data/workspaces/task-1/repo'],
      workspacesRoots: ROOTS,
      listByDir: async () => [session({ sessionId: 'p' }), session({ sessionId: 'q' })] as never[],
      remove: async (sessionId, options) => {
        removed.push({ id: sessionId, dir: options.dir })
      }
    })
    expect(result.deleted).toEqual(['p', 'q'])
    expect(removed).toEqual([
      { id: 'p', dir: '/data/workspaces/task-1/repo' },
      { id: 'q', dir: '/data/workspaces/task-1/repo' }
    ])
  })

  it('拒绝工作区根之外的目录：否则会删掉用户自己的对话会话', async () => {
    const listed: string[] = []
    const result = await purgeTaskSessions({
      dirs: ['/Users/robin/blog', '/data/workspaces/task-1/repo'],
      workspacesRoots: ROOTS,
      listByDir: async (dir) => {
        listed.push(dir)
        return []
      }
    })
    expect(listed).toEqual(['/data/workspaces/task-1/repo'])
    expect(result.skipped).toBe(1)
  })

  it('同一会话在多个目录里被列出时只删一次', async () => {
    const removed: string[] = []
    const result = await purgeTaskSessions({
      dirs: ['/data/workspaces/task-1/repo', '/data/workspaces/task-1/other'],
      workspacesRoots: ROOTS,
      listByDir: async () => [session({ sessionId: 'dup', cwd: '/data/workspaces/task-1/repo' })] as never[],
      remove: async (sessionId) => {
        removed.push(sessionId)
      }
    })
    expect(removed).toEqual(['dup'])
    expect(result.scanned).toBe(2)
  })
})
