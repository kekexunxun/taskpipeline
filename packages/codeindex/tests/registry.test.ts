import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeIndexRegistry, indexKeyFor, type CodeIndexRegistryOptions } from '../src/index.js'

// 导入核心公共入口不能隐式加载可选的 Node.js watcher。
vi.mock('chokidar', () => {
  throw new Error('核心入口不应加载 chokidar')
})

const registries: CodeIndexRegistry[] = []
function makeRegistry(options: Partial<CodeIndexRegistryOptions> = {}) {
  const registry = new CodeIndexRegistry({
    dbPathFor: (dir) => join('/app-data', indexKeyFor(dir), 'graph.db'),
    openDatabase: () => new Database(':memory:'),
    ...options
  })
  registries.push(registry)
  return registry
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.closeAll()
})

describe('CodeIndexRegistry', () => {
  it('保留目录哈希算法，同一规范路径复用连接，worktree 独立', () => {
    const registry = makeRegistry()
    const dir = resolve('/repos/project')
    expect(indexKeyFor(dir)).toBe(createHash('sha256').update(dir).digest('hex').slice(0, 32))
    const first = registry.acquire(dir)
    expect(registry.acquire(join(dir, 'src', '..'))).toBe(first)
    expect(first.users).toBe(2)
    const worktree = registry.acquire('/repos/project-task')
    expect(worktree.repoId).not.toBe(first.repoId)
    expect(worktree.db).not.toBe(first.db)
  })

  it('注入路径和连接工厂，并初始化 schema', () => {
    const dbPathFor = vi.fn(() => ':memory:')
    const openDatabase = vi.fn((path: string) => new Database(path))
    const registry = makeRegistry({ dbPathFor, openDatabase })
    const handle = registry.acquire('./test-repo')
    expect(dbPathFor).toHaveBeenCalledWith(resolve('./test-repo'))
    expect(openDatabase).toHaveBeenCalledWith(':memory:')
    expect(handle.store.getStats().nodeCount).toBe(0)
    expect(registry.stats()[0]?.users).toBe(1)
  })

  it('LRU 仅淘汰无引用句柄，容量满时不关闭刚获取的连接', () => {
    const registry = makeRegistry({ maxOpen: 1 })
    const first = registry.acquireLongLived('/repos/first')
    const second = registry.acquire('/repos/second')
    expect(first.db.open).toBe(true)
    expect(second.db.open).toBe(true)
    registry.release('/repos/second')
    expect(second.db.open).toBe(false)
    expect(first.db.open).toBe(true)
    registry.releaseLongLived('/repos/first')
    const third = registry.acquire('/repos/third')
    expect(first.db.open).toBe(false)
    expect(third.db.open).toBe(true)
  })

  it('只有显式请求清理才调用宿主能力，关闭连接不等于删除文件', () => {
    const deleteDatabase = vi.fn()
    const registry = makeRegistry({ deleteDatabase })
    const handle = registry.acquire('/repos/project')
    registry.close(handle.dir)
    expect(handle.db.open).toBe(false)
    expect(deleteDatabase).not.toHaveBeenCalled()
    registry.close(handle.dir, true)
    expect(deleteDatabase).toHaveBeenCalledWith(handle.dbPath)
    expect(() => makeRegistry().close('/repos/unknown', true)).not.toThrow()
  })

  it('初始化失败时关闭已创建的连接', () => {
    const db = new Database(':memory:')
    db.pragma('query_only = ON')
    const registry = makeRegistry({ openDatabase: () => db })
    expect(() => registry.acquire('/repos/broken')).toThrow()
    expect(db.open).toBe(false)
    expect(registry.isKnown('/repos/broken')).toBe(false)
  })

  it('同目录写锁串行，跨目录不阻塞，失败后仍可继续', async () => {
    const registry = makeRegistry()
    const events: string[] = []
    let unblock!: () => void
    const gate = new Promise<void>((done) => (unblock = done))
    const first = registry.withLock('/repos/a', async () => {
      events.push('a-start')
      await gate
      events.push('a-end')
      throw new Error('expected')
    })
    const rejection = expect(first).rejects.toThrow('expected')
    const second = registry.withLock('/repos/a', async () => {
      events.push('a-next')
    })
    await registry.withLock('/repos/b', async () => {
      events.push('b')
    })
    expect(events).toEqual(['a-start', 'b'])
    unblock()
    await Promise.all([rejection, second])
    expect(events).toEqual(['a-start', 'b', 'a-end', 'a-next'])
  })
})
