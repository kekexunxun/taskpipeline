/** 可复用的多目录索引服务；不依赖 Electron，也不自行选择数据库或监听实现。 */
import { basename, dirname, join } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { CodeIndexStore } from '../db/sqlite-store.js'
import { CodeIndexer } from '../indexer/index.js'
import { DebouncedSyncQueue, type SyncRunContext } from '../indexer/sync.js'
import { unsafeIndexRootReason } from '../indexer/discover.js'
import { formatBoundedSearch } from '../search/bounded-formatter.js'
import type { FileSystem, IndexSummary, IndexWatcher, IndexWatcherFactory, ParserBackend, SearchHit } from '../types.js'
import { type CodeIndexRegistry, indexKeyFor } from './registry.js'

export interface IndexRoot {
  dir: string
  /** 展示用仓名；缺省取目录名。 */
  name?: string
}

export interface CodeSearchResult {
  text: string
  /** 首扫进行中，调用方可稍后重试或使用其他检索方式。 */
  indexing: boolean
}

export interface CodeIndexServiceOptions {
  /** 专用于此服务的 registry，shutdown 时关闭其所有连接。 */
  registry: CodeIndexRegistry
  /** 解析后端由宿主持有并负责最终释放，可在多个服务间共享。 */
  backend: ParserBackend
  fs: FileSystem
  /** 不提供则不监听，适用于一次性索引、CLI 或自定义变更通知。 */
  createWatcher?: IndexWatcherFactory
  onError?: (error: unknown, context: { phase: 'index' | 'sync'; rootDir: string }) => void
  /**
   * 索引存储根目录（如 dataDir/codeindex）；提供后启用 listIndexes 磁盘发现。
   * 不提供时 listIndexes 只返回内存中已加载的索引。
   */
  indexRootDir?: string
  /** 打开临时数据库连接用；listIndexes 发现离线索引时需要。 */
  openDatabase?: (dbPath: string) => Database.Database
}

interface DirState {
  dir: string
  repoId: string
  store: CodeIndexStore
  indexer: CodeIndexer
  watcher?: IndexWatcher
  queue: DebouncedSyncQueue
  displayName: string
  ready: boolean
  initialScan?: Promise<void>
  closing?: Promise<void>
}

const NO_ROOTS_TEXT = '（当前没有可检索的已索引目录）'
const INDEXING_TEXT = '（该仓库代码索引正在建立中，请稍后重试，或暂时用 grep 定位）'
const NO_HIT_TEXT = '未检索到匹配的符号。请用准确的符号名或英文关键词重试（不支持中文描述）。'

export class CodeIndexService {
  private readonly registry: CodeIndexRegistry
  private readonly states = new Map<string, DirState>()
  private readonly perRepoFetchLimit = 30
  private stopped = false

  constructor(private readonly opts: CodeIndexServiceOptions) {
    this.registry = opts.registry
  }

  /** 懒建目录索引，启动可选 watcher 并异步首扫；不阻塞查询。 */
  ensureIndexed(dir: string, name?: string): DirState | undefined {
    if (this.stopped || unsafeIndexRootReason(dir)) return undefined
    const key = indexKeyFor(dir)
    const existing = this.states.get(key)
    if (existing) return existing.closing ? undefined : existing

    const handle = this.registry.acquireLongLived(dir)
    const state: DirState = {
      dir: handle.dir,
      repoId: handle.repoId,
      store: handle.store,
      indexer: new CodeIndexer({ backend: this.opts.backend, store: handle.store, fs: this.opts.fs }),
      displayName: name ?? basename(handle.dir),
      ready: false,
      queue: new DebouncedSyncQueue({
        run: (ctx) => this.runSync(state, ctx),
        debounceMs: 250,
        onError: (error, ctx) => this.opts.onError?.(error, { phase: 'sync', rootDir: ctx.rootDir })
      })
    }
    this.states.set(key, state)
    try {
      state.watcher = this.opts.createWatcher?.({
        rootDir: state.dir,
        onFileChange: (relPath) => state.queue.enqueue(state.repoId, state.dir, relPath),
        onError: (error) => this.opts.onError?.(error, { phase: 'sync', rootDir: state.dir })
      })
      state.watcher?.start()
    } catch (error) {
      // 监听失败仍保留首扫与显式写入通知能力。
      this.opts.onError?.(error, { phase: 'sync', rootDir: state.dir })
    }
    state.initialScan = this.registry
      .withLock(state.dir, async () => {
        await state.indexer.indexRepo({ repoId: state.repoId, rootDir: state.dir })
      })
      .catch((error: unknown) => this.opts.onError?.(error, { phase: 'index', rootDir: state.dir }))
      .finally(() => {
        state.ready = true
      })
    return state
  }

