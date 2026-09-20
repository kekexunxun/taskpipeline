/**
 * CodeIndexStore — 索引存储层（依赖注入：constructor(db)）。
 *
 * 严格遵循决策 #13：包不建库、不感知 dbPath，SQLite 连接由调用方注入（与 memory 一致）。
 * 所有写路径以「文件」为事务单元：重解析一个文件 = 删旧节点(级联删边) + 插新节点 + 建边。
 */

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  EdgeKind,
  ExtractedSymbol,
  FileRecord,
  ImportInfo,
  IndexStats,
  Language,
  SearchHit,
  SearchOptions,
  SymbolKind
} from '../types.js'
import { ALL_DDL } from './schema.js'

/** 噪声符号：默认不进检索结果。 */
const NOISE_KINDS: SymbolKind[] = ['import', 'export', 'file', 'parameter']

export interface ReplaceFileInput {
  repoId: string
  relPath: string
  language: Language | null
  symbols: ExtractedSymbol[]
  imports: ImportInfo[]
  size: number
  mtimeMs: number
  contentHash: string
}

export class CodeIndexStore {
  constructor(readonly db: Database.Database) {
    // 与 memory 一致的稳健默认
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  /** 幂等建表。 */
  init(): this {
    this.db.exec(ALL_DDL.join('\n'))
    return this
  }

  static nodeId(repoId: string, filePath: string, kind: string, name: string, startLine: number): string {
    return createHash('sha1')
      .update(`${repoId}\u0000${filePath}\u0000${kind}\u0000${name}\u0000${startLine}`)
      .digest('hex')
  }

  static contentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex')
  }

  getFileRecord(repoId: string, path: string): FileRecord | null {
    const row = this.db
      .prepare(
        `SELECT repo_id, path, language, size, mtime_ms, content_hash, indexed_at
         FROM file_record WHERE repo_id = ? AND path = ?`
      )
      .get(repoId, path) as
      | {
          repo_id: string
          path: string
          language: string | null
          size: number
          mtime_ms: number
          content_hash: string
          indexed_at: string
        }
      | undefined
    if (!row) return null
    return {
      repoId: row.repo_id,
      path: row.path,
      language: (row.language as Language | null) ?? null,
      size: row.size,
      mtimeMs: row.mtime_ms,
      contentHash: row.content_hash,
      indexedAt: row.indexed_at
    }
  }

  listFileRecords(repoId: string): FileRecord[] {
    const rows = this.db
      .prepare(
        `SELECT repo_id, path, language, size, mtime_ms, content_hash, indexed_at
         FROM file_record WHERE repo_id = ?`
      )
      .all(repoId) as Array<{
      repo_id: string
      path: string
      language: string | null
      size: number
      mtime_ms: number
      content_hash: string
      indexed_at: string
    }>
    return rows.map((r) => ({
      repoId: r.repo_id,
      path: r.path,
      language: (r.language as Language | null) ?? null,
      size: r.size,
      mtimeMs: r.mtime_ms,
      contentHash: r.content_hash,
      indexedAt: r.indexed_at
    }))
  }

