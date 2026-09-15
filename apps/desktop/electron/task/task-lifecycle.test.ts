import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@task-pipeline/core'
import type * as QoderSweepModule from '../pi-extension/qoder/session-sweep.js'
import type * as TaskIntakeModule from '../agents/task-intake/task-intake.js'
import type * as PiSessionModule from './pi-session.js'
import { initTaskLifecycle, purgeTaskSessionsFor, sendTaskIntake } from './task-lifecycle.js'

/**
 * `sendTaskIntake` 的入口判据（§7 用例 9）。
 *
 * 只把 `runTaskIntakeTurn` 换成假实现：这条测试要验的是「谁能开口、说完之后状态变不变」，
 * 不是 SDK 那一轮跑成什么样。其余导出保持真实，免得顺手把字段清洗也 mock 掉了。
 */
const intake = vi.hoisted(() => ({ turn: vi.fn(async () => undefined) }))
vi.mock('../agents/task-intake/task-intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TaskIntakeModule>()
  return { ...actual, runTaskIntakeTurn: intake.turn }
})

const draftTask: Task = {
  id: 'task-1',
  source: 'local',
  title: '支持批量导出',
  description: '',
  keywords: [],
  acceptanceCriteria: [],
  state: 'draft',
  reviewStatus: 'pending',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z'
}

/**
 * 澄清这条路只碰四个依赖，其余一律不给：漏接线时这里会直接 `undefined is not a function`，
 * 比铺一个 28 字段的完整假对象更容易看出是谁在偷偷扩面。
 */
function wireDeps(task: Task, token: string | undefined) {
  const store = {
    getTask: vi.fn(() => task),
    listTaskRepositories: vi.fn(() => []),
    listRepositoryProfiles: vi.fn(() => []),
    addEvent: vi.fn()
  }
  initTaskLifecycle({
    store,
    protectedValue: (key: string) => (key === 'qoderToken' ? token : undefined),
    agentService: { resolveModelForTask: vi.fn(() => 'qoder:auto') },
    emitTaskChanged: vi.fn()
  } as unknown as Parameters<typeof initTaskLifecycle>[0])
  return store
}

describe('sendTaskIntake', () => {
  it('keeps the task in draft and logs the user turn before the agent runs', async () => {
    intake.turn.mockClear()
    const store = wireDeps(draftTask, 'qoder-token')

    await expect(sendTaskIntake('task-1', '帮我补一下验收标准')).resolves.toBeUndefined()

    // 澄清不许动状态：推一把就是替用户启动了整条链路。
    expect(store.addEvent).toHaveBeenCalledWith(expect.objectContaining({ title: '你' }))
    expect(store.getTask).toHaveBeenCalledWith('task-1')
    expect(intake.turn).toHaveBeenCalledTimes(1)
    expect(store.addEvent.mock.invocationCallOrder[0]!).toBeLessThan(intake.turn.mock.invocationCallOrder[0]!)
  })

  it('refuses a task that has already left draft, without writing anything', async () => {
    intake.turn.mockClear()
    const store = wireDeps({ ...draftTask, state: 'implementing' }, 'qoder-token')

    await expect(sendTaskIntake('task-1', '帮我补一下')).rejects.toThrow('只有待处理的任务')
    expect(store.addEvent).not.toHaveBeenCalled()
    expect(intake.turn).not.toHaveBeenCalled()
  })

  it('asks for a Qoder token instead of dropping the message into the events table', async () => {
    intake.turn.mockClear()
    const store = wireDeps(draftTask, undefined)

    await expect(sendTaskIntake('task-1', '帮我补一下')).rejects.toThrow('Qoder Token')
    // 没 token 就一条事件都别落：否则会出现「消息看得见、永远没人回」。
    expect(store.addEvent).not.toHaveBeenCalled()
    expect(intake.turn).not.toHaveBeenCalled()
  })
})

/**
 * 任务级会话回收的接线（§4.4）：两条运行时的入口都得到调、失败都合流。
 *
 * 三个回收入口全换掉：真的会去列 `~/.qoder`、扫 `pi-sessions` 目录、删盘上文件，不该在单测里发生。
 */
