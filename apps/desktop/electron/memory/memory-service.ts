import { randomUUID } from 'node:crypto'
import {
  MemoryStore,
  type Memory,
  type MemoryScope,
  type MemorySearchHit,
  type RepoWikiSearchHit,
  type TaskStore
} from '@task-pipeline/core'
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

/**
 * 关键词改写器：把原始 query 转成 FTS5 可命中的关键词数组。
 *
 * 设计动机：FTS5 已迁到 trigram + OR 合并；直接把整段 query 当单关键词丢进去
 * 召回依旧很差（长尾短语被当成一个 token,OR 合并也救不了）。生产环境注入 LLM
 * 提取器,无 LLM 时回退到 `keywordFallback`（默认空白切 + CJK n-gram）。
 */
export type KeywordRewriter = (query: string) => Promise<string[]>
/** 关键词回退器：rewriter 不可用 / 抛错 / 返回空时,基于 query 字符串本身挤关键词。 */
export type KeywordFallback = (query: string) => string[]

export type MemoryContextOptions = {
  userId?: string
  repositoryIds?: string[]
  conversationId?: string
  query: string
  limit?: number
  /**
   * 关键词改写器（首选）。生产环境会注入 LLM 提取的关键词。
   * 不提供 / 抛错 / 返回空时,回退到 `keywordFallback`（默认 `fallbackKeywords`）。
   */
  keywordRewriter?: KeywordRewriter
  /** 关键词回退器（兜底）。默认 `fallbackKeywords`（基于空白切 + CJK n-gram）。 */
  keywordFallback?: KeywordFallback
}

/** 检索结果,带 `keywords` 方便上层/dev probe 展示"实际拿去查的词"。 */
export type MemorySearchResult = { memories: MemorySearchHit[]; wikiDocs: RepoWikiSearchHit[]; keywords: string[] }

export class MemoryService {
  private readonly memory: MemoryStore

  constructor(private readonly store: TaskStore) {
    this.memory = new MemoryStore(store.db)
  }

  ensureUserId(): string {
    const existing = this.store.getSetting('memoryUserId')
    if (existing) return existing
    const id = randomUUID()
    this.store.setSetting('memoryUserId', id)
    return id
  }

  listMemories(
    filter: { scope?: MemoryScope; scopes?: MemoryScope[]; repositoryId?: string; conversationId?: string } = {}
  ): Memory[] {
    return this.memory.listMemories({ ...filter, userId: this.ensureUserId() })
  }