  /**
   * 用一个文件的新符号替换旧符号（事务）。返回写入的节点/边数量。
   */
  replaceFileSymbols(input: ReplaceFileInput): { symbolCount: number; edgeCount: number } {
    const { repoId, relPath, language, symbols, imports } = input
    const now = new Date().toISOString()
    const fileNodeId = CodeIndexStore.nodeId(repoId, relPath, 'file', relPath, 0)

    const delNodes = this.db.prepare(`DELETE FROM node WHERE repo_id = ? AND file_path = ?`)
    const delFileRecord = this.db.prepare(`DELETE FROM file_record WHERE repo_id = ? AND path = ?`)
    const insNode = this.db.prepare(`
      INSERT INTO node (id, repo_id, kind, name, qualified_name, file_path, language,
        start_line, start_col, end_line, end_col, signature, visibility, exported, extra, updated_at)
      VALUES (@id,@repo_id,@kind,@name,@qualified_name,@file_path,@language,
        @start_line,@start_col,@end_line,@end_col,@signature,@visibility,@exported,@extra,@updated_at)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, name=excluded.name, qualified_name=excluded.qualified_name,
        signature=excluded.signature, visibility=excluded.visibility, exported=excluded.exported,
        extra=excluded.extra, updated_at=excluded.updated_at
    `)
    const insEdge = this.db.prepare(`
      INSERT INTO edge (repo_id, kind, from_node, to_node, to_name, file_path, line, provenance)
      VALUES (@repo_id,@kind,@from_node,@to_node,@to_name,@file_path,@line,@provenance)
    `)
    const upsertFileRecord = this.db.prepare(`
      INSERT INTO file_record (repo_id, path, language, size, mtime_ms, content_hash, indexed_at)
      VALUES (@repo_id,@path,@language,@size,@mtime_ms,@content_hash,@indexed_at)
      ON CONFLICT(repo_id, path) DO UPDATE SET
        language=excluded.language, size=excluded.size, mtime_ms=excluded.mtime_ms,
        content_hash=excluded.content_hash, indexed_at=excluded.indexed_at
    `)

    let edgeCount = 0
    const tx = this.db.transaction(() => {
      // 清旧：按 file_path 删节点（edge 靠 FK 级联删）；再删文件记录。
      delNodes.run(repoId, relPath)
      delFileRecord.run(repoId, relPath)

      // 文件节点本身。
      insNode.run({
        id: fileNodeId,
        repo_id: repoId,
        kind: 'file' as SymbolKind,
        name: relPath,
        qualified_name: relPath,
        file_path: relPath,
        language: (language ?? 'unknown') as string,
        start_line: 0,
        start_col: 0,
        end_line: 0,
        end_col: 0,
        signature: null,
        visibility: null,
        exported: 0,
        extra: null,
        updated_at: now
      })

      const seen = new Set<string>()
      for (const s of symbols) {
        // 一个文件调用replace的全部符号必属该文件：file_path一律用relPath，
        // 与上方按 relPath 删除保持一致（抽取器回传的 s.filePath 可能为块内相对/临时值）。
        const id = CodeIndexStore.nodeId(repoId, relPath, s.kind, s.name, s.startLine)
        if (seen.has(id)) continue // 同 (kind,name,line) 去重（重载同名同行防御）
        seen.add(id)
        insNode.run({
          id,
          repo_id: repoId,
          kind: s.kind,
          name: s.name,
          qualified_name: s.qualifiedName ?? s.name,
          file_path: relPath,
          language: s.language,
          start_line: s.startLine,
          start_col: s.startCol,
          end_line: s.endLine,
          end_col: s.endCol,
          signature: s.signature ?? null,
          visibility: s.visibility ?? null,
          exported: s.exported ? 1 : 0,
          extra: s.extra ? JSON.stringify(s.extra) : null,
          updated_at: now
        })
        // contains：file → symbol
        insEdge.run({
          repo_id: repoId,
          kind: 'contains' as EdgeKind,
          from_node: fileNodeId,
          to_node: id,
          to_name: null,
          file_path: relPath,
          line: s.startLine,
          provenance: 'ast'
        })
        edgeCount++
      }

      for (const imp of imports) {
        insEdge.run({
          repo_id: repoId,
          kind: 'imports' as EdgeKind,
          from_node: fileNodeId,
          to_node: null,
          to_name: imp.module,
          file_path: relPath,
          line: imp.line,
          provenance: imp.names?.length ? imp.names.join(',') : (imp.alias ?? null)
        })
        edgeCount++
      }

      upsertFileRecord.run({
        repo_id: repoId,
        path: relPath,
        language,
        size: input.size,
        mtime_ms: input.mtimeMs,
        content_hash: input.contentHash,
        indexed_at: now
      })
    })
    tx()

    return { symbolCount: symbols.length, edgeCount }
  }

  /** 仅刷新 file_record 的 (size,mtime,hash,indexed_at)，不动 node/edge。用于「touch 但内容未变」的 L2 快路径。 */
  refreshFileRecord(repoId: string, path: string, meta: { size: number; mtimeMs: number; contentHash: string }): void {
    this.db
      .prepare(
        `UPDATE file_record SET size = ?, mtime_ms = ?, content_hash = ?, indexed_at = ? WHERE repo_id = ? AND path = ?`
      )
      .run(meta.size, meta.mtimeMs, meta.contentHash, new Date().toISOString(), repoId, path)
  }