  /** 跨仓检索，保留已有排序和有界输出策略。 */
  async search(query: string, roots: IndexRoot[], maxNodes = 20): Promise<CodeSearchResult> {
    const q = (query ?? '').trim()
    if (!q) return { text: '查询为空。请传入要检索的符号名或英文关键词。', indexing: false }
    if (!roots.length) return { text: NO_ROOTS_TEXT, indexing: false }

    const repoIds: string[] = []
    const rootDirs: Record<string, string> = {}
    const repoNames: Record<string, string> = {}
    let indexing = false
    for (const r of roots) {
      const state = this.ensureIndexed(r.dir, r.name)
      if (!state) continue
      if (!state.ready) indexing = true
      await state.queue.flush(state.repoId, state.dir).catch(() => undefined)
      if (state.closing) continue
      repoIds.push(state.repoId)
      rootDirs[state.repoId] = state.dir
      repoNames[state.repoId] = state.displayName
    }
    if (!repoIds.length) return { text: INDEXING_TEXT, indexing: true }

    const merged: SearchHit[] = []
    for (const repoId of repoIds) {
      const state = this.states.get(indexKeyFor(rootDirs[repoId] as string))
      if (!state || state.closing) continue
      merged.push(...state.store.searchSymbols(q, { repoIds: [repoId], limit: this.perRepoFetchLimit }))
    }
    if (!merged.length) return { text: indexing ? INDEXING_TEXT : NO_HIT_TEXT, indexing }

    // 不同库的 bm25 不可直接比较，沿用精确名、前缀、包含关系的排序。
    const ql = q.toLowerCase()
    merged.sort((a, b) => rank(b, ql) - rank(a, ql))
    const bounded = formatBoundedSearch(merged.slice(0, Math.max(maxNodes, 1) * 3), {
      fs: this.opts.fs,
      rootDirs,
      repoNames
    })
    return { text: bounded.text || NO_HIT_TEXT, indexing }
  }

  /** 显式写后同步；不启用 watcher 时也可用。 */
  async notifyWrite(dir: string, relPath: string): Promise<void> {
    const state = this.ensureIndexed(dir)
    if (!state) return
    state.queue.enqueue(state.repoId, state.dir, relPath)
    await state.queue.flush(state.repoId, state.dir)
  }

