/**
 * CodeIndexer — 全量/增量索引编排。
 *
 * 增量策略（决策 #11 四层触发中的「①打开即对账」核心算法）：
 *  - 以文件为单元，用 (size, mtimeMs, contentHash) 三级差分。
 *  - size+mtime 命中 → 连文件都不读，直接跳过（大仓秒级对账）。
 *  - mtime 变了才读盘算 hash；hash 没变 → 仅刷新记录时间戳、不重解析。
 *  - 扫描后，file_record 里已不存在的文件 → 删索引（处理删除/移动）。
 *
 * 依赖注入：backend / store 由调用方给；fs 缺省用 NodeFileSystem。包本身不建库、不感知 dbPath。
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Extractor, FileSystem, IndexProgress, IndexResult, Language, ParserBackend } from '../types.js'
import type { CodeIndexStore } from '../db/sqlite-store.js'
import { grammarsForLanguage, resolveByExtension } from '../backend/grammars.js'
import { NodeFileSystem } from '../fs/node.js'
import { JavaScriptExtractor } from '../extractor/javascript.js'
import { TypeScriptExtractor } from '../extractor/typescript.js'
import { PythonExtractor } from '../extractor/python.js'
import { VueExtractor } from '../extractor/vue.js'
import { discoverFiles, type DiscoveredFile } from './discover.js'

export interface CodeIndexerOptions {
  backend: ParserBackend
  store: CodeIndexStore
  fs?: FileSystem
  /** 覆盖/扩展语言→抽取器（例如注入 java/php）。 */
  extractors?: Partial<Record<Language, Extractor>>
}

