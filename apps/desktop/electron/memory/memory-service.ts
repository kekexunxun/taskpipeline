import { randomUUID } from 'node:crypto'
import type {
  Memory,
  MemoryScope,
  MemorySearchHit,
  RepoWikiDoc,
  RepoWikiSearchHit,
  TaskStore
} from '@task-pipeline/core'
import {
  MemoryEngine,
  splitMarkdown,
  extractPropositionsFromMarkdown,
  type MemoryNode,
  type MemoryNodeType,
  type KnowledgeDocument
} from '@task-pipeline/memory'
import { collectRepoWikiDocs } from '../repowiki/indexer.js'
import type { ExtractedMemoryDraft } from './memory-extractor.js'
import { fallbackKeywords } from './memory-keyword-extractor.js'

const CONTEXT_LIMIT = 4000
const DEFAULT_LIMIT = 5

export function renderMemoryContext(memories: MemorySearchHit[], wikiDocs: RepoWikiSearchHit[]): string | undefined {
  const sections: string[] = []
  if (memories.length)
    sections.push(
      `## 记忆上下文\n${memories.map((m) => `- [${m.scope}] ${m.title}: ${m.content.slice(0, 300)}`).join('\n')}`
    )
  if (wikiDocs.length)
    sections.push(
      `## 仓库 Wiki 文档(repowiki)\n${wikiDocs.map((doc) => `- ${doc.path}: ${doc.content.slice(0, 300)}`).join('\n')}`
    )
  if (!sections.length) return undefined
  const text = `以下是与当前任务相关的长期记忆与仓库文档。应优先遵循其中的工程约定；若与用户最新指令冲突,以用户指令为准。\n\n${sections.join('\n\n')}\n\n请使用中文回复用户。`
  return text.length > CONTEXT_LIMIT ? `${text.slice(0, CONTEXT_LIMIT)}\n…(记忆过长已截断)` : text
}

/** 关键词回退器：rewriter 不可用 / 抛错 / 返回空时,基于 query 字符串本身挤关键词。 */
export type KeywordFallback = (query: string) => string[]

export type MemoryContextOptions = {
  userId?: string
  repositoryIds?: string[]
  conversationId?: string
  query: string
  limit?: number
  /** 关键词回退器（兜底）。默认 `fallbackKeywords`（基于空白切 + CJK n-gram）。 */
  keywordFallback?: KeywordFallback
}

/** 检索结果,带 `keywords` 方便上层/dev probe 展示"实际拿去查的词"。 */
export type MemorySearchResult = { memories: MemorySearchHit[]; wikiDocs: RepoWikiSearchHit[]; keywords: string[] }

/** 受保护的 MemoryNode 类型集合 */
const PROTECTED_TYPES: readonly MemoryNodeType[] = ['constraint', 'security_rule', 'architecture', 'decision']

/** 参与检索的活跃 + 降权状态 */
const SEARCHABLE_STATUSES = ['active', 'compacted', 'stale'] as const

export class MemoryService {
  private readonly engine: MemoryEngine

  constructor(private readonly store: TaskStore) {
    this.engine = new MemoryEngine(store.db)
  }

  getEngine(): MemoryEngine {
    return this.engine
  }

  ensureUserId(): string {
    const existing = this.store.getSetting('memoryUserId')
    if (existing) return existing
    const id = randomUUID()
    this.store.setSetting('memoryUserId', id)
    return id
  }

  // ── CRUD（MemoryNodeStore，返回旧 Memory 类型保持接口兼容） ────────────────

  listMemories(
    filter: { scope?: MemoryScope; scopes?: MemoryScope[]; repositoryId?: string; conversationId?: string } = {}
  ): Memory[] {
    const nodes = this.engine.memoryNodes.list({
      ...filter,
      userId: this.ensureUserId(),
      statuses: ['active', 'candidate', 'stale', 'compacted']
    })
    return nodes.map((node) => this.nodeToMemory(node))
  }

