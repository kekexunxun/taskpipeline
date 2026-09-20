/** 按工作目录管理连接、引用计数、LRU 和写锁；数据库位置及创建/清理策略由宿主注入。 */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { CodeIndexStore } from '../db/sqlite-store.js'

export interface IndexHandle {
  dir: string
  repoId: string
  dbPath: string
  db: Database.Database
  store: CodeIndexStore
  /** 引用计数：>0 时 LRU 不淘汰。 */
  users: number
  lastUsed: number
}

export interface CodeIndexRegistryOptions {
  /** 接收规范化后的工作目录；路径策略由宿主决定。 */
  dbPathFor: (dir: string) => string
  /** 创建连接并移交给 registry 管理；宿主负责创建父目录。 */
  openDatabase: (dbPath: string) => Database.Database
  /** 可选的持久化清理能力；未提供时只关闭连接、不删除文件。 */
  deleteDatabase?: (dbPath: string) => void
  /** 常驻打开的最大库数，超出按 LRU 关闭 users=0 的句柄。默认 24。 */
  maxOpen?: number
}

/** 保持已有索引身份：sha256(工作目录绝对路径) 的前 32 位十六进制。 */
export function indexKeyFor(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 32)
}

export class CodeIndexRegistry {
  private readonly handles = new Map<string, IndexHandle>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly maxOpen: number

  constructor(private readonly opts: CodeIndexRegistryOptions) {
    this.maxOpen = opts.maxOpen ?? 24
  }

  isKnown(dir: string): boolean {
    return this.handles.has(indexKeyFor(dir))
  }

  dbPathFor(dir: string): string {
    return this.opts.dbPathFor(resolve(dir))
  }

  /** 获取句柄并持有一个引用；使用完毕须 release。 */
  acquire(dir: string): IndexHandle {
    const key = indexKeyFor(dir)
    let h = this.handles.get(key)
    if (!h) {
      h = this.open(key, dir)
      this.handles.set(key, h)
    }
    // 先持有引用，避免容量已满时将刚打开的连接淘汰。
    h.users += 1
    h.lastUsed = Date.now()
    this.evictIfNeeded()
    return h
  }

  peek(dir: string): IndexHandle | undefined {
    const h = this.handles.get(indexKeyFor(dir))
    if (h) h.lastUsed = Date.now()
    return h
  }

  acquireLongLived(dir: string): IndexHandle {
    const h = this.acquire(dir)
    h.users += 1
    return h
  }

  release(dir: string): void {
    const h = this.handles.get(indexKeyFor(dir))
    if (!h) return
    h.users = Math.max(0, h.users - 1)
    h.lastUsed = Date.now()
    this.evictIfNeeded()
  }

  releaseLongLived(dir: string): void {
    this.release(dir)
    this.release(dir)
  }

  /** 调用方须先停止使用该目录；清理文件必须由宿主显式提供能力。 */
  close(dir: string, deleteFiles = false): void {
    const key = indexKeyFor(dir)
    const h = this.handles.get(key)
    if (h) {
      try {
        h.db.close()
      } catch {
        /* 已关闭 */
      }
      this.handles.delete(key)
    }
    this.chains.delete(key)
    if (deleteFiles && this.opts.deleteDatabase) {
      this.opts.deleteDatabase(h?.dbPath ?? this.dbPathFor(dir))
    }
  }

  /** 同目录写互斥；不同目录可独立运行。 */
  async withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const key = indexKeyFor(dir)
    const prev = this.chains.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const chain = prev.then(() => gate)
    this.chains.set(key, chain)
    await prev.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
      if (this.chains.get(key) === chain) this.chains.delete(key)
    }
  }

  stats(): Array<{ dir: string; repoId: string; users: number; nodeCount: number }> {
    return [...this.handles.values()].map((h) => ({
      dir: h.dir,
      repoId: h.repoId,
      users: h.users,
      nodeCount: h.store.getStats(h.repoId).nodeCount
    }))
  }

  closeAll(): void {
    for (const h of this.handles.values()) {
      try {
        h.db.close()
      } catch {
        /* 已关闭 */
      }
    }
    this.handles.clear()
    this.chains.clear()
  }

  private open(key: string, dir: string): IndexHandle {
    const dbPath = this.dbPathFor(dir)
    const db = this.opts.openDatabase(dbPath)
    try {
      const store = new CodeIndexStore(db).init()
      return { dir: resolve(dir), repoId: key, dbPath, db, store, users: 0, lastUsed: Date.now() }
    } catch (error) {
      db.close()
      throw error
    }
  }

  private evictIfNeeded(): void {
    if (this.handles.size <= this.maxOpen) return
    const closable = [...this.handles.values()].filter((h) => h.users === 0).sort((a, b) => a.lastUsed - b.lastUsed)
    for (const h of closable) {
      if (this.handles.size <= this.maxOpen) break
      this.close(h.dir)
    }
  }
}
