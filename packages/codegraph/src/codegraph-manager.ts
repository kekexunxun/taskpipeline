/**
 * CodegraphManager — 代码图谱索引生命周期管理。
 *
 * 职责：
 * - 为每个目录管理索引（集中存储在 dataDir/codegraph/<hash>/graph.db）
 * - 触发首次构建 / 增量更新
 * - 维护索引状态（idle/indexing/error/not_indexed）
 * - 生成 MCP Server 配置供 Agent 注入
 *
 * 去重策略：以 normalized localPath 为缓存键，同一目录无论被仓库还是对话引用
 * 只构建一次索引。repositoryId 仅作为元数据记录首次索引来源。
 *
 * 设计模式：参照 MemoryService，遵循"服务 + IPC + UI"三层架构。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildMcpArgs, runBuild, runStats, runWatch } from './codegraph-cli.js'
import { loadMeta, loadAllMeta, saveMeta } from './codegraph-meta.js'
import type { BuildResult, CodegraphManagerOptions, McpServerConfig, RepoIndexMeta } from './types.js'

/** 最大并行构建数 */
const MAX_CONCURRENT_BUILDS = 2

/** 排队等待构建的条目 */
interface QueuedBuild {
  repositoryId: string
  localPath: string
  kind: 'ensure' | 'update'
  resolve: () => void
  reject: (error: unknown) => void
}

/** 路径标准化：resolve 去冗余 + 统一分隔符 */
function normalizePath(p: string): string {
  return resolve(p)
}

export class CodegraphManager {
  private readonly engine: 'native' | 'wasm'
  /** 内存缓存：normalized localPath → meta */
  private readonly metaCache = new Map<string, RepoIndexMeta>()
  /** 进行中的构建任务：normalized localPath → Promise */
  private readonly activeBuilds = new Map<string, Promise<void>>()
  /** 活跃的 watch 进程：normalized localPath → stop 函数 */
  private readonly activeWatches = new Map<string, () => void>()
  /** 构建等待队列：达到并发限制时排队 */
  private readonly buildQueue: QueuedBuild[] = []

  private readonly indexRoot: string

  constructor(options: CodegraphManagerOptions) {
    this.engine = options.engine ?? 'wasm'
    this.indexRoot = join(options.dataDir, 'codegraph')
  }

  // ─── 路径计算 ─────────────────────────────────────────────────────────────

  /** 计算目录路径的 hash（SHA-256 前 16 位） */
  private dirHash(localPath: string): string {
    return createHash('sha256').update(resolve(localPath)).digest('hex').slice(0, 16)
  }

  /** 获取集中存储的索引目录路径：dataDir/codegraph/<hash>/ */
  dirIndexDir(localPath: string): string {
    return join(this.indexRoot, this.dirHash(localPath))
  }

  /** 获取 graph.db 路径 */
  dirDbPath(localPath: string): string {
    return join(this.dirIndexDir(localPath), 'graph.db')
  }

  // ─── 生命周期 ─────────────────────────────────────────────────────────────

  /**
   * 启动时验证所有索引有效性，并为新目录首次构建。
   *
   * 1. 扫描 dataDir/codegraph/ 下所有 meta.json 加载到缓存（确保 UI 可见）
   * 2. 验证 graph.db 文件存在性，缺失或状态异常时触发重建
   * 3. 对传入的目录列表，若尚无索引则首次构建
   */
  async validateStartup(dirs: Array<{ id: string; localPath: string }>): Promise<void> {
    // 1. 扫描磁盘所有已有索引到缓存
    const allMeta = loadAllMeta(this.indexRoot)
    for (const [repoId, meta] of allMeta) {
      const key = normalizePath(meta.localPath)
      this.metaCache.set(key, meta)

      const dbPath = this.dirDbPath(meta.localPath)
      if (meta.status === 'idle' && existsSync(dbPath)) {
        console.info(
          '[codegraph] startup validate: ok',
          meta.localPath,
          `files=${meta.fileCount ?? 0} nodes=${meta.nodeCount ?? 0} edges=${meta.edgeCount ?? 0}`
        )
        continue
      }

      // db 缺失或状态异常 → 触发构建
      console.info(
        '[codegraph] startup validate: rebuilding',
        meta.localPath,
        'reason:',
        !existsSync(dbPath) ? 'db missing' : `status=${meta.status}`
      )
      void this.ensureIndex(repoId, meta.localPath).catch((error) => {
        console.warn('[codegraph] startup rebuild failed:', meta.localPath, error)
      })
    }

    // 2. 为新目录首次构建索引
    for (const dir of dirs) {
      const key = normalizePath(dir.localPath)
      if (this.metaCache.has(key)) continue
      console.info('[codegraph] startup: building new index for', dir.localPath)
      void this.ensureIndex(dir.id, dir.localPath).catch((error) => {
        console.warn('[codegraph] startup build failed:', dir.localPath, error)
      })
    }
  }