  upsertMemory(input: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Memory {
    if (input.id) {
      const existing = this.engine.memoryNodes.get(input.id)
      if (existing) {
        const updated = this.engine.memoryNodes.update(input.id, {
          title: input.title,
          summary: input.content,
          tags: input.tags,
          importance: input.importance,
          status: input.pinned ? 'active' : 'candidate'
        })
        return this.nodeToMemory(updated)
      }
    }
    const nodeType = inferNodeType(input.tags ?? [])
    const node = this.engine.memoryNodes.create({
      nodeType,
      title: input.title,
      summary: input.content,
      scope: input.scope,
      userId: input.userId ?? this.ensureUserId(),
      repositoryId: input.repositoryId,
      conversationId: input.conversationId,
      status: input.pinned ? 'active' : 'candidate',
      importance: input.importance,
      tags: input.tags,
      source: input.source === 'imported' ? 'seed' : input.source
    })
    return this.nodeToMemory(node)
  }

  updateMemory(id: string, patch: Partial<Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>>): Memory {
    const node = this.engine.memoryNodes.update(id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { summary: patch.content } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
      ...(patch.status !== undefined ? { status: patch.status as MemoryNode['status'] } : {}),
      ...(patch.pinned !== undefined && patch.status === undefined
        ? { status: patch.pinned ? 'active' : 'candidate' }
        : {})
    })
    return this.nodeToMemory(node)
  }

  deleteMemory(id: string): void {
    const node = this.engine.memoryNodes.get(id)
    if (node) {
      if (PROTECTED_TYPES.includes(node.nodeType)) {
        try {
          this.engine.memoryNodes.update(id, { status: 'archived' })
        } catch {
          this.engine.memoryNodes.delete(id)
        }
      } else {
        this.engine.memoryNodes.delete(id)
      }
    }
  }

  deleteRepoMemories(repositoryId: string): void {
    this.engine.memoryNodes.deleteMany({ repositoryId })
    this.engine.knowledge.deleteByRepository(repositoryId)
  }

  deleteConversationMemories(conversationId: string): void {
    this.engine.memoryNodes.deleteMany({ conversationId })
  }

  // ── Wiki（KnowledgeStore 多粒度流水线） ────────────────────────────────────

  listRepoWikiDocs(repositoryId: string): RepoWikiDoc[] {
    return this.engine.knowledge.listDocuments(repositoryId).map((doc) => this.knowledgeDocToWikiDoc(doc))
  }

