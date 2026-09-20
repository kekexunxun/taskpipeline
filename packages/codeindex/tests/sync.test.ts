import { describe, it, expect } from 'vitest'
import { DebouncedSyncQueue, type SyncRunContext } from '../src/indexer/sync.js'

/** 假时钟：手动触发到期的定时器，避免测试依赖真实 setTimeout 时序。 */
function fakeTimers() {
  let seq = 0
  const tasks = new Map<number, () => void>()
  return {
    timers: {
      set: (cb: () => void, _ms: number) => {
        const id = ++seq
        tasks.set(id, cb)
        return id
      },
      clear: (handle: unknown) => {
        tasks.delete(handle as number)
      }
    },
    /** 触发所有已排队的定时器（模拟防抖窗口到点）。 */
    fire: () => {
      const pending = [...tasks.entries()]
      tasks.clear()
      for (const [, cb] of pending) cb()
    }
  }
}

describe('DebouncedSyncQueue — 增量 sync 调度', () => {
  it('按 (repoId,rootDir) 归并、防抖后成批交付', async () => {
    const ft = fakeTimers()
    const runs: SyncRunContext[] = []
    const q = new DebouncedSyncQueue({ run: async (c) => void runs.push(c), timers: ft.timers, debounceMs: 250 })

    q.enqueue('R', '/root', 'src/a.ts')
    q.enqueue('R', '/root', 'src/b.ts')
    q.enqueue('R', '/root', 'src/a.ts') // 重复路径去重
    expect(q.pending()).toBe(2)
    expect(runs.length).toBe(0) // 未 flush

    ft.fire()
    await q.flushAll()
    expect(runs.length).toBe(1)
    expect(runs[0]?.onlyPaths.slice().sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(runs[0]?.repoId).toBe('R')
    q.dispose()
  })

  it('不同仓/不同根各走各的批次', async () => {
    const ft = fakeTimers()
    const runs: SyncRunContext[] = []
    const q = new DebouncedSyncQueue({ run: async (c) => void runs.push(c), timers: ft.timers })
    q.enqueue('A', '/ra', 'x.ts')
    q.enqueue('B', '/rb', 'y.ts')
    ft.fire()
    await q.flushAll()
    expect(runs.map((r) => r.repoId).sort()).toEqual(['A', 'B'])
    q.dispose()
  })

  it('Windows 反斜杠路径归一为 POSIX', async () => {
    const ft = fakeTimers()
    const runs: SyncRunContext[] = []
    const q = new DebouncedSyncQueue({ run: async (c) => void runs.push(c), timers: ft.timers })
    q.enqueue('R', '/root', 'src\\sub\\c.ts')
    ft.fire()
    await q.flushAll()
    expect(runs[0]?.onlyPaths).toEqual(['src/sub/c.ts'])
    q.dispose()
  })

  it('flush() 立即结算并 await —— 写后即查一致性', async () => {
    let resolved = false
    const q = new DebouncedSyncQueue({
      run: async () => {
        await new Promise((r) => setTimeout(r, 5))
        resolved = true
      },
      debounceMs: 10_000 // 防抖窗口很长，只能靠 flush 主动结算
    })
    q.enqueue('R', '/root', 'src/just-wrote.ts')
    await q.flush('R', '/root')
    expect(resolved).toBe(true)
    expect(q.pending()).toBe(0)
    q.dispose()
  })

  it('同库串行：上一轮未完时新事件排队到下一轮', async () => {
    const ft = fakeTimers()
    const resolvers: Array<() => void> = []
    const runs: SyncRunContext[] = []
    let blockFirst = true
    const q = new DebouncedSyncQueue({
      run: async (c) => {
        runs.push(c)
        if (blockFirst) {
          blockFirst = false
          await new Promise<void>((r) => resolvers.push(r)) // 只卡住第一轮
        }
      },
      timers: ft.timers
    })
    q.enqueue('R', '/root', 'a.ts')
    ft.fire() // 触发第一轮
    await Promise.resolve() // 让第一轮 run 起步并注册 resolver
    expect(resolvers.length).toBe(1)
    q.enqueue('R', '/root', 'b.ts')
    ft.fire() // 触发第二轮（应排在第一轮之后）
    resolvers[0]?.() // 放开第一轮
    await q.flushAll()
    expect(runs.length).toBe(2)
    expect(runs[0]?.onlyPaths).toEqual(['a.ts'])
    expect(runs[1]?.onlyPaths).toEqual(['b.ts'])
    q.dispose()
  })

  it('run 抛错被吞、不打断后续批次', async () => {
    const ft = fakeTimers()
    let n = 0
    const q = new DebouncedSyncQueue({
      run: async () => {
        n++
        if (n === 1) throw new Error('boom')
      },
      timers: ft.timers
    })
    q.enqueue('R', '/root', 'a.ts')
    ft.fire()
    await q.flushAll()
    q.enqueue('R', '/root', 'b.ts')
    ft.fire()
    await q.flushAll()
    expect(n).toBe(2)
    q.dispose()
  })

  it('dispose 后 enqueue 不再受理', async () => {
    const ft = fakeTimers()
    const runs: SyncRunContext[] = []
    const q = new DebouncedSyncQueue({ run: async (c) => void runs.push(c), timers: ft.timers })
    q.dispose()
    q.enqueue('R', '/root', 'a.ts')
    ft.fire()
    await q.flushAll()
    expect(runs.length).toBe(0)
  })
})
