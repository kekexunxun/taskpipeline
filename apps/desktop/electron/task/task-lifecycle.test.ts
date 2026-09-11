import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@task-pipeline/core'
import type * as TaskIntakeModule from '../agents/task-intake/task-intake.js'
import { initTaskLifecycle, sendTaskIntake } from './task-lifecycle.js'

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