  searchRepoWikiDocs(repositoryId: string, query: string): RepoWikiSearchHit[] {
    const keywords = fallbackKeywords(query)
    if (!keywords.length) return []
    const cleaned = keywords.map((kw) => kw.trim().replace(/"/g, '""')).filter((kw) => kw.length > 0)
    if (!cleaned.length) return []
    const ftsMatch = cleaned.map((kw) => (kw.length <= 2 ? `"${kw}"` : `"${kw}"*`)).join(' OR ')

    const rows = this.store.db
      .prepare(
        `SELECT kp.content, kp.id AS paragraph_id, kd.id AS doc_id, kd.source_path, kd.title, kd.repository_id,
                kd.content_hash, kd.created_at, kd.updated_at,
                CAST(-bm25(knowledge_paragraphs_fts) * 100 AS INTEGER) AS score
         FROM knowledge_paragraphs_fts
         JOIN knowledge_paragraphs kp ON kp.rowid = knowledge_paragraphs_fts.rowid
         JOIN knowledge_documents kd ON kd.id = kp.document_id
         WHERE knowledge_paragraphs_fts MATCH ? AND kd.repository_id = ?
         ORDER BY score DESC LIMIT ?`
      )
      .all(ftsMatch, repositoryId, 10) as Array<Record<string, unknown>>

    return rows.map((row) => ({
      id: String(row.doc_id),
      repositoryId: String(row.repository_id),
      path: String(row.source_path),
      title: row.title ? String(row.title) : '',
      content: String(row.content),
      hash: String(row.content_hash),
      updatedAt: String(row.updated_at),
      score: Number(row.score)
    }))
  }

  async refreshRepoWiki(repositoryId: string, localPath: string): Promise<{ indexed: number; removed: number }> {
    const existing = this.engine.knowledge.listDocuments(repositoryId)
    const byPath = new Map(existing.map((doc) => [doc.sourcePath, doc]))
    const files = collectRepoWikiDocs(localPath)
    let removed = 0
    for (const doc of existing) {
      if (!files.some((file) => file.path === doc.sourcePath)) {
        this.engine.knowledge.deleteDocument(doc.id)
        removed += 1
      }
    }
    let indexed = 0
    for (const file of files) {
      const prev = byPath.get(file.path)
      if (prev && prev.contentHash === this.engine.knowledge.contentHash(file.content)) continue
      if (prev) this.engine.knowledge.deleteDocument(prev.id)
      const { document } = this.engine.knowledge.upsertDocument({
        sourcePath: file.path,
        sourceType: 'markdown',
        content: file.content,
        title: file.title,
        repositoryId
      })
      const mdChunks = splitMarkdown(file.content)
      if (mdChunks.length) {
        this.engine.knowledge.insertParagraphs(
          mdChunks.map((chunk) => ({
            documentId: document.id,
            content: chunk.content,
            headingPath: chunk.headingPath,
            tokenCount: null
          }))
        )
        const props = extractPropositionsFromMarkdown(file.content)
        if (props.length) {
          this.engine.knowledge.insertPropositions(
            props.map((prop) => ({
              documentId: document.id,
              paragraphId: null,
              content: prop.content,
              propositionType: prop.propositionType,
              sourcePattern: prop.sourcePattern
            }))
          )
        }
      }
      indexed += 1
    }
    return { indexed, removed }
  }

  // ── 检索（零 LLM，FTS5 + RRF） ──────────────────────────────────────────

  async search(options: MemoryContextOptions): Promise<MemorySearchResult> {
    const limit = options.limit ?? DEFAULT_LIMIT
    const keywords = (options.keywordFallback ?? fallbackKeywords)(options.query)
    if (!keywords.length) return { memories: [], wikiDocs: [], keywords }

    // 使用 RetrievalPipeline 检索记忆（多粒度 FTS5 + RRF 融合）
    const pack = this.engine.retrieve({
      query: options.query,
      taskIntent: 'general',
      scopes: ['user', 'conversation', 'repo'],
      userId: options.userId,
      repositoryId: options.repositoryIds?.[0],
      perChannelLimit: limit
    })
    // RetrievalHit 仅含 nodeId/metadata，需查回完整 MemoryNode
    let memories: MemorySearchHit[] = pack.memories
      .map((hit) => {
        if (!hit.nodeId) return null
        const node = this.engine.memoryNodes.get(hit.nodeId)
        if (!node) return null
        return this.nodeToSearchHit({ ...node, score: hit.score })
      })
      .filter((h): h is MemorySearchHit => h !== null)

    // 对话级记忆需按 conversationId 过滤（RetrievalPipeline 不支持 conversationId 参数）
    if (options.conversationId) {
      const convHits = this.searchConversationMemories(keywords, options.conversationId, limit)
      memories = [
        ...convHits,
        ...memories.filter((m) => m.scope !== 'conversation' || m.conversationId === options.conversationId)
      ]
    }

    // 按仓库过滤并补充仓库级记忆
    if (options.repositoryIds?.length) {
      const repoSet = new Set(options.repositoryIds)
      memories = memories.filter((m) => m.scope !== 'repo' || (m.repositoryId && repoSet.has(m.repositoryId)))
    }

    // Wiki 文档检索（按仓库，保持全文档粒度）
    const wikiDocs: RepoWikiSearchHit[] = []
    for (const repositoryId of options.repositoryIds ?? []) {
      wikiDocs.push(...this.searchRepoWikiDocs(repositoryId, options.query))
    }

    return {
      memories: memories.sort((a, b) => b.score - a.score).slice(0, limit),
      wikiDocs: wikiDocs.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit >> 1)),
      keywords
    }
  }

