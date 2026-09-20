import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARD_SKIP_DIRS } from '../src/index.js'
import { NodeIndexWatcher } from '../src/runtime/node-watcher.js'

vi.mock('chokidar', () => ({ watch: vi.fn() }))

let events: EventEmitter
let close: ReturnType<typeof vi.fn<() => Promise<void>>>
beforeEach(() => {
  vi.mocked(watch).mockReset()
  events = new EventEmitter()
  close = vi.fn(() => Promise.resolve())
  vi.mocked(watch).mockReturnValue(Object.assign(events, { close }) as unknown as FSWatcher)
})

describe('NodeIndexWatcher', () => {
  it('默认等待写入稳定，启动幂等，转换相对路径和事件类型', async () => {
    const onFileChange = vi.fn()
    const rootDir = resolve('/repos/project')
    const watcher = new NodeIndexWatcher({ rootDir, onFileChange })
    watcher.start()
    watcher.start()
    expect(watch).toHaveBeenCalledTimes(1)
    expect(watch).toHaveBeenCalledWith(
      rootDir,
      expect.objectContaining({
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
      })
    )
    const path = join(rootDir, 'src', 'main.ts')
    events.emit('add', path)
    events.emit('change', path)
    events.emit('unlink', path)
    expect(onFileChange.mock.calls).toEqual([
      ['src/main.ts', 'upsert'],
      ['src/main.ts', 'upsert'],
      ['src/main.ts', 'unlink']
    ])
    await watcher.stop()
  })

  it('完整复用硬跳目录集合，不受工作目录祖先名称影响', async () => {
    const rootDir = resolve('/cache/node_modules/project')
    const watcher = new NodeIndexWatcher({ rootDir, onFileChange: vi.fn(), stabilityThreshold: 25 })
    watcher.start()
    const options = vi.mocked(watch).mock.calls[0]![1]!
    const ignored = options.ignored as (path: string) => boolean
    expect(ignored(rootDir)).toBe(false)
    expect(ignored(join(rootDir, 'src', 'main.ts'))).toBe(false)
    for (const dir of DEFAULT_HARD_SKIP_DIRS) {
      expect(ignored(join(rootDir, dir, 'main.ts'))).toBe(true)
    }
    expect(options.awaitWriteFinish).toEqual({ stabilityThreshold: 25, pollInterval: 100 })
    await watcher.stop()
  })

  it('stop 等待底层释放且可重复调用，完成后允许重启', async () => {
    let unblock!: () => void
    close.mockImplementation(() => new Promise<void>((done) => (unblock = done)))
    const watcher = new NodeIndexWatcher({ rootDir: '/repos/a', onFileChange: vi.fn() })
    watcher.start()
    const stopped = watcher.stop()
    expect(watcher.stop()).toBe(stopped)
    watcher.start()
    expect(watch).toHaveBeenCalledTimes(1)
    unblock()
    await stopped
    expect(close).toHaveBeenCalledTimes(1)
    close.mockResolvedValue(undefined)
    watcher.start()
    expect(watch).toHaveBeenCalledTimes(2)
    await watcher.stop()
  })

  it('错误经注入回调上报', async () => {
    const onError = vi.fn()
    const watcher = new NodeIndexWatcher({ rootDir: '/repos/a', onFileChange: vi.fn(), onError })
    watcher.start()
    const error = new Error('watch failed')
    events.emit('error', error)
    expect(onError).toHaveBeenCalledWith(error)
    await watcher.stop()
  })
})
