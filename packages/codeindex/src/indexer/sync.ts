/**
 * 增量 sync 调度（决策 #11 四层触发中的「②实时 watcher」与「③写后即查」的公共后端）。
 *
 * 职责：把「哪些路径刚变了」按 (repoId, rootDir) 归并、防抖，成批交给 run 回调去重解析。
 *  - 防抖：一次 npm build / 拖拽改几十个文件不会逐个触发（合并窗口默认 250ms）。
 *  - 写后即查一致性：flushNow() 立即结算并 await，供 Edit/Write 工具改完当场就能查到。
 *  - 同 (repoId,rootDir) 串行：一次 flush 未完再来事件，排队等下一轮，不并发写同库。
 *
 * 运行时无关：不 import chokidar/fs/timer 之外的东西；定时器可注入，便于单测用假时钟。
 */

export interface SyncRunContext {
  repoId: string
  rootDir: string
  /** 本轮需重解析的仓内相对路径（POSIX）。空数组表示删除对账由上层兜底，这里不会空跑。 */
  onlyPaths: string[]
}

export interface DebouncedSyncOptions {
  /** 真正执行重解析的回调（通常包一层 indexer.indexRepo({onlyPaths})）。抛错内部吞掉、不冒泡。 */
  run: (ctx: SyncRunContext) => Promise<void>
  /** 合并窗口，默认 250ms。 */
  debounceMs?: number
  /** 定时器注入（默认 setTimeout/clearTimeout）；单测传假时钟。 */
  timers?: {
    set(cb: () => void, ms: number): unknown
    clear(handle: unknown): void
  }
  /** 单轮最大路径数，超出立即提前 flush（防积压）。默认 500。 */
  maxBatch?: number
  /** 错误旁报（可选）。 */
  onError?: (err: unknown, ctx: SyncRunContext) => void
}

interface Bucket {
  paths: Set<string>
  handle: unknown
}

function keyOf(repoId: string, rootDir: string): string {
  return `${repoId}\u0000${rootDir}`
}

export class DebouncedSyncQueue {
  private readonly buckets = new Map<string, Bucket>()
  /** 每个 bucket 一把「当前是否在跑」的锁，保证同库串行。 */
  private readonly running = new Map<string, Promise<void>>()
  private readonly debounceMs: number
  private readonly maxBatch: number
  private readonly timers: NonNullable<DebouncedSyncOptions['timers']>
  private disposed = false

  constructor(private readonly opts: DebouncedSyncOptions) {
    this.debounceMs = opts.debounceMs ?? 250
    this.maxBatch = opts.maxBatch ?? 500
    this.timers = opts.timers ?? {
      set: (cb, ms) => setTimeout(cb, ms) as unknown,
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
  }

  /** 记下一个变更路径，安排防抖 flush。 */
  enqueue(repoId: string, rootDir: string, relPath: string): void {
    if (this.disposed) return
    const key = keyOf(repoId, rootDir)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { paths: new Set(), handle: null }
      this.buckets.set(key, bucket)
    }
    bucket.paths.add(relPath.split(/[\\/]/).join('/'))
    if (this.timers.clear && bucket.handle != null) this.timers.clear(bucket.handle)
    if (bucket.paths.size >= this.maxBatch) {
      void this.settle(key)
      return
    }
    bucket.handle = this.timers.set(() => void this.settle(key), this.debounceMs)
  }

  /** 立即结算某个 (repoId,rootDir) 的待发批次并 await —— 写后即查一致性入口。 */
  async flush(repoId: string, rootDir: string): Promise<void> {
    await this.settle(keyOf(repoId, rootDir))
  }

  /** 结算所有待发批次并 await（含在途运行），用于测试或退出前收尾。 */
  async flushAll(): Promise<void> {
    const keys = [...this.buckets.keys()]
    await Promise.all(keys.map((k) => this.settle(k)))
    // 等 settle 期间新起的在途任务收尾。
    while (this.running.size) {
      await Promise.all([...this.running.values()])
    }
  }

  /** 待处理路径总数（观测 / 测试用）。 */
  pending(): number {
    let n = 0
    for (const b of this.buckets.values()) n += b.paths.size
    return n
  }

  dispose(): void {
    this.disposed = true
    for (const b of this.buckets.values()) if (b.handle != null) this.timers.clear(b.handle)
    this.buckets.clear()
  }

  /** 取出某 bucket 当前批次并串行执行；期间到达的新路径进下一轮。 */
  private settle(key: string): Promise<void> {
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.paths.size === 0) return this.running.get(key) ?? Promise.resolve()
    if (bucket.handle != null) {
      this.timers.clear(bucket.handle)
      bucket.handle = null
    }
    const onlyPaths = [...bucket.paths]
    bucket.paths.clear()

    const [repoId, rootDir] = key.split('\u0000')
    const prev = this.running.get(key) ?? Promise.resolve()
    const next = prev.then(async () => {
      try {
        await this.opts.run({ repoId: repoId ?? '', rootDir: rootDir ?? '', onlyPaths })
      } catch (err) {
        this.opts.onError?.(err, { repoId: repoId ?? '', rootDir: rootDir ?? '', onlyPaths })
      }
    })
    this.running.set(key, next)
    void next.finally(() => {
      if (this.running.get(key) === next) this.running.delete(key)
    })
    return next
  }
}