  async buildSystemPrompt(options: MemoryContextOptions): Promise<string | undefined> {
    const { memories, wikiDocs } = await this.search(options)
    return renderMemoryContext(memories, wikiDocs)
  }

  // ── 记忆整理 + 反思晋升 ─────────────────────────────────────────────────

  consolidateMemories(drafts: ExtractedMemoryDraft[], repositoryIds: string[], conversationId: string): number {
    let saved = 0
    const batchSaved: Array<{ title: string; content: string }> = []
    const existingCache = new Map<string, Array<{ title: string; content: string }>>()
    for (const draft of drafts) {
      const tags = draft.tags ?? []
      let scope: MemoryScope
      let listKey: string
      let existing: () => Array<{ title: string; content: string }>
      if (draft.scope === 'repo') {
        const primary = repositoryIds[0]
        if (!primary) continue
        scope = 'repo'
        listKey = `repo:${primary}`
        existing = () =>
          this.engine.memoryNodes
            .list({ scope: 'repo', repositoryId: primary })
            .map((n) => ({ title: n.title, content: n.summary ?? '' }))
      } else if (draft.scope === 'user') {
        scope = 'user'
        listKey = 'user'
        const userId = this.ensureUserId()
        existing = () =>
          this.engine.memoryNodes
            .list({ scope: 'user', userId })
            .map((n) => ({ title: n.title, content: n.summary ?? '' }))
      } else {
        scope = 'conversation'
        listKey = `conversation:${conversationId}`
        existing = () =>
          this.engine.memoryNodes
            .list({ scope: 'conversation', conversationId })
            .map((n) => ({ title: n.title, content: n.summary ?? '' }))
      }
      if (!existingCache.has(listKey)) {
        existingCache.set(
          listKey,
          existing().map((m) => ({ title: m.title, content: m.content }))
        )
      }
      const stored = existingCache.get(listKey)!
      if (stored.some((m) => isDuplicateMemory(m, draft)) || batchSaved.some((m) => isDuplicateMemory(m, draft))) {
        continue
      }
      const userId = this.ensureUserId()
      const nodeType = inferNodeType(tags)
      const node = this.engine.memoryNodes.create({
        nodeType,
        title: draft.title,
        summary: draft.content,
        scope,
        ...(scope === 'repo' ? { repositoryId: repositoryIds[0] } : {}),
        ...(scope === 'user' ? { userId } : {}),
        ...(scope === 'conversation' ? { conversationId } : {}),
        status: 'candidate',
        importance: 0.5,
        confidence: draft.confidence ?? 0.5, // TODO: 待 ExtractedMemoryDraft 增加 confidence 字段后由 LLM 输出透传
        tags,
        source: 'auto'
      })
      // 关联证据：记录记忆来源（对话/任务）
      this.engine.evidence.create({
        memoryNodeId: node.id,
        evidenceType: 'conversation',
        sourceId: conversationId,
        content: draft.title
      })
      stored.push({ title: draft.title, content: draft.content })
      batchSaved.push({ title: draft.title, content: draft.content })
      saved += 1
    }
    // 新候选写入后自动触发反思晋升（确定性规则，无 LLM）
    if (saved > 0) {
      try {
        this.runReflection()
      } catch (error) {
        console.warn('[memory] auto-reflection failed:', error)
      }
    }
    return saved
  }

