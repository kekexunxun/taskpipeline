/** 可选 Node.js 文件监听适配器；通过独立子路径导出，核心入口不加载 chokidar。 */
import { relative, resolve } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { DEFAULT_HARD_SKIP_DIRS } from '../indexer/discover.js'
import type { IndexWatcher, IndexWatcherOptions } from '../types.js'

export interface NodeIndexWatcherOptions extends IndexWatcherOptions {
  /** 文件写入稳定阈值，默认 300ms。 */
  stabilityThreshold?: number
}

export class NodeIndexWatcher implements IndexWatcher {
  private watcher: FSWatcher | undefined
  private closing: Promise<void> | undefined

  constructor(private readonly opts: NodeIndexWatcherOptions) {}

  start(): void {
    if (this.watcher || this.closing) return
    const rootDir = resolve(this.opts.rootDir)
    const relativePath = (path: string): string => relative(rootDir, path).split(/[\\/]/).join('/')
    this.watcher = watch(rootDir, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.opts.stabilityThreshold ?? 300,
        pollInterval: 100
      },
      // 只检查根目录之下的路径，共用文件发现规则，不因祖先目录同名而误跳整个仓库。
      ignored: (path: string) =>
        relativePath(path)
          .split('/')
          .some((part) => DEFAULT_HARD_SKIP_DIRS.has(part))
    })
    this.watcher
      .on('add', (path: string) => this.opts.onFileChange(relativePath(path), 'upsert'))
      .on('change', (path: string) => this.opts.onFileChange(relativePath(path), 'upsert'))
      .on('unlink', (path: string) => this.opts.onFileChange(relativePath(path), 'unlink'))
      .on('error', (error) => this.opts.onError?.(error))
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing
    if (!this.watcher) return Promise.resolve()
    const watcher = this.watcher
    this.watcher = undefined
    this.closing = watcher.close().finally(() => {
      this.closing = undefined
    })
    return this.closing
  }
}