  /** 删除一个文件的所有索引（文件被删/移出范围时）。 */
  removeFile(repoId: string, path: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM node WHERE repo_id = ? AND file_path = ?`).run(repoId, path)
      this.db.prepare(`DELETE FROM file_record WHERE repo_id = ? AND path = ?`).run(repoId, path)
    })
    tx()
  }

  /** 删除整个仓（重建/重置时）。 */
  removeRepo(repoId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM edge WHERE repo_id = ?`).run(repoId)
      this.db.prepare(`DELETE FROM node WHERE repo_id = ?`).run(repoId)
      this.db.prepare(`DELETE FROM file_record WHERE repo_id = ?`).run(repoId)
    })
    tx()
  }

  /**
   * 符号检索：trigram FTS 优先，短查询(≤2)或空结果回退 LIKE。返回按相关度排序的命中。
   */
  searchSymbols(query: string, opts: SearchOptions = {}): SearchHit[] {
    const q = query.trim()
    if (!q) return []
    const limit = opts.limit ?? 50
    const repoIds = opts.repoIds?.length ? opts.repoIds : null
    const noise = !opts.includeNoise

    const selectCols = `n.repo_id, n.name, n.qualified_name, n.kind, n.language, n.file_path,
      n.start_line, n.end_line, n.signature, n.exported`

    const mapRow = (r: Record<string, unknown>): SearchHit => ({
      repoId: String(r.repo_id),
      name: String(r.name),
      qualifiedName: (r.qualified_name as string | null) ?? null,
      kind: r.kind as SymbolKind,
      language: r.language as Language,
      filePath: String(r.file_path),
      startLine: Number(r.start_line),
      endLine: Number(r.end_line),
      signature: (r.signature as string | null) ?? null,
      exported: Number(r.exported) === 1,
      score: Number(r.__score ?? 0)
    })

    const kindFilter = opts.kinds?.length ? ` AND n.kind IN (${opts.kinds.map(() => '?').join(',')})` : ''
    const langFilter = opts.languages?.length ? ` AND n.language IN (${opts.languages.map(() => '?').join(',')})` : ''
    const noiseFilter = noise ? ` AND n.kind NOT IN (${NOISE_KINDS.map(() => '?').join(',')})` : ''

    // FTS 路径（≥3 字符）。
    if (q.length >= 3) {
      const match = `"${q.replace(/"/g, '""')}"`
      const repoFilter = repoIds ? ` AND n.repo_id IN (${repoIds.map(() => '?').join(',')})` : ''
      const sql = `
        SELECT ${selectCols}, bm25(node_fts) AS __score
        FROM node_fts JOIN node n ON n.rowid = node_fts.rowid
        WHERE node_fts MATCH ?${repoFilter}${noiseFilter}${kindFilter}${langFilter}
        ORDER BY __score LIMIT ?`
      const params: unknown[] = [match]
      if (repoIds) params.push(...repoIds)
      if (noise) params.push(...NOISE_KINDS)
      if (opts.kinds?.length) params.push(...opts.kinds)
      if (opts.languages?.length) params.push(...opts.languages)
      params.push(limit)
      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
      if (rows.length) return rows.map(mapRow)
    }

    // LIKE 回退（短查询 / FTS 空）。精确名优先。
    const like = `%${q}%`
    const repoFilter = repoIds ? ` AND repo_id IN (${repoIds.map(() => '?').join(',')})` : ''
    const sql = `
      SELECT ${selectCols.replace(/n\./g, '')} , 
        CASE WHEN name = ? THEN 3 WHEN name LIKE ? THEN 2 WHEN name LIKE ? THEN 1 ELSE 0 END AS __score
      FROM node WHERE name LIKE ?${repoFilter}${noiseFilter.replace(/n\./g, '')}${kindFilter.replace(/n\./g, '')}${langFilter.replace(/n\./g, '')}
      ORDER BY __score DESC, exported DESC, length(name) ASC LIMIT ?`
    const params: unknown[] = [q, `${q}%`, `%${q}%`, like]
    if (repoIds) params.push(...repoIds)
    if (noise) params.push(...NOISE_KINDS)
    if (opts.kinds?.length) params.push(...opts.kinds)
    if (opts.languages?.length) params.push(...opts.languages)
    params.push(limit)
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map(mapRow)
  }

  getStats(repoId?: string): IndexStats {
    const where = repoId ? 'WHERE repo_id = ?' : ''
    const p = repoId ? [repoId] : []
    const nodeCount = (this.db.prepare(`SELECT COUNT(*) c FROM node ${where}`).get(...p) as { c: number }).c
    const edgeCount = (this.db.prepare(`SELECT COUNT(*) c FROM edge ${where}`).get(...p) as { c: number }).c
    const fileCount = (this.db.prepare(`SELECT COUNT(*) c FROM file_record ${where}`).get(...p) as { c: number }).c
    const kindRows = this.db.prepare(`SELECT kind, COUNT(*) c FROM node ${where} GROUP BY kind`).all(...p) as Array<{
      kind: string
      c: number
    }>
    const langRows = this.db
      .prepare(
        `SELECT language, COUNT(*) c FROM file_record ${where ? where + ' AND' : 'WHERE'} language IS NOT NULL GROUP BY language`
      )
      .all(...p) as Array<{ language: string; c: number }>
    const nodesByKind: Record<string, number> = {}
    for (const r of kindRows) nodesByKind[r.kind] = r.c
    const filesByLanguage: Record<string, number> = {}
    for (const r of langRows) filesByLanguage[r.language] = r.c
    return repoId
      ? { repoId, nodeCount, edgeCount, fileCount, nodesByKind, filesByLanguage }
      : { nodeCount, edgeCount, fileCount, nodesByKind, filesByLanguage }
  }

  /** 列出已索引的仓 id（便于接线层枚举）。 */
  listRepoIds(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT repo_id FROM file_record`).all() as Array<{ repo_id: string }>
    return rows.map((r) => r.repo_id)
  }
}