  /**
   * 反思晋升：将 candidate 节点与活跃节点做相似度比对，自动决策晋升策略。
   *
   * 确定性规则（无 LLM）：
   * - 标题相似度 > 0.8 → merge（合并内容到已有活跃节点，candidate → expired）
   * - 标题相似度 > 0.5 → merge（非受保护时合并，candidate → expired）
   * - 标题相似度 > 0.3 → supersede（非受保护时替代旧节点，旧节点 active → superseded）
   * - 否则 → promote 为 active
   *
   * 注意：candidate 只能转换到 active / expired（状态机约束）。
   *
   * 返回处理结果统计。
   */
  runReflection(): { promoted: number; merged: number; superseded: number; discarded: number } {
    const result = { promoted: 0, merged: 0, superseded: 0, discarded: 0 }
    const candidates = this.engine.memoryNodes.list({ status: 'candidate' })
    if (!candidates.length) return result
    const activeNodes = this.engine.memoryNodes.list({ statuses: ['active', 'stale'] })

    for (const candidate of candidates) {
      const bestMatch = findBestMatch(candidate, activeNodes)
      if (!bestMatch || bestMatch.similarity <= 0.3) {
        this.engine.memoryNodes.update(candidate.id, {
          status: 'active',
          confidence: Math.min(1, candidate.confidence + 0.2)
        })
        result.promoted++
      } else if (bestMatch.similarity > 0.8) {
        const mergedSummary = mergeSummaries(bestMatch.node.summary, candidate.summary)
        this.engine.memoryNodes.update(bestMatch.node.id, {
          summary: mergedSummary,
          confidence: Math.min(1, bestMatch.node.confidence + 0.1)
        })
        // candidate → expired（内容已合并到活跃节点，候选终态）
        this.engine.memoryNodes.update(candidate.id, { status: 'expired' })
        result.merged++
      } else if (bestMatch.similarity > 0.5 && !PROTECTED_TYPES.includes(bestMatch.node.nodeType)) {
        const mergedSummary = mergeSummaries(bestMatch.node.summary, candidate.summary)
        this.engine.memoryNodes.update(bestMatch.node.id, { summary: mergedSummary })
        // candidate → expired（内容已合并，候选终态）
        this.engine.memoryNodes.update(candidate.id, { status: 'expired' })
        result.merged++
      } else if (!PROTECTED_TYPES.includes(bestMatch.node.nodeType)) {
        // 旧活跃节点被替代：active → superseded
        this.engine.memoryNodes.update(bestMatch.node.id, { status: 'superseded' })
        // 候选晋升：candidate → active
        this.engine.memoryNodes.update(candidate.id, { status: 'active', confidence: candidate.confidence })
        result.superseded++
      } else {
        this.engine.memoryNodes.update(candidate.id, { status: 'active' })
        result.promoted++
      }
    }
    if (result.promoted + result.merged + result.superseded > 0) {
      console.info(
        `[memory] reflection: ${result.promoted} promoted, ${result.merged} merged, ${result.superseded} superseded`
      )
    }
    return result
  }

  /**
   * 生命周期维护：过期 candidate、标记 stale、归档旧节点。
   *
   * 受保护类型（constraint/architecture/decision/security_rule）豁免。
   */
  runRetention(): { expired: number; stale: number; archived: number } {
    const result = this.engine.createRetention().run()
    return { expired: result.expired.length, stale: result.markedStale.length, archived: result.archived.length }
  }

  // ── 启动迁移 ─────────────────────────────────────────────────────────────

