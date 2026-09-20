/**
 * Knowledge 存储层：文档 / 分片 / 段落 / 原子事实 / 摘要的 CRUD + FTS5 索引管理。
 *
 * 设计原则：
 * - 与 MemoryNodeStore 保持一致的 better-sqlite3 同步 API 风格
 * - 每个粒度层有独立的 FTS5 索引（trigram 分词，external content 表，触发器自动同步）
 * - SHA-256 content hash 去重：相同内容不重复索引
 */
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeParagraph,
  KnowledgeProposition,
  KnowledgeSourceType,
  KnowledgeSummary,
  PropositionType,
  SourcePattern
} from './types.js'

export class KnowledgeStore {
  constructor(readonly db: Database.Database) {}

  private now(): string {
    return new Date().toISOString()
  }

  /** 计算内容 hash（SHA-256） */
  contentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex')
  }

  // ── Documents ────────────────────────────────────────────────────────────

  private parseDoc(row: Record<string, unknown>): KnowledgeDocument {
    return {
      id: String(row.id),
      sourcePath: String(row.source_path),
      sourceType: String(row.source_type) as KnowledgeSourceType,
      contentHash: String(row.content_hash),
      title: row.title ? String(row.title) : null,
      content: String(row.content),
      repositoryId: row.repository_id ? String(row.repository_id) : null,
      redacted: Number(row.redacted) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  /** 创建或更新文档（按 sourcePath + repositoryId 去重；content hash 不变则跳过） */
  upsertDocument(input: {
    sourcePath: string
    sourceType: KnowledgeSourceType
    content: string
    title?: string | null
    repositoryId?: string | null
    redacted?: boolean
  }): { document: KnowledgeDocument; changed: boolean } {
    const hash = this.contentHash(input.content)
    const existing = this.db
      .prepare('SELECT * FROM knowledge_documents WHERE source_path = ? AND repository_id IS ?')
      .get(input.sourcePath, input.repositoryId ?? null) as Record<string, unknown> | undefined

    if (existing) {
      if (String(existing.content_hash) === hash) {
        return { document: this.parseDoc(existing), changed: false }
      }
      const now = this.now()
      this.db
        .prepare(
          `
        UPDATE knowledge_documents SET content=@content, content_hash=@hash, title=@title,
          redacted=@redacted, updated_at=@updatedAt
        WHERE id=@id
      `
        )
        .run({
          id: String(existing.id),
          content: input.content,
          hash,
          title: input.title ?? null,
          redacted: input.redacted !== false ? 1 : 0,
          updatedAt: now
        })
      // 删除旧的粒度数据（chunker 会重新生成）
      this.deleteGranularData(String(existing.id))
      return {
        document: { ...this.parseDoc(existing), content: input.content, contentHash: hash, updatedAt: now },
        changed: true
      }
    }

    const now = this.now()
    const doc: KnowledgeDocument = {
      id: randomUUID(),
      sourcePath: input.sourcePath,
      sourceType: input.sourceType,
      contentHash: hash,
      title: input.title ?? null,
      content: input.content,
      repositoryId: input.repositoryId ?? null,
      redacted: input.redacted !== false,
      createdAt: now,
      updatedAt: now
    }
    this.db
      .prepare(
        `
      INSERT INTO knowledge_documents (id, source_path, source_type, content_hash, title, content, repository_id, redacted, created_at, updated_at)
      VALUES (@id, @sourcePath, @sourceType, @contentHash, @title, @content, @repositoryId, @redacted, @createdAt, @updatedAt)
    `
      )
      .run({
        ...doc,
        redacted: doc.redacted ? 1 : 0
      })
    return { document: doc, changed: true }
  }

  /** 删除文档及其所有粒度数据 */
  deleteDocument(id: string): void {
    this.deleteGranularData(id)
    this.db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id)
  }

  /** 按 repositoryId 删除所有文档 */
  deleteByRepository(repositoryId: string): number {
    const docs = this.db
      .prepare('SELECT id FROM knowledge_documents WHERE repository_id = ?')
      .all(repositoryId) as Array<{ id: string }>
    for (const doc of docs) this.deleteGranularData(doc.id)
    return this.db.prepare('DELETE FROM knowledge_documents WHERE repository_id = ?').run(repositoryId).changes
  }

  /** 获取文档 */
  getDocument(id: string): KnowledgeDocument | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.parseDoc(row) : undefined
  }

  /** 按 hash 检查文档是否已存在 */
  hasDocumentWithHash(hash: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM knowledge_documents WHERE content_hash = ? LIMIT 1').get(hash)
    return !!row
  }

  /** 列出仓库的所有文档 */
  listDocuments(repositoryId: string): KnowledgeDocument[] {
    return (
      this.db
        .prepare('SELECT * FROM knowledge_documents WHERE repository_id = ? ORDER BY source_path')
        .all(repositoryId) as Record<string, unknown>[]
    ).map((r) => this.parseDoc(r))
  }

  // ── Chunks ───────────────────────────────────────────────────────────────

  private parseChunk(row: Record<string, unknown>): KnowledgeChunk {
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      content: String(row.content),
      tokenCount: row.token_count != null ? Number(row.token_count) : null,
      startLine: row.start_line != null ? Number(row.start_line) : null,
      endLine: row.end_line != null ? Number(row.end_line) : null,
      symbolNames: row.symbol_names ? JSON.parse(String(row.symbol_names)) : null
    }
  }

  /** 批量写入 chunks（FTS 索引由触发器同步） */
  insertChunks(chunks: Array<Omit<KnowledgeChunk, 'id'>>): KnowledgeChunk[] {
    const insertStmt = this.db.prepare(`
      INSERT INTO knowledge_chunks (id, document_id, content, token_count, start_line, end_line, symbol_names)
      VALUES (@id, @documentId, @content, @tokenCount, @startLine, @endLine, @symbolNames)
    `)

    const results: KnowledgeChunk[] = []
    for (const chunk of chunks) {
      const id = randomUUID()
      insertStmt.run({
        id,
        documentId: chunk.documentId,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbolNames: chunk.symbolNames ? JSON.stringify(chunk.symbolNames) : null
      })
      results.push({ ...chunk, id })
    }
    return results
  }

  /** 获取文档的所有 chunks */
  listChunks(documentId: string): KnowledgeChunk[] {
    return (
      this.db
        .prepare('SELECT * FROM knowledge_chunks WHERE document_id = ? ORDER BY start_line')
        .all(documentId) as Record<string, unknown>[]
    ).map((r) => this.parseChunk(r))
  }

  // ── Paragraphs ───────────────────────────────────────────────────────────

  private parseParagraph(row: Record<string, unknown>): KnowledgeParagraph {
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      content: String(row.content),
      headingPath: row.heading_path ? String(row.heading_path) : null,
      tokenCount: row.token_count != null ? Number(row.token_count) : null
    }
  }

  insertParagraphs(paragraphs: Array<Omit<KnowledgeParagraph, 'id'>>): KnowledgeParagraph[] {
    const insertStmt = this.db.prepare(`
      INSERT INTO knowledge_paragraphs (id, document_id, content, heading_path, token_count)
      VALUES (@id, @documentId, @content, @headingPath, @tokenCount)
    `)

    const results: KnowledgeParagraph[] = []
    for (const para of paragraphs) {
      const id = randomUUID()
      insertStmt.run({
        id,
        documentId: para.documentId,
        content: para.content,
        headingPath: para.headingPath,
        tokenCount: para.tokenCount
      })
      results.push({ ...para, id })
    }
    return results
  }

  listParagraphs(documentId: string): KnowledgeParagraph[] {
    return (
      this.db.prepare('SELECT * FROM knowledge_paragraphs WHERE document_id = ?').all(documentId) as Record<
        string,
        unknown
      >[]
    ).map((r) => this.parseParagraph(r))
  }

  // ── Propositions ─────────────────────────────────────────────────────────

  private parseProposition(row: Record<string, unknown>): KnowledgeProposition {
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      paragraphId: row.paragraph_id ? String(row.paragraph_id) : null,
      content: String(row.content),
      propositionType: String(row.proposition_type) as PropositionType,
      sourcePattern: String(row.source_pattern) as SourcePattern
    }
  }

  insertPropositions(propositions: Array<Omit<KnowledgeProposition, 'id'>>): KnowledgeProposition[] {
    const insertStmt = this.db.prepare(`
      INSERT INTO knowledge_propositions (id, document_id, paragraph_id, content, proposition_type, source_pattern)
      VALUES (@id, @documentId, @paragraphId, @content, @propositionType, @sourcePattern)
    `)

    const results: KnowledgeProposition[] = []
    for (const prop of propositions) {
      const id = randomUUID()
      insertStmt.run({
        id,
        documentId: prop.documentId,
        paragraphId: prop.paragraphId,
        content: prop.content,
        propositionType: prop.propositionType,
        sourcePattern: prop.sourcePattern
      })
      results.push({ ...prop, id })
    }
    return results
  }

  listPropositions(documentId: string): KnowledgeProposition[] {
    return (
      this.db.prepare('SELECT * FROM knowledge_propositions WHERE document_id = ?').all(documentId) as Record<
        string,
        unknown
      >[]
    ).map((r) => this.parseProposition(r))
  }

  // ── Summaries ────────────────────────────────────────────────────────────

  private parseSummary(row: Record<string, unknown>): KnowledgeSummary {
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      content: String(row.content),
      keySymbols: row.key_symbols ? JSON.parse(String(row.key_symbols)) : null,
      tokenCount: row.token_count != null ? Number(row.token_count) : null
    }
  }

  insertSummaries(summaries: Array<Omit<KnowledgeSummary, 'id'>>): KnowledgeSummary[] {
    const insertStmt = this.db.prepare(`
      INSERT INTO knowledge_summaries (id, document_id, content, key_symbols, token_count)
      VALUES (@id, @documentId, @content, @keySymbols, @tokenCount)
    `)

    const results: KnowledgeSummary[] = []
    for (const summary of summaries) {
      const id = randomUUID()
      insertStmt.run({
        id,
        documentId: summary.documentId,
        content: summary.content,
        keySymbols: summary.keySymbols ? JSON.stringify(summary.keySymbols) : null,
        tokenCount: summary.tokenCount
      })
      results.push({ ...summary, id })
    }
    return results
  }

  listSummaries(documentId: string): KnowledgeSummary[] {
    return (
      this.db.prepare('SELECT * FROM knowledge_summaries WHERE document_id = ?').all(documentId) as Record<
        string,
        unknown
      >[]
    ).map((r) => this.parseSummary(r))
  }

  // ── FTS5 检索 ────────────────────────────────────────────────────────────

  /** 将关键词数组转成 FTS5 MATCH 表达式 */
  private ftsQuery(keywords: string[]): string {
    const cleaned = keywords.map((kw) => kw.trim().replace(/"/g, '""')).filter((kw) => kw.length > 0)
    if (!cleaned.length) return ''
    return cleaned.map((kw) => (kw.length <= 2 ? `"${kw}"` : `"${kw}"*`)).join(' OR ')
  }

  /**
   * 拼装 FTS 检索 SQL：命中关键词 + 可选按文档归属仓库过滤。
   * 不传 repositoryIds 时返回所有仓库的命中（跨仓库串扰），多仓库查询方应显式传入。
   */
  private buildFtsSearch(
    ftsTable: 'knowledge_propositions_fts' | 'knowledge_paragraphs_fts' | 'knowledge_chunks_fts',
    baseTable: 'knowledge_propositions' | 'knowledge_paragraphs' | 'knowledge_chunks',
    alias: string,
    repositoryIds?: string[]
  ): string {
    const repoFilter = repositoryIds?.length
      ? `JOIN knowledge_documents kd ON kd.id = ${alias}.document_id AND kd.repository_id IN (${repositoryIds.map(() => '?').join(',')})`
      : ''
    return `
      SELECT ${alias}.*, CAST(-bm25(${ftsTable}) * 100 AS INTEGER) AS score
      FROM ${ftsTable}
      JOIN ${baseTable} ${alias} ON ${alias}.rowid = ${ftsTable}.rowid
      ${repoFilter}
      WHERE ${ftsTable} MATCH ?
      ORDER BY score DESC LIMIT ?
    `
  }

  /** FTS5 检索 propositions */
  searchPropositions(
    keywords: string[],
    limit = 10,
    repositoryIds?: string[]
  ): Array<KnowledgeProposition & { score: number }> {
    const query = this.ftsQuery(keywords)
    if (!query) return []
    const rows = this.db
      .prepare(this.buildFtsSearch('knowledge_propositions_fts', 'knowledge_propositions', 'kp', repositoryIds))
      .all(...(repositoryIds ?? []), query, limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({ ...this.parseProposition(r), score: Number(r.score) }))
  }

  /** FTS5 检索 paragraphs */
  searchParagraphs(
    keywords: string[],
    limit = 10,
    repositoryIds?: string[]
  ): Array<KnowledgeParagraph & { score: number }> {
    const query = this.ftsQuery(keywords)
    if (!query) return []
    const rows = this.db
      .prepare(this.buildFtsSearch('knowledge_paragraphs_fts', 'knowledge_paragraphs', 'kpar', repositoryIds))
      .all(...(repositoryIds ?? []), query, limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({ ...this.parseParagraph(r), score: Number(r.score) }))
  }

  /** FTS5 检索 chunks */
  searchChunks(keywords: string[], limit = 10, repositoryIds?: string[]): Array<KnowledgeChunk & { score: number }> {
    const query = this.ftsQuery(keywords)
    if (!query) return []
    const rows = this.db
      .prepare(this.buildFtsSearch('knowledge_chunks_fts', 'knowledge_chunks', 'kc', repositoryIds))
      .all(...(repositoryIds ?? []), query, limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({ ...this.parseChunk(r), score: Number(r.score) }))
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** 删除某个文档的所有粒度数据（FTS 索引为 external content 表，由触发器同步，无残留错配） */
  private deleteGranularData(documentId: string): void {
    this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(documentId)
    this.db.prepare('DELETE FROM knowledge_paragraphs WHERE document_id = ?').run(documentId)
    this.db.prepare('DELETE FROM knowledge_propositions WHERE document_id = ?').run(documentId)
    this.db.prepare('DELETE FROM knowledge_summaries WHERE document_id = ?').run(documentId)
  }
}