  /**
   * 启动所有已索引目录的 watch 进程（实时增量更新）。
   *
   * 在 validateStartup 完成后调用，为所有 idle 状态的目录启动 watch。
   */
  startAllWatches(): void {
    for (const [key, meta] of this.metaCache) {
      if (meta.status !== 'idle') continue
      if (this.activeWatches.has(key)) continue
      this.startWatch(key, meta.localPath)
    }
  }

  /**
   * 停止所有 watch 进程。
   */
  stopAllWatches(): void {
    for (const [_key, stop] of this.activeWatches) {
      stop()
    }
    this.activeWatches.clear()
  }

  /**
   * 对所有已索引仓库执行增量更新（定时任务调用）。
   *
   * 遍历内存缓存，仅对 status === 'idle' 的仓库执行增量构建。
   */
  async updateAllIndexes(): Promise<void> {
    for (const [_key, meta] of this.metaCache) {
      if (meta.status !== 'idle') continue
      void this.updateIndex(meta.repositoryId, meta.localPath).catch((error) => {
        console.warn('[codegraph] periodic update failed:', meta.localPath, error)
      })
    }
  }

  /**
   * 确保索引存在（首次构建或增量更新）。
   *
   * 以 normalized localPath 为去重键：同一目录多次调用只构建一次。
   * repositoryId 仅记录首次索引来源。
   */
  async ensureIndex(repositoryId: string, localPath: string): Promise<void> {
    const key = normalizePath(localPath)

    // 防重入：如果正在构建，直接返回
    if (this.activeBuilds.has(key)) {
      return this.activeBuilds.get(key)!
    }

    // 检查并发限制：达到上限时排入等待队列
    if (this.activeBuilds.size >= MAX_CONCURRENT_BUILDS) {
      console.info('[codegraph] 达到最大并行构建数限制，排入等待队列:', key)
      return this.enqueueBuild(repositoryId, localPath, 'ensure')
    }

    const dbPath = this.dirDbPath(localPath)
    const existingMeta = this.metaCache.get(key)

    // 如果已索引且 graph.db 存在，跳过
    if (existingMeta?.status === 'idle' && existsSync(dbPath)) {
      return
    }

    // 如果 graph.db 已存在但缓存为空（重启后首次调用），从磁盘加载 meta
    if (!existingMeta && existsSync(dbPath)) {
      const diskMeta = loadMeta(this.dirIndexDir(localPath))
      if (diskMeta && diskMeta.status === 'idle') {
        this.metaCache.set(key, diskMeta)
        return
      }
    }

    // 设置状态为 indexing
    this.setMeta(repositoryId, localPath, { status: 'indexing' })

    // 清理本地残留的 .codegraph 目录（CLI 固定输出到此位置）
    const localCgDir = join(localPath, '.codegraph')
    if (existsSync(localCgDir)) rmSync(localCgDir, { recursive: true, force: true })

    const buildPromise = this.executeBuild(localPath, dbPath, localCgDir)
      .then((result) => {
        this.setMeta(repositoryId, localPath, {
          status: 'idle',
          lastIndexedAt: new Date().toISOString(),
          fileCount: result.fileCount,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount
        })
      })
      .catch((error) => {
        this.setMeta(repositoryId, localPath, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        this.activeBuilds.delete(key)
        this.tryProcessQueue()
        // 构建完成后为所有 idle 目录补启 watch（覆盖异步构建 / 排队构建的场景）
        this.startAllWatches()
      })

    this.activeBuilds.set(key, buildPromise)
    return buildPromise
  }

  /**
   * 强制全量重建索引。
   */
  async forceRebuild(repositoryId: string, localPath: string): Promise<void> {
    const key = normalizePath(localPath)

    if (this.activeBuilds.has(key)) {
      throw new Error('目录正在索引中，请等待完成')
    }

    const dbPath = this.dirDbPath(localPath)
    this.setMeta(repositoryId, localPath, { status: 'indexing' })

    // 清理本地残留的 .codegraph 目录（CLI 固定输出到此位置）
    const localCgDir = join(localPath, '.codegraph')
    if (existsSync(localCgDir)) rmSync(localCgDir, { recursive: true, force: true })

    const buildPromise = this.executeBuild(localPath, dbPath, localCgDir, false)
      .then((result) => {
        this.setMeta(repositoryId, localPath, {
          status: 'idle',
          lastIndexedAt: new Date().toISOString(),
          fileCount: result.fileCount,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount
        })
        console.log('[codegraph] meta after setMeta:', this.metaCache.get(normalizePath(localPath)))
      })
      .catch((error) => {
        this.setMeta(repositoryId, localPath, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
        throw error
      })
      .finally(() => {
        this.activeBuilds.delete(key)
        this.tryProcessQueue()
      })

    this.activeBuilds.set(key, buildPromise)
    return buildPromise
  }

  /**
   * 显式触发增量更新（无论索引是否已存在）。
   *
   * 用于任务启动、文件变更等场景，确保索引与代码同步。
   * 如果索引不存在，自动降级为全量构建。
   */
  async updateIndex(repositoryId: string, localPath: string): Promise<void> {
    const key = normalizePath(localPath)

    if (this.activeBuilds.has(key)) {
      return this.activeBuilds.get(key)!
    }

    if (this.activeBuilds.size >= MAX_CONCURRENT_BUILDS) {
      console.info('[codegraph] 达到最大并行构建数限制，排入等待队列:', key)
      return this.enqueueBuild(repositoryId, localPath, 'update')
    }

    const dbPath = this.dirDbPath(localPath)
    const existingMeta = this.metaCache.get(key)

    // 索引不存在或状态异常，降级为 ensureIndex
    if (!existingMeta || existingMeta.status !== 'idle' || !existsSync(dbPath)) {
      return this.ensureIndex(repositoryId, localPath)
    }

    // 执行增量构建
    this.setMeta(repositoryId, localPath, { status: 'indexing' })

    // 清理本地残留的 .codegraph 目录（CLI 固定输出到此位置）
    const localCgDir = join(localPath, '.codegraph')
    if (existsSync(localCgDir)) rmSync(localCgDir, { recursive: true, force: true })

    const buildPromise = this.executeBuild(localPath, dbPath, localCgDir, true)
      .then((result) => {
        this.setMeta(repositoryId, localPath, {
          status: 'idle',
          lastIndexedAt: new Date().toISOString(),
          fileCount: result.fileCount,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount
        })
      })
      .catch((error) => {
        // 增量更新失败不影响现有索引，仅记录错误
        console.warn('[codegraph] 增量更新失败:', error)
        this.setMeta(repositoryId, localPath, {
          status: 'idle', // 保持 idle，不影响后续使用
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        this.activeBuilds.delete(key)
        this.tryProcessQueue()
        // 构建完成后为所有 idle 目录补启 watch（覆盖异步构建 / 排队构建的场景）
        this.startAllWatches()
      })

    this.activeBuilds.set(key, buildPromise)
    return buildPromise
  }

  /**
   * 删除目录索引。
   */
  deleteIndex(repositoryId: string): void {
    // 按 repositoryId 查找对应的 meta（向后兼容）
    const meta = this.findByRepositoryId(repositoryId)
    if (!meta) return

    const key = normalizePath(meta.localPath)
    this.stopWatch(key)
    const indexDir = this.dirIndexDir(meta.localPath)
    rmSync(indexDir, { recursive: true, force: true })
    this.metaCache.delete(key)
  }

  /**
   * 按路径删除索引（对话解绑目录等场景）。
   */
  deleteIndexByPath(localPath: string): void {
    const key = normalizePath(localPath)
    this.stopWatch(key)
    const indexDir = this.dirIndexDir(localPath)
    if (existsSync(indexDir)) {
      rmSync(indexDir, { recursive: true, force: true })
    }
    this.metaCache.delete(key)
  }

  // ─── 状态查询 ─────────────────────────────────────────────────────────────

  /**
   * 按 repositoryId 获取索引状态（向后兼容）。
   */
  getStatus(repositoryId: string): RepoIndexMeta | undefined {
    return this.findByRepositoryId(repositoryId)
  }

  /**
   * 按文件路径获取索引状态（路径去重后的主查询方式）。
   *
   * 仓库和对话指向同一目录时返回同一份状态。
   * 如果状态显示 0 但数据库存在，自动刷新统计。
   */
  async getStatusByPath(localPath: string): Promise<RepoIndexMeta | undefined> {
    const key = normalizePath(localPath)
    const meta = this.metaCache.get(key)
    if (!meta) return undefined

    // 如果状态是 idle 但统计是 0，尝试从数据库重新读取
    if (meta.status === 'idle' && meta.fileCount === 0 && meta.nodeCount === 0 && meta.edgeCount === 0) {
      const dbPath = this.dirDbPath(localPath)
      if (existsSync(dbPath)) {
        const stats = await runStats(dbPath, { engine: this.engine })
        if (stats && (stats.fileCount > 0 || stats.nodeCount > 0 || stats.edgeCount > 0)) {
          // 更新缓存
          this.setMeta(meta.repositoryId, localPath, {
            fileCount: stats.fileCount,
            nodeCount: stats.nodeCount,
            edgeCount: stats.edgeCount
          })
          return this.metaCache.get(key)
        }
      }
    }

    return meta
  }

  /**
   * 列出所有索引状态。
   */
  listAll(): RepoIndexMeta[] {
    return Array.from(this.metaCache.values())
  }

  /**
   * 检查目录是否已索引（路径去重后直接查缓存）。
   */
  hasIndexFor(localPath: string): boolean {
    const meta = this.metaCache.get(normalizePath(localPath))
    return Boolean(meta && meta.status === 'idle')
  }

  // ─── MCP 配置生成 ─────────────────────────────────────────────────────────

  /**
   * 生成 MCP Server 配置（供 Chat/Task Agent 注入）。
   *
   * 返回的配置可直接用于 Qoder SDK 的 mcpServers 选项。
   */
  resolveMcpConfig(localPath: string): McpServerConfig | null {
    const hasIndex = this.hasIndexFor(localPath)
    console.log('[codegraph] resolveMcpConfig:', { localPath, hasIndex, cacheKeys: Array.from(this.metaCache.keys()) })
    if (!hasIndex) return null

    const dbPath = this.dirDbPath(localPath)
    const { command, args } = buildMcpArgs(dbPath, this.engine)
    console.log('[codegraph] MCP config:', { dbPath, command, args })

    return {
      type: 'stdio',
      command,
      args
    }
  }

  // ─── 内部方法 ─────────────────────────────────────────────────────────────

  /**
   * 为指定目录启动 watch 进程。
   */
  private startWatch(key: string, localPath: string): void {
    const dbPath = this.dirDbPath(localPath)
    if (!existsSync(dbPath)) return

    const { stop } = runWatch(localPath, dbPath, { engine: this.engine })
    this.activeWatches.set(key, stop)
    console.info('[codegraph] watch started for:', localPath)
  }

  /**
   * 停止指定目录的 watch 进程。
   */
  private stopWatch(key: string): void {
    const stop = this.activeWatches.get(key)
    if (stop) {
      stop()
      this.activeWatches.delete(key)
    }
  }

  /**
   * 将 CLI 输出的本地 .codegraph 目录移动到集中存储位置。
   *
   * codegraph CLI build 子命令固定输出到 <repoPath>/.codegraph/，
   * 构建完成后移动到 dataDir/codegraph/<hash>/ 统一管理。
   */
  private moveToCentral(localCgDir: string, localPath: string): void {
    if (!existsSync(localCgDir)) return
    const targetDir = this.dirIndexDir(localPath)
    // 清理目标目录（可能来自上次残留）
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
    mkdirSync(targetDir, { recursive: true })
    renameSync(localCgDir, targetDir)
  }

  /**
   * 按 repositoryId 在缓存中查找 meta（向后兼容，线性扫描）。
   */
  private findByRepositoryId(repositoryId: string): RepoIndexMeta | undefined {
    for (const meta of this.metaCache.values()) {
      if (meta.repositoryId === repositoryId) return meta
    }
    return undefined
  }

  /**
   * 将构建请求排入等待队列，返回在所有前置构建完成后 resolve 的 Promise。
   */
  private enqueueBuild(repositoryId: string, localPath: string, kind: 'ensure' | 'update'): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.buildQueue.push({ repositoryId, localPath, kind, resolve, reject })
    })
  }

  /**
   * 尝试从队列中取出等待的构建任务并执行。
   *
   * 每当一个活跃构建完成时调用，释放槽位后自动启动队列中的下一个构建。
   */
  private tryProcessQueue(): void {
    while (this.buildQueue.length > 0 && this.activeBuilds.size < MAX_CONCURRENT_BUILDS) {
      const entry = this.buildQueue.shift()!
      const key = normalizePath(entry.localPath)

      // 跳过已被其他路径完成的重复构建
      if (this.activeBuilds.has(key)) {
        entry.resolve()
        continue
      }

      console.info('[codegraph] 从等待队列启动构建:', key)
      const promise =
        entry.kind === 'ensure'
          ? this.ensureIndex(entry.repositoryId, entry.localPath)
          : this.updateIndex(entry.repositoryId, entry.localPath)

      promise.then(entry.resolve).catch(entry.reject)
    }
  }

  /**
   * 执行 codegraph build 命令，构建完成后从数据库读取实际统计。
   */
  private async executeBuild(
    localPath: string,
    dbPath: string,
    localCgDir: string,
    incremental = true
  ): Promise<BuildResult> {
    const result = await runBuild(localPath, {
      engine: this.engine,
      incremental
    })
    console.log('[codegraph] build result:', result)

    // 将 CLI 输出的本地 .codegraph 移动到集中存储位置（必须在 stats 之前）
    this.moveToCentral(localCgDir, localPath)

    // build 命令不返回统计，构建完成后通过 stats 命令获取实际数据
    const stats = await runStats(dbPath, { engine: this.engine })
    console.log('[codegraph] stats result:', stats, 'dbPath:', dbPath)
    if (stats) {
      return { ...result, ...stats }
    }
    return result
  }

  /**
   * 更新内存缓存并持久化到磁盘。
   *
   * 以 normalized localPath 为缓存键；repositoryId 仅记录在 meta 中。
   */
  private setMeta(repositoryId: string, localPath: string, patch: Partial<RepoIndexMeta>): void {
    const key = normalizePath(localPath)
    const existing = this.metaCache.get(key)
    const meta: RepoIndexMeta = {
      repositoryId,
      localPath,
      status: 'not_indexed',
      engine: this.engine,
      ...existing,
      ...patch
    }
    this.metaCache.set(key, meta)

    // 持久化到磁盘
    const indexDir = this.dirIndexDir(localPath)
    saveMeta(indexDir, meta)
  }
}