  runLegacyMigration(): { memories: number; wikiDocs: number } | null {
    if (this.store.getSetting('memoryEngineMigrated') === 'true') {
      // 迁移标记已设置：清理可能残留的旧表（幂等操作）
      try {
        this.store.db.exec(`
          DROP TABLE IF EXISTS memories_fts;
          DROP TABLE IF EXISTS memories;
          DROP TABLE IF EXISTS repo_wiki_docs_fts;
          DROP TABLE IF EXISTS repo_wiki_docs;
        `)
      } catch {
        /* 旧表不存在或清理失败不影响正常使用 */
      }
      return null
    }

    // 迁移完成后物理删除旧表，后续启动不再处理旧数据
    this.store.setSetting('memoryEngineMigrated', 'true')
    try {
      this.store.db.exec(`
        DROP TABLE IF EXISTS memories_fts;
        DROP TABLE IF EXISTS memories;
        DROP TABLE IF EXISTS repo_wiki_docs_fts;
        DROP TABLE IF EXISTS repo_wiki_docs;
      `)
    } catch (error) {
      console.warn('[memory] failed to drop legacy tables:', error)
    }
    return null
  }

  // ── 内部辅助 ─────────────────────────────────────────────────────────────

  private nodeToMemory(node: MemoryNode): Memory {
    return {
      id: node.id,
      scope: node.scope,
      userId: node.userId ?? undefined,
      repositoryId: node.repositoryId ?? undefined,
      conversationId: node.conversationId ?? undefined,
      title: node.title,
      content: node.summary ?? '',
      tags: node.tags,
      pinned: node.status === 'active',
      importance: node.importance,
      source: node.source === 'seed' ? 'imported' : node.source,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      nodeType: node.nodeType,
      status: node.status,
      confidence: node.confidence
    }
  }

  private knowledgeDocToWikiDoc(doc: KnowledgeDocument): RepoWikiDoc {
    return {
      id: doc.id,
      repositoryId: doc.repositoryId ?? '',
      path: doc.sourcePath,
      title: doc.title ?? '',
      content: doc.content,
      hash: doc.contentHash,
      updatedAt: doc.updatedAt
    }
  }

  private searchMemoriesByScope(
    keywords: string[],
    input: { scopes: MemoryScope[]; userId?: string; repositoryId?: string; conversationId?: string; limit?: number }
  ): MemorySearchHit[] {
    if (input.scopes.includes('conversation') && input.conversationId) {
      const convHits = this.searchConversationMemories(keywords, input.conversationId, input.limit ?? 5)
      const otherScopes = input.scopes.filter((s) => s !== 'conversation')
      if (otherScopes.length) {
        const otherHits = this.engine.memoryNodes.searchFts({
          keywords,
          scopes: otherScopes,
          userId: input.userId,
          repositoryId: input.repositoryId,
          limit: input.limit
        })
        return [...convHits, ...otherHits.map((n) => this.nodeToSearchHit(n))]
      }
      return convHits
    }
    const nodes = this.engine.memoryNodes.searchFts({
      keywords,
      scopes: input.scopes,
      userId: input.userId,
      repositoryId: input.repositoryId,
      limit: input.limit
    })
    return nodes.map((n) => this.nodeToSearchHit(n))
  }