  /** 停止监听并等待在途索引后关库；是否清理文件由宿主策略决定。 */
  async disposeWorkspace(dir: string, deleteFiles = false): Promise<void> {
    const key = indexKeyFor(dir)
    const state = this.states.get(key)
    if (!state) {
      this.registry.close(dir, deleteFiles)
      return
    }
    if (state.closing) return state.closing
    state.closing = Promise.resolve().then(async () => {
      try {
        try {
          await state.watcher?.stop()
        } finally {
          // 即使监听器关闭失败，也必须等在途写入结束后再关库。
          await state.initialScan
          await state.queue.flushAll()
        }
      } finally {
        state.queue.dispose()
        this.states.delete(key)
        this.registry.releaseLongLived(dir)
        this.registry.close(dir, deleteFiles)
      }
    })
    return state.closing
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    const results = await Promise.allSettled([...this.states.values()].map((state) => this.disposeWorkspace(state.dir)))
    this.registry.closeAll()
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  status(dirs: string[]): Array<{ dir: string; ready: boolean; nodes: number }> {
    return dirs.map((dir) => {
      const state = this.states.get(indexKeyFor(dir))
      return { dir, ready: state?.ready ?? false, nodes: state ? state.store.getStats(state.repoId).nodeCount : 0 }
    })
  }

  // ── 索引管理 ────────────────────────────────────────────────────────────

  /**
   * 扫描 indexRootDir 下所有索引（含未在内存中的），返回摘要列表。
   * 未提供 indexRootDir 时只返回内存中已加载的索引。
   */
  listIndexes(): IndexSummary[] {
    const results: IndexSummary[] = []
    const seen = new Set<string>()

    // 1) 内存中已加载的索引
    for (const state of this.states.values()) {
      if (state.closing) continue
      const stats = state.store.getStats(state.repoId)
      const dbPath = this.registry.dbPathFor(state.dir)
      let dbSizeBytes = 0
      try {
        dbSizeBytes = statSync(dbPath).size
      } catch {
        /* ignore */
      }
      results.push({
        dir: state.dir,
        key: state.repoId,
        dbPath,
        ready: state.ready,
        indexing: !state.ready,
        nodeCount: stats.nodeCount,
        fileCount: stats.fileCount,
        edgeCount: stats.edgeCount,
        dbSizeBytes,
        createdAt: this.readMetaCreatedAt(dbPath),
        languages: Object.keys(stats.filesByLanguage)
      })
      seen.add(state.repoId)
    }

    // 2) 磁盘上存在但不在内存中的索引
    const rootDir = this.opts.indexRootDir
    if (rootDir && existsSync(rootDir)) {
      for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const key = entry.name
        if (seen.has(key)) continue
        const entryDir = join(rootDir, key)
        const dbPath = join(entryDir, 'graph.db')
        if (!existsSync(dbPath)) continue
        const meta = this.readMeta(entryDir)
        if (!meta) continue // 无 meta.json 跳过
        let dbSizeBytes = 0
        try {
          dbSizeBytes = statSync(dbPath).size
        } catch {
          /* ignore */
        }
        // 临时打开 DB 取 stats
        let nodeCount = 0,
          fileCount = 0,
          edgeCount = 0
        let languages: string[] = []
        const openDb = this.opts.openDatabase
        if (openDb) {
          let tmpDb: Database.Database | undefined
          try {
            tmpDb = openDb(dbPath)
            const tmpStore = new CodeIndexStore(tmpDb)
            const s = tmpStore.getStats(key)
            nodeCount = s.nodeCount
            fileCount = s.fileCount
            edgeCount = s.edgeCount
            languages = Object.keys(s.filesByLanguage)
          } catch {
            /* 打开失败跳过 */
          } finally {
            try {
              tmpDb?.close()
            } catch {
              /* ignore */
            }
          }
        }
        results.push({
          dir: meta.dir,
          key,
          dbPath,
          ready: false,
          indexing: false,
          nodeCount,
          fileCount,
          edgeCount,
          dbSizeBytes,
          createdAt: meta.createdAt,
          languages
        })
        seen.add(key)
      }
    }

    return results
  }

  /** 删除指定目录的索引（复用 disposeWorkspace 的安全链路）。 */
  async deleteIndex(dir: string): Promise<void> {
    await this.disposeWorkspace(dir, true)
  }

  /** 重建指定目录的索引：先删库再懒建。首扫异步执行，调用方可刷新列表观察进度。 */
  async rebuildIndex(dir: string): Promise<void> {
    await this.disposeWorkspace(dir, true)
    this.ensureIndexed(dir)
  }

  private readMetaCreatedAt(dbPath: string): string {
    try {
      const meta = JSON.parse(readFileSync(join(dirname(dbPath), 'meta.json'), 'utf-8'))
      return typeof meta.createdAt === 'string' ? meta.createdAt : ''
    } catch {
      return ''
    }
  }

  private readMeta(indexDir: string): { dir: string; createdAt: string } | undefined {
    try {
      const meta = JSON.parse(readFileSync(join(indexDir, 'meta.json'), 'utf-8'))
      if (typeof meta.dir === 'string') return { dir: meta.dir, createdAt: meta.createdAt ?? '' }
      return undefined
    } catch {
      return undefined
    }
  }

  private async runSync(state: DirState, ctx: SyncRunContext): Promise<void> {
    // 新增、修改和删除都在同一把写锁中处理，避免删除与首扫交叠。
    await this.registry.withLock(ctx.rootDir, async () => {
      const upserts: string[] = []
      const missing: string[] = []
      for (const path of ctx.onlyPaths) {
        if (this.opts.fs.exists(join(ctx.rootDir, path))) upserts.push(path)
        else missing.push(path)
      }
      if (upserts.length) {
        await state.indexer.indexRepo({ repoId: state.repoId, rootDir: ctx.rootDir, onlyPaths: upserts })
      }
      for (const path of missing) state.store.removeFile(state.repoId, path)
    })
  }
}

function rank(hit: SearchHit, query: string): number {
  const name = hit.name.toLowerCase()
  if (name === query) return 100
  if (name.startsWith(query)) return 50
  if (name.includes(query)) return 20
  return 0
}