export interface IndexRepoOptions {
  repoId: string
  rootDir: string
  respectGitignore?: boolean
  maxFileSizeBytes?: number
  /** 强制全量重索引（忽略增量差分）。 */
  force?: boolean
  onProgress?: (p: IndexProgress) => void
  /** 只索引这批相对路径（写后即查用）；提供时跳过全量扫描。 */
  onlyPaths?: string[]
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export class CodeIndexer {
  private readonly fs: FileSystem
  private readonly extractors: Map<Language, Extractor>
  private readonly ensuredGrammars = new Set<string>()

  constructor(private readonly opts: CodeIndexerOptions) {
    this.fs = opts.fs ?? new NodeFileSystem()
    const b = opts.backend
    const defaults: Partial<Record<Language, Extractor>> = {
      javascript: new JavaScriptExtractor(b),
      typescript: new TypeScriptExtractor(b, { language: 'typescript' }),
      tsx: new TypeScriptExtractor(b, { language: 'tsx', grammar: 'tsx' }),
      python: new PythonExtractor(b),
      vue: new VueExtractor(b),
      ...opts.extractors
    }
    this.extractors = new Map(Object.entries(defaults).filter(([, v]) => !!v) as Array<[Language, Extractor]>)
  }

  supportedLanguages(): Language[] {
    return [...this.extractors.keys()]
  }

  private async ensureGrammars(language: Language): Promise<boolean> {
    for (const g of grammarsForLanguage(language)) {
      if (this.ensuredGrammars.has(g)) continue
      const ok = await this.opts.backend.ensureLanguage(g)
      if (!ok) return false
      this.ensuredGrammars.add(g)
    }
    return true
  }

  /** 索引一个仓（含增量）。 */
  async indexRepo(options: IndexRepoOptions): Promise<IndexResult> {
    const started = Date.now()
    const { repoId } = options
    const store = this.opts.store
    const base: IndexResult = {
      repoId,
      filesScanned: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      symbolCount: 0,
      edgeCount: 0,
      durationMs: 0,
      errors: []
    }

    // 写后即查：只重解析这批路径，跳过全量扫描。
    if (options.onlyPaths?.length) {
      const files = this.resolveOnlyPaths(options.rootDir, options.onlyPaths)
      return this.indexFileList(repoId, files, base, started, options.onProgress)
    }

    let discovered: DiscoveredFile[]
    try {
      discovered = discoverFiles({
        fs: this.fs,
        rootDir: options.rootDir,
        respectGitignore: options.respectGitignore,
        maxFileSizeBytes: options.maxFileSizeBytes
      })
    } catch (err) {
      return {
        ...base,
        durationMs: Date.now() - started,
        errors: [{ path: options.rootDir, message: (err as Error).message }]
      }
    }

    if (options.force) store.removeRepo(repoId)

    const result = await this.indexFileList(repoId, discovered, base, started, options.onProgress)

    // 删除处理：file_record 中已不在发现集的 → removeFile。
    if (!options.force) {
      const present = new Set(discovered.map((d) => d.relPath))
      for (const rec of store.listFileRecords(repoId)) {
        if (!present.has(rec.path)) store.removeFile(repoId, rec.path)
      }
    }
    return result
  }

  private resolveOnlyPaths(rootDir: string, onlyPaths: string[]): DiscoveredFile[] {
    const out: DiscoveredFile[] = []
    for (const rel of onlyPaths) {
      const relPath = rel.split(/[\\/]/).join('/')
      const absPath = resolve(rootDir, rel)
      const st = this.fs.stat(absPath)
      if (!st || !st.isFile) continue
      const mapped = resolveByExtension(relPath.slice(relPath.lastIndexOf('.')).toLowerCase())
      if (!mapped) continue
      out.push({ absPath, relPath, language: mapped.language, size: st.size, mtimeMs: Math.floor(st.mtimeMs) })
    }
    return out
  }

  private async indexFileList(
    repoId: string,
    files: DiscoveredFile[],
    acc: IndexResult,
    started: number,
    onProgress: ((p: IndexProgress) => void) | undefined
  ): Promise<IndexResult> {
    let filesIndexed = acc.filesIndexed
    let filesSkipped = acc.filesSkipped
    let filesErrored = acc.filesErrored
    let symbolCount = 0
    let edgeCount = 0
    const errors = [...acc.errors]
    const total = files.length
    let done = 0

    for (const file of files) {
      done++
      onProgress?.({ phase: 'index', total, done, current: file.relPath })
      const extractor = this.extractors.get(file.language)
      if (!extractor) {
        filesSkipped++ // 语言已发现但暂无抽取器（如 Phase 3 前的 java/php）
        continue
      }
      try {
        const res = await this.indexSingleFile(repoId, file, extractor)
        if (res.reindexed) {
          filesIndexed++
          symbolCount += res.symbolCount
          edgeCount += res.edgeCount
        } else {
          filesSkipped++
        }
      } catch (err) {
        filesErrored++
        errors.push({ path: file.relPath, message: (err as Error).message })
      }
    }

    onProgress?.({ phase: 'done', total, done })
    return {
      repoId,
      filesScanned: files.length,
      filesIndexed,
      filesSkipped,
      filesErrored,
      symbolCount,
      edgeCount,
      durationMs: Date.now() - started,
      errors
    }
  }

  /** 单文件索引：三级差分决定跳过 / 仅刷新 / 重解析。 */
  async indexSingleFile(
    repoId: string,
    file: DiscoveredFile,
    extractor: Extractor
  ): Promise<{ reindexed: boolean; symbolCount: number; edgeCount: number }> {
    const store = this.opts.store
    const rec = store.getFileRecord(repoId, file.relPath)
    // L1：size+mtime 命中 → 不读盘。
    if (rec && rec.size === file.size && rec.mtimeMs === file.mtimeMs && rec.language === file.language) {
      return { reindexed: false, symbolCount: 0, edgeCount: 0 }
    }
    const content = this.fs.readFile(file.absPath)
    const hash = sha256(content)
    // L2：内容 hash 未变（如 touch）→ 仅刷新记录时间戳，保留既有符号/边（不重解析也不清空）。
    if (rec && rec.contentHash === hash) {
      store.refreshFileRecord(repoId, file.relPath, { size: file.size, mtimeMs: file.mtimeMs, contentHash: hash })
      return { reindexed: false, symbolCount: 0, edgeCount: 0 }
    }
    if (!(await this.ensureGrammars(file.language))) {
      throw new Error(`grammar 加载失败：${file.language}`)
    }
    const result = extractor.extract({ absPath: file.absPath, relPath: file.relPath, content, language: file.language })
    const written = store.replaceFileSymbols({
      repoId,
      relPath: file.relPath,
      language: file.language,
      symbols: result.symbols,
      imports: result.imports,
      size: file.size,
      mtimeMs: file.mtimeMs,
      contentHash: hash
    })
    return { reindexed: true, symbolCount: written.symbolCount, edgeCount: written.edgeCount }
  }
}