  private searchConversationMemories(keywords: string[], conversationId: string, limit: number): MemorySearchHit[] {
    const cleaned = keywords.map((kw) => kw.trim().replace(/"/g, '""')).filter((kw) => kw.length > 0)
    if (!cleaned.length) return []
    const query = cleaned.map((kw) => (kw.length <= 2 ? `"${kw}"` : `"${kw}"*`)).join(' OR ')
    const statusList = SEARCHABLE_STATUSES
    const rows = this.store.db
      .prepare(
        `SELECT memory_nodes.*, CAST(-bm25(memory_nodes_fts) * 100 AS INTEGER) AS score
         FROM memory_nodes_fts
         JOIN memory_nodes ON memory_nodes.rowid = memory_nodes_fts.rowid
         WHERE memory_nodes_fts MATCH ?
           AND memory_nodes.scope = 'conversation'
           AND memory_nodes.conversation_id = ?
           AND memory_nodes.status IN (${statusList.map(() => '?').join(',')})
         ORDER BY score DESC LIMIT ?`
      )
      .all(query, conversationId, ...statusList, Math.min(limit, 50)) as Array<Record<string, unknown>>
    return rows.map((row) => ({ ...this.nodeToMemory(parseNodeRow(row)), score: Number(row.score) }))
  }

  private nodeToSearchHit(node: MemoryNode & { score: number }): MemorySearchHit {
    return { ...this.nodeToMemory(node), score: node.score }
  }
}

// ── 模块级辅助函数 ───────────────────────────────────────────────────────────

function parseNodeRow(row: Record<string, unknown>): MemoryNode {
  return {
    id: String(row.id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    nodeType: String(row.node_type) as MemoryNodeType,
    title: String(row.title),
    summary: row.summary ? String(row.summary) : null,
    status: String(row.status) as MemoryNode['status'],
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    scope: String(row.scope) as MemoryScope,
    userId: row.user_id ? String(row.user_id) : null,
    repositoryId: row.repository_id ? String(row.repository_id) : null,
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    branchName: row.branch_name ? String(row.branch_name) : null,
    metadata: row.metadata ? JSON.parse(String(row.metadata)) : null,
    tags: JSON.parse(String(row.tags ?? '[]')),
    source: String(row.source) as MemoryNode['source'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function inferNodeType(tags: string[]): MemoryNodeType {
  const lowerTags = tags.map((t) => t.toLowerCase())
  if (lowerTags.some((t) => t.includes('constraint') || t.includes('rule') || t.includes('must'))) return 'constraint'
  if (lowerTags.some((t) => t.includes('arch') || t.includes('design') || t.includes('pattern'))) return 'architecture'
  if (lowerTags.some((t) => t.includes('decision') || t.includes('decided') || t.includes('chosen'))) return 'decision'
  if (lowerTags.some((t) => t.includes('incident') || t.includes('bug') || t.includes('error'))) return 'incident'
  if (lowerTags.some((t) => t.includes('procedure') || t.includes('step') || t.includes('how'))) return 'procedure'
  if (lowerTags.some((t) => t.includes('module') || t.includes('component'))) return 'module'
  if (lowerTags.some((t) => t.includes('security') || t.includes('auth'))) return 'security_rule'
  return 'procedure'
}

/** 标题词集 Jaccard 相似度 */
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))
  if (!wordsA.size || !wordsB.size) return 0
  let intersection = 0
  for (const w of wordsA) if (wordsB.has(w)) intersection++
  return intersection / (wordsA.size + wordsB.size - intersection)
}

function findBestMatch(
  candidate: MemoryNode,
  activeNodes: MemoryNode[]
): { node: MemoryNode; similarity: number } | null {
  let best: { node: MemoryNode; similarity: number } | null = null
  for (const node of activeNodes) {
    const sim = titleSimilarity(candidate.title, node.title)
    if (!best || sim > best.similarity) best = { node, similarity: sim }
  }
  return best
}

function mergeSummaries(existing: string | null, incoming: string | null): string {
  if (!existing) return incoming ?? ''
  if (!incoming) return existing
  if (existing.includes(incoming) || incoming.includes(existing))
    return existing.length >= incoming.length ? existing : incoming
  return `${existing}\n${incoming}`
}

function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function trigrams(text: string): Set<string> {
  const set = new Set<string>()
  const n = text.length >= 3 ? 3 : 2
  for (let i = 0; i + n <= text.length; i += 1) set.add(text.slice(i, i + n))
  return set
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const gram of a) if (b.has(gram)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function isDuplicateMemory(
  existing: { title: string; content: string },
  draft: { title: string; content: string }
): boolean {
  const titleA = normalizeForDedupe(existing.title)
  const titleB = normalizeForDedupe(draft.title)
  if (titleA && titleA === titleB) return true
  const contentA = normalizeForDedupe(existing.content)
  const contentB = normalizeForDedupe(draft.content)
  if (!contentA || !contentB) return false
  if (contentA.includes(contentB) || contentB.includes(contentA)) return true
  return jaccard(trigrams(contentA), trigrams(contentB)) >= 0.6
}
