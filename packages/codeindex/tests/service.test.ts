import { homedir } from 'node:os'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CodeIndexRegistry,
  CodeIndexService,
  type CodeIndexServiceOptions,
  type IndexWatcherOptions,
  type ParserBackend
} from '../src/index.js'
import { makeBackend, MemFileSystem } from './test-utils.js'

let backend: ParserBackend
const services: CodeIndexService[] = []
beforeAll(async () => {
  backend = await makeBackend()
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown()
})
afterAll(() => backend.dispose?.())

function setup(files: Record<string, string>, options: Partial<CodeIndexServiceOptions> = {}) {
  const deleteDatabase = vi.fn()
  const registry = new CodeIndexRegistry({
    dbPathFor: (dir) => `memory:${dir}`,
    openDatabase: () => new Database(':memory:'),
    deleteDatabase
  })
  const service = new CodeIndexService({ registry, backend, fs: new MemFileSystem(files), ...options })
  services.push(service)
  return { registry, service, deleteDatabase }
}

async function ready(service: CodeIndexService, dirs: string[]) {
  for (const dir of dirs) service.ensureIndexed(dir)
  await vi.waitFor(() => expect(service.status(dirs).every((status) => status.ready)).toBe(true))
}

describe('CodeIndexService（无 Electron）', () => {
  it('无 watcher 也能完成首扫与写后即查，文件读写只经注入接口', async () => {
    const files = { '/repos/a/main.ts': 'export function original() {}' }
    const { service } = setup(files)
    await ready(service, ['/repos/a'])
    expect((await service.search('original', [{ dir: '/repos/a' }])).text).toContain('a/main.ts:1')
    files['/repos/a/main.ts'] = 'export function newlyWrittenFunction() {}'
    await service.notifyWrite('/repos/a', 'main.ts')
    expect((await service.search('newlyWrittenFunction', [{ dir: '/repos/a' }])).text).toContain('[function]')
    expect((await service.search('original', [{ dir: '/repos/a' }])).text).toContain('未检索到')
  })

  it('跨仓搜索保持仓名与范围隔离，精确匹配优先', async () => {
    const { service } = setup({
      '/repos/a/main.ts': 'export function NeedleExtended() {}',
      '/repos/b/main.ts': 'export function Needle() {}'
    })
    const roots = [
      { dir: '/repos/a', name: 'First' },
      { dir: '/repos/b', name: 'Second' }
    ]
    for (const root of roots) service.ensureIndexed(root.dir, root.name)
    await ready(
      service,
      roots.map((root) => root.dir)
    )
    const result = await service.search('Needle', roots)
    expect(result.indexing).toBe(false)
    expect(result.text.indexOf('Second/main.ts')).toBeLessThan(result.text.indexOf('First/main.ts'))
    const onlyA = await service.search('Needle', [roots[0]!])
    expect(onlyA.text).toContain('First/main.ts')
    expect(onlyA.text).not.toContain('Second/')
  })

  it('同一目录只装配一次 watcher，搜索会结算新增与删除事件', async () => {
    const files: Record<string, string> = { '/repos/a/main.ts': 'export function original() {}' }
    let watchOptions!: IndexWatcherOptions
    const watcher = { start: vi.fn(), stop: vi.fn() }
    const createWatcher = vi.fn((options: IndexWatcherOptions) => {
      watchOptions = options
      return watcher
    })
    const { service } = setup(files, { createWatcher })
    await ready(service, ['/repos/a'])
    service.ensureIndexed('/repos/a/./')
    expect(createWatcher).toHaveBeenCalledTimes(1)
    expect(watchOptions.rootDir).toBe(resolve('/repos/a'))
    expect(watcher.start).toHaveBeenCalledTimes(1)
    files['/repos/a/added.ts'] = 'export function addedByWatcher() {}'
    watchOptions.onFileChange('added.ts', 'upsert')
    expect((await service.search('addedByWatcher', [{ dir: '/repos/a' }])).text).toContain('added.ts:1')
    delete files['/repos/a/added.ts']
    watchOptions.onFileChange('added.ts', 'unlink')
    expect((await service.search('addedByWatcher', [{ dir: '/repos/a' }])).text).toContain('未检索到')
    await service.disposeWorkspace('/repos/a')
    expect(watcher.stop).toHaveBeenCalledTimes(1)
  })

  it('首扫未完成时不阻塞查询，shutdown 等待首扫后再关库', async () => {
    let unblock!: () => void
    const gate = new Promise<void>((done) => (unblock = done))
    const delayed: ParserBackend = {
      ensureLanguage: async (language) => {
        await gate
        return backend.ensureLanguage(language)
      },
      parse: (content, language) => backend.parse(content, language)
    }
    const { service, registry } = setup({ '/repos/a/main.ts': 'export function hello() {}' }, { backend: delayed })
    const first = await service.search('hello', [{ dir: '/repos/a' }])
    expect(first.indexing).toBe(true)
    const db = registry.peek('/repos/a')!.db
    const shutdown = service.shutdown()
    try {
      await Promise.resolve()
      expect(db.open).toBe(true)
      expect(service.ensureIndexed('/repos/b')).toBeUndefined()
    } finally {
      unblock()
      await shutdown
    }
    expect(db.open).toBe(false)
  })

  it('释放目录等待 watcher 关闭和队列结算，再调用宿主清理能力', async () => {
    let watchOptions!: IndexWatcherOptions
    let stop!: () => void
    const stopped = new Promise<void>((done) => (stop = done))
    const files = { '/repos/a/main.ts': 'export function original() {}' }
    const { service, registry, deleteDatabase } = setup(files, {
      createWatcher: (options) => {
        watchOptions = options
        return { start: vi.fn(), stop: () => stopped }
      }
    })
    await ready(service, ['/repos/a'])
    files['/repos/a/main.ts'] = 'export function changedBeforeClosing() {}'
    watchOptions.onFileChange('main.ts', 'upsert')
    const handle = registry.peek('/repos/a')!
    const replace = vi.spyOn(handle.store, 'replaceFileSymbols')
    const closing = service.disposeWorkspace('/repos/a', true)
    try {
      await Promise.resolve()
      expect(handle.db.open).toBe(true)
      expect(deleteDatabase).not.toHaveBeenCalled()
      expect(service.ensureIndexed('/repos/a')).toBeUndefined()
    } finally {
      stop()
      await closing
    }
    expect(replace).toHaveBeenCalled()
    expect(handle.db.open).toBe(false)
    expect(deleteDatabase).toHaveBeenCalledWith(handle.dbPath)
    expect(registry.isKnown('/repos/a')).toBe(false)
  })

  it('监听启动失败可降级，错误通过宿主回调上报', async () => {
    const error = new Error('watch unavailable')
    const onError = vi.fn()
    const { service } = setup(
      { '/repos/a/main.ts': 'export function hello() {}' },
      {
        createWatcher: () => {
          throw error
        },
        onError
      }
    )
    await ready(service, ['/repos/a'])
    expect(onError).toHaveBeenCalledWith(error, { phase: 'sync', rootDir: resolve('/repos/a') })
    expect((await service.search('hello', [{ dir: '/repos/a' }])).text).toContain('[function]')
  })

  it('一个 watcher 关闭失败时，仍等待其他目录释放后才结束 shutdown', async () => {
    let unblock!: () => void
    const gate = new Promise<void>((done) => (unblock = done))
    const error = new Error('stop failed')
    const { service, registry } = setup(
      {
        '/repos/a/main.ts': 'export function a() {}',
        '/repos/b/main.ts': 'export function b() {}'
      },
      {
        createWatcher: ({ rootDir }) => ({
          start: vi.fn(),
          stop: () => (rootDir === resolve('/repos/a') ? Promise.reject(error) : gate)
        })
      }
    )
    await ready(service, ['/repos/a', '/repos/b'])
    const first = registry.peek('/repos/a')!.db
    const second = registry.peek('/repos/b')!.db
    let settled = false
    const shutdown = service.shutdown().finally(() => {
      settled = true
    })
    const rejected = expect(shutdown).rejects.toBe(error)
    try {
      await vi.waitFor(() => expect(first.open).toBe(false))
      expect(second.open).toBe(true)
      expect(settled).toBe(false)
    } finally {
      unblock()
      await rejected
    }
    expect(second.open).toBe(false)
  })

  it('空查询、无目录与危险根不会创建连接', async () => {
    const { service, registry } = setup({})
    expect((await service.search('', [{ dir: '/repos/a' }])).text).toContain('查询为空')
    expect((await service.search('hello', [])).text).toContain('没有可检索')
    expect(service.ensureIndexed(homedir())).toBeUndefined()
    expect(registry.stats()).toEqual([])
  })
})
