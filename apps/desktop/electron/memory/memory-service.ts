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
    // 管理面列出不强制 userId：repo/conversation 记忆只带各自归属字段，
    // 强制 userId 会把它们全部排除在设置页之外（单用户桌面，按 scope 展示即可）。
    const nodes = this.engine.memoryNodes.list({
      ...filter,
      statuses: ['active', 'candidate', 'stale', 'compacted']
    })
    return nodes.map((node) => this.nodeToMemory(node))
  }

  upsertMemory(input: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Memory {
    if (input.id) {
      const existing = this.engine.memoryNodes.get(input.id)
      if (existing) {
        // 编辑不再用 pinned 改写生命周期状态；置顶是独立的展示优先级，存在 metadata.pinned。
        const updated = this.engine.memoryNodes.update(input.id, {
          title: input.title,
          summary: input.content,
          tags: input.tags,
          importance: input.importance,
          metadata: { ...(existing.metadata ?? {}), pinned: input.pinned }
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
      // 手工新增是用户显式动作，直接 active 参与检索；只有自动提取的草稿才进 candidate 池。
      status: 'active',
      importance: input.importance,
      tags: input.tags,
      metadata: input.pinned ? { pinned: true } : null,
      source: input.source === 'imported' ? 'seed' : input.source
    })
    return this.nodeToMemory(node)
  }

  updateMemory(id: string, patch: Partial<Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>>): Memory {
    const current = this.engine.memoryNodes.get(id)
    if (!current) throw new Error(`MemoryNode not found: ${id}`)
    const nextScope = patch.scope
    const metadata = patch.pinned !== undefined ? { ...(current.metadata ?? {}), pinned: patch.pinned } : undefined
    const updated = this.engine.memoryNodes.update(id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { summary: patch.content } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
      ...(patch.status !== undefined ? { status: patch.status as MemoryNode['status'] } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      // 作用域 / 归属字段允许修正（此前静默丢弃，UI 改了不生效）：
      ...(nextScope !== undefined ? { scope: nextScope } : {}),
      ...(nextScope !== undefined ? this.scopeOwnerPatch(current, nextScope, patch) : {})
    })
    return this.nodeToMemory(updated)
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

    // OR 可见性契约：user/repo/conversation 各自命中自己的归属字段，repo 支持多仓库。
    // （旧实现把 userId + repositoryIds[0] 平铺 AND，把只带单一身份字段的自动写入记忆全部排除在外。）
    const pack = this.engine.retrieve({
      query: options.query,
      taskIntent: 'general',
      visibility: {
        userId: options.userId,
        repositoryIds: options.repositoryIds,
        conversationId: options.conversationId
      },
      repositoryIds: options.repositoryIds,
      perChannelLimit: limit
    })
    // RetrievalHit 仅含 nodeId/metadata，需查回完整 MemoryNode
    const memories: MemorySearchHit[] = pack.memories
      .map((hit) => {
        if (!hit.nodeId) return null
        const node = this.engine.memoryNodes.get(hit.nodeId)
        if (!node) return null
        return this.nodeToSearchHit({ ...node, score: hit.score })
      })
      .filter((h): h is MemorySearchHit => h !== null)

    // Wiki 文档检索（按仓库，保持全文档粒度）
    const wikiDocs: RepoWikiSearchHit[] = []
    for (const repositoryId of options.repositoryIds ?? []) {
      wikiDocs.push(...this.searchRepoWikiDocs(repositoryId, options.query))
    }

    // 置顶记忆优先注入（与设置页「置顶记忆在注入排序中优先」的契约一致）
    const ranked = memories.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.score - a.score)
    return {
      memories: ranked.slice(0, limit),
      wikiDocs: wikiDocs.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit >> 1)),
      keywords
    }
  }

  async buildSystemPrompt(options: MemoryContextOptions): Promise<string | undefined> {
    const { memories, wikiDocs } = await this.search(options)
    return renderMemoryContext(memories, wikiDocs)
  }

  // ── 记忆整理 + 反思晋升 ─────────────────────────────────────────────────

  consolidateMemories(
    drafts: ExtractedMemoryDraft[],
    repositoryIds: string[],
    conversationId: string,
    opts?: { validation?: 'implementation' }
  ): number {
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
        source: 'auto',
        // 任务实现阶段（验证前）提取的结论打标，反思阶段暂不晋升，
        // 任务 completed 后由 verifyTaskMemories 翻转并批量晋升。
        ...(opts?.validation ? { metadata: { validation: opts.validation } } : {})
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
   * 匹配只在同归属分区内进行（同 scope 且同仓库/同对话/同用户）：
   * 不同仓库的同名约定是两个事实，跨分区合并会互相污染。
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
    const activeByPartition = new Map<string, MemoryNode[]>()
    for (const node of activeNodes) {
      const key = partitionKey(node)
      const list = activeByPartition.get(key)
      if (list) list.push(node)
      else activeByPartition.set(key, [node])
    }

    for (const candidate of candidates) {
      // 实现阶段结论延迟晋升：未经验证不进入 active，避免错误结论污染检索。
      if (candidate.metadata?.validation === 'implementation') continue
      const peers = activeByPartition.get(partitionKey(candidate)) ?? []
      const bestMatch = findBestMatch(candidate, peers)
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

  /**
   * 记录检索命中（效果反馈数据层）：search_memory 工具每次把命中的记忆
   * 喂给模型时落一条 evidence（type='retrieval_hit'，source_id = 对话 id /
   * `task:${taskId}`，content = 查询文本）。后续任务验证通过时由
   * verifyTaskMemories 把这些节点关联为 outcome_verified 正向证据。
   */
  recordRetrievalHits(memoryIds: string[], sourceId: string, query: string): number {
    let recorded = 0
    for (const id of memoryIds) {
      const node = this.engine.memoryNodes.get(id)
      if (!node) continue
      this.engine.evidence.create({
        memoryNodeId: id,
        evidenceType: 'retrieval_hit',
        sourceId,
        content: query.slice(0, 200)
      })
      recorded += 1
    }
    return recorded
  }

  /**
   * 任务验证通过：把该任务留下的「实现阶段结论」翻转为 verified 并晋升。
   *
   * 任务在实现收尾（测试之前）就整理记忆，提取的结论尚未经验证，落库时打
   * metadata.validation='implementation' 标记，反思阶段暂不晋升；任务
   * completed 时经证据链（source_id = `task:${taskId}`）找到这些节点，翻转
   * 为 'verified' 后立即参与晋升。failed/cancelled 任务保持暂缓（留给手动处理）。
   *
   * 同时完成效果反馈闭环：任务期间被检索命中（retrieval_hit）的记忆获得
   * outcome_verified 正向证据，供后续重排/治理分析“哪些记忆真的帮上了忙”。
   */
  verifyTaskMemories(taskId: string): number {
    const sourceId = `task:${taskId}`
    const links = this.engine.evidence.listBySourceId(sourceId)
    let flipped = 0
    const hitNodeIds = new Set<string>()
    for (const link of links) {
      if (link.evidenceType === 'retrieval_hit') hitNodeIds.add(link.memoryNodeId)
      const node = this.engine.memoryNodes.get(link.memoryNodeId)
      if (!node || node.metadata?.validation !== 'implementation') continue
      this.engine.memoryNodes.update(node.id, {
        metadata: { ...(node.metadata ?? {}), validation: 'verified' }
      })
      flipped += 1
    }
    // 验证事件关联为证据：本次任务用过（命中且实际存在）的记忆各记一条正向信号
    for (const nodeId of hitNodeIds) {
      if (!this.engine.memoryNodes.get(nodeId)) continue
      this.engine.evidence.create({
        memoryNodeId: nodeId,
        evidenceType: 'outcome_verified',
        sourceId,
        content: '所在任务验证通过（completed），该记忆曾被检索命中'
      })
    }
    if (flipped > 0) {
      try {
        this.runReflection()
      } catch (error) {
        console.warn('[memory] post-verify reflection failed:', error)
      }
    }
    return flipped
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
      // 置顶是独立于生命周期的展示优先级（存在 metadata），不再与 status='active' 互相映射
      pinned: Boolean(node.metadata?.pinned),
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

  /** 作用域切换时清理与新 scope 不符的归属字段（可见性契约按 scope 分支命中）。 */
  private scopeOwnerPatch(
    current: MemoryNode,
    scope: MemoryScope,
    patch: { userId?: string; repositoryId?: string; conversationId?: string }
  ): { userId: string | null; repositoryId: string | null; conversationId: string | null } {
    if (scope === 'user') {
      return {
        userId: patch.userId ?? current.userId ?? this.ensureUserId(),
        repositoryId: patch.repositoryId ?? null,
        conversationId: patch.conversationId ?? null
      }
    }
    if (scope === 'repo') {
      const repositoryId = patch.repositoryId ?? (current.scope === 'repo' ? current.repositoryId : null)
      if (!repositoryId) throw new Error('仓库级记忆必须选择所属仓库')
      return { userId: null, repositoryId, conversationId: null }
    }
    const conversationId = patch.conversationId ?? (current.scope === 'conversation' ? current.conversationId : null)
    if (!conversationId) throw new Error('对话级记忆缺少所属对话')
    return { userId: null, repositoryId: null, conversationId }
  }

  private nodeToSearchHit(node: MemoryNode & { score: number }): MemorySearchHit {
    return { ...this.nodeToMemory(node), score: node.score }
  }
}

// ── 模块级辅助函数 ───────────────────────────────────────────────────────────

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

/** 反思匹配分区：只有同 scope 且同归属字段的节点才允许互并/互替 */
function partitionKey(node: MemoryNode): string {
  if (node.scope === 'repo') return `repo:${node.repositoryId ?? ''}`
  if (node.scope === 'conversation') return `conversation:${node.conversationId ?? ''}`
  return `user:${node.userId ?? ''}`
}

/** 标题相似度：词集 Jaccard 与字符 n-gram Jaccard 取大（CJK 标题无空格，纯词切分恒为 0） */
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))
  let wordSim = 0
  if (wordsA.size && wordsB.size) {
    let intersection = 0
    for (const w of wordsA) if (wordsB.has(w)) intersection++
    wordSim = intersection / (wordsA.size + wordsB.size - intersection)
  }
  const normA = normalizeForDedupe(a)
  const normB = normalizeForDedupe(b)
  const gramSim = normA && normB ? jaccard(trigrams(normA), trigrams(normB)) : 0
  return Math.max(wordSim, gramSim)
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