  upsertMemory(input: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Memory {
    if (input.id) {
      const current = this.memory.getMemory(input.id)
      if (current) return this.memory.updateMemory(input.id, input)
    }
    return this.memory.createMemory({ ...input, userId: input.userId ?? this.ensureUserId() })
  }

  updateMemory(id: string, patch: Partial<Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>>): Memory {
    return this.memory.updateMemory(id, patch)
  }
  deleteMemory(id: string): void {
    this.memory.deleteMemory(id)
  }

  deleteRepoMemories(repositoryId: string): void {
    this.memory.deleteMemories({ repositoryId })
    this.memory.clearRepoWikiDocs(repositoryId)
  }

  deleteConversationMemories(conversationId: string): void {
    this.memory.deleteMemories({ conversationId })
  }

  listRepoWikiDocs(repositoryId: string) {
    return this.memory.listRepoWikiDocs(repositoryId)
  }
  /**
   * 仓库 wiki 检索（向后兼容的同步入口，IPC/调现场用）。内部把 query 拆成关键词后查
   * FTS5；不调 LLM（避免 IPC 路径被 LLM 阻塞），走默认 fallback。
   */
  searchRepoWikiDocs(repositoryId: string, query: string): RepoWikiSearchHit[] {
    const keywords = fallbackKeywords(query)
    if (!keywords.length) return []
    return this.memory.searchRepoWikiDocs({ repositoryId, keywords, limit: 10 })
  }

  async refreshRepoWiki(repositoryId: string, localPath: string): Promise<{ indexed: number; removed: number }> {
    const existing = this.memory.listRepoWikiDocs(repositoryId)
    const byPath = new Map(existing.map((doc) => [doc.path, doc]))
    const files = collectRepoWikiDocs(localPath)
    let removed = 0
    for (const doc of existing) {
      if (!files.some((file) => file.path === doc.path)) {
        this.memory.deleteRepoWikiDoc(doc.id)
        removed += 1
      }
    }
    let indexed = 0
    for (const file of files) {
      const prev = byPath.get(file.path)
      if (prev && prev.hash === file.hash) continue
      this.memory.upsertRepoWikiDoc({
        repositoryId,
        ...(prev ? { id: prev.id } : {}),
        path: file.path,
        title: file.title,
        content: file.content,
        mtime: file.mtime,
        hash: file.hash
      })
      indexed += 1
    }
    return { indexed, removed }
  }

  /**
   * 检索（统一入口）。先用 keywordRewriter / fallback 把 query 转成关键词数组,
   * 再用关键词走 FTS5 查记忆和 wiki。返回结果里带 `keywords`,供 dev probe / 日志
   * 展示"实际拿去查的词",验证 LLM 提取是否靠谱。
   */
  async search(options: MemoryContextOptions): Promise<MemorySearchResult> {
    const limit = options.limit ?? DEFAULT_LIMIT
    const keywords = await this.resolveKeywords(options)
    if (!keywords.length) return { memories: [], wikiDocs: [], keywords }
    const memories = this.memory.searchMemories({
      keywords,
      scopes: ['user', 'conversation'],
      userId: options.userId,
      conversationId: options.conversationId,
      limit
    })
    const repoMemories: MemorySearchHit[] = []
    const wikiDocs: RepoWikiSearchHit[] = []
    for (const repositoryId of options.repositoryIds ?? []) {
      repoMemories.push(...this.memory.searchMemories({ keywords, scopes: ['repo'], repositoryId, limit: 3 }))
      wikiDocs.push(...this.memory.searchRepoWikiDocs({ repositoryId, keywords, limit: 3 }))
    }
    memories.push(...repoMemories)
    return {
      memories: memories.sort((a, b) => b.score - a.score).slice(0, limit),
      wikiDocs: wikiDocs.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit >> 1)),
      keywords
    }
  }

  /**
   * 解析关键词: 优先 keywordRewriter (生产环境由 main.ts 注入 LLM 提取器);
   * 拿不到 / 抛错 / 返回空时回退到 keywordFallback (默认 fallbackKeywords,
   * 拿原 query 拆词 + CJK n-gram)。不查不到任何关键词就返回空数组,
   * 让上层走"不检索"分支,避免给 FTS5 喂空 MATCH。
   */
  private async resolveKeywords(options: MemoryContextOptions): Promise<string[]> {
    if (options.keywordRewriter) {
      try {
        const kw = await options.keywordRewriter(options.query)
        if (kw.length) return kw
      } catch (error) {
        console.warn('[memory] keyword rewrite failed:', error)
      }
    }
    return (options.keywordFallback ?? fallbackKeywords)(options.query)
  }

  async buildSystemPrompt(options: MemoryContextOptions): Promise<string | undefined> {
    const { memories, wikiDocs } = await this.search(options)
    return renderMemoryContext(memories, wikiDocs)
  }

  consolidateMemories(drafts: ExtractedMemoryDraft[], repositoryIds: string[], conversationId: string): number {
    let saved = 0
    // 批内去重：同一回合 LLM 产出的 drafts 互相判重（先保存的作为后者的比对基准），
    // 避免标题略有差异但内容重复的条目互相放行。
    const batchSaved: Array<{ title: string; content: string }> = []
    // 同 scope 的库内清单只查一次（多 draft 共享），减少重复查询。
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
        existing = () => this.memory.listMemories({ scope: 'repo', repositoryId: primary })
      } else if (draft.scope === 'user') {
        scope = 'user'
        listKey = 'user'
        const userId = this.ensureUserId()
        existing = () => this.memory.listMemories({ scope: 'user', userId })
      } else {
        scope = 'conversation'
        listKey = `conversation:${conversationId}`
        existing = () => this.memory.listMemories({ scope: 'conversation', conversationId })
      }
      if (!existingCache.has(listKey)) {
        existingCache.set(
          listKey,
          existing().map((m) => ({ title: m.title, content: m.content }))
        )
      }
      const stored = existingCache.get(listKey)!
      // 验重：标题相等 OR 内容级相似（包含/trigram Jaccard）即跳过，避免重复内容反复入库。
      if (stored.some((m) => isDuplicateMemory(m, draft)) || batchSaved.some((m) => isDuplicateMemory(m, draft))) {
        continue
      }
      const userId = this.ensureUserId()
      this.memory.createMemory(
        scope === 'repo'
          ? {
              scope,
              repositoryId: repositoryIds[0],
              userId,
              title: draft.title,
              content: draft.content,
              tags,
              pinned: false,
              importance: 0.5,
              source: 'auto'
            }
          : scope === 'user'
            ? {
                scope,
                userId,
                title: draft.title,
                content: draft.content,
                tags,
                pinned: false,
                importance: 0.5,
                source: 'auto'
              }
            : {
                scope,
                conversationId,
                title: draft.title,
                content: draft.content,
                tags,
                pinned: false,
                importance: 0.5,
                source: 'auto'
              }
      )
      stored.push({ title: draft.title, content: draft.content })
      batchSaved.push({ title: draft.title, content: draft.content })
      saved += 1
    }
    return saved
  }
}

/** 文本归一化：小写 + 压缩全部空白（判重比较用，不影响落库内容）。 */
function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 字符级 trigram 集合（短文本用 bigram 兜底），Jaccard 相似度计算用。 */
function trigrams(text: string): Set<string> {
  const set = new Set<string>()
  const n = text.length >= 3 ? 3 : 2
  for (let i = 0; i + n <= text.length; i += 1) set.add(text.slice(i, i + n))
  return set
}

/** trigram Jaccard 相似度（0~1）；任一方为空记 0。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const gram of a) if (b.has(gram)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/**
 * 记忆判重：标题归一化相等，或内容归一化后一方完整包含另一方，
 * 或 trigram Jaccard ≥ 0.6 —— 覆盖「标题不同但内容相同/高度相似」的重复。
 */
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