const sweep = vi.hoisted(() => ({
  qoder: vi.fn(async (_input: { dirs: string[]; workspacesRoots: string[] }) => ({
    scanned: 0,
    deleted: [] as string[],
    skipped: 0,
    failed: [] as Array<{ sessionId: string; error: string }>
  })),
  pi: vi.fn((_deps: { piSessionsDir: string; workspacesRoots: string[]; taskId: string }) => ({
    scanned: 0,
    deleted: [] as string[],
    skipped: 0,
    failed: [] as Array<{ file: string; error: string }>
  })),
  deleteByPointer: vi.fn()
}))
vi.mock('../pi-extension/qoder/session-sweep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QoderSweepModule>()
  return { ...actual, purgeTaskSessions: sweep.qoder }
})
vi.mock('./pi-session-sweep.js', () => ({ purgePiTaskSessionFiles: sweep.pi }))
vi.mock('./pi-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PiSessionModule>()
  return { ...actual, deletePiTaskSessionFile: sweep.deleteByPointer }
})

const DATA_DIR = '/data'

function wireSweepDeps(repositories: Array<{ worktreePath?: string; localPath?: string }>) {
  const addTaskEvent = vi.fn()
  initTaskLifecycle({
    dataDir: DATA_DIR,
    addTaskEvent,
    store: { listTaskRepositories: vi.fn(() => repositories) }
  } as unknown as Parameters<typeof initTaskLifecycle>[0])
  return addTaskEvent
}

describe('purgeTaskSessionsFor', () => {
  it('Pi 与 Qoder 两侧都按当前 dataDir 推目录，任务级 purge 拿到 taskId', async () => {
    sweep.qoder.mockClear()
    sweep.pi.mockClear()
    sweep.deleteByPointer.mockClear()
    wireSweepDeps([])

    await purgeTaskSessionsFor('task-1')

    expect(sweep.pi).toHaveBeenCalledWith(
      expect.objectContaining({
        piSessionsDir: `${DATA_DIR}/pi-sessions`,
        workspacesRoots: [`${DATA_DIR}/workspaces`, `${DATA_DIR}/worktrees`],
        taskId: 'task-1'
      })
    )
    expect(sweep.qoder.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        dirs: [`${DATA_DIR}/workspaces/task-1`, `${DATA_DIR}/worktrees/task-1`],
        workspacesRoots: [`${DATA_DIR}/workspaces`, `${DATA_DIR}/worktrees`]
      })
    )
    // 先按 header 归因删（能盖到 fork 前驱），再按 DB 指针补删；反过来会漏下前驱文件。
    expect(sweep.pi.mock.invocationCallOrder[0]!).toBeLessThan(sweep.deleteByPointer.mock.invocationCallOrder[0]!)
  })

  it('用户的仓库目录不进去：只带 worktree / 工作区路径', async () => {
    sweep.qoder.mockClear()
    sweep.pi.mockClear()
    wireSweepDeps([{ worktreePath: `${DATA_DIR}/workspaces/task-1/repo`, localPath: '/Users/robin/my-repo' }])

    await purgeTaskSessionsFor('task-1')

    const dirs = sweep.qoder.mock.calls[0]![0].dirs as string[]
    expect(dirs).toContain(`${DATA_DIR}/workspaces/task-1/repo`)
    expect(dirs).not.toContain('/Users/robin/my-repo')
  })

  it('两边的删除失败合成一条事件：回收不干净不能静默', async () => {
    sweep.qoder.mockClear()
    sweep.pi.mockClear()
    sweep.qoder.mockResolvedValueOnce({
      scanned: 1,
      deleted: [],
      skipped: 0,
      failed: [{ sessionId: 'sess-1', error: 'EPERM' }]
    })
    sweep.pi.mockReturnValueOnce({
      scanned: 1,
      deleted: [],
      skipped: 0,
      failed: [{ file: '/data/pi-sessions/a.jsonl', error: 'EBUSY' }]
    })
    const addTaskEvent = wireSweepDeps([])

    await purgeTaskSessionsFor('task-1')

    expect(addTaskEvent).toHaveBeenCalledTimes(1)
    const detail = addTaskEvent.mock.calls[0]![0].detail as string
    expect(detail).toContain('sess-1')
    expect(detail).toContain('a.jsonl')
  })

  it('全部回收成功时不落事件', async () => {
    const addTaskEvent = wireSweepDeps([])

    await purgeTaskSessionsFor('task-1')

    expect(addTaskEvent).not.toHaveBeenCalled()
  })
})
