/**
 * RetrievalPipeline：零 LLM 检索流水线。
 *
 * 流程：
 * 1. query → 关键词提取（简单分词，无 LLM）
 * 2. 关键词 → MemoryNodeStore FTS5 检索（记忆层）
 * 3. 关键词 → KnowledgeStore 多粒度 FTS5 检索（知识层）
 * 4. 多路结果 → RRF 融合
 * 5. 融合结果 → ContextPack token 裁剪
 *
 * 扩展点：
 * - 后续接入 sqlite-vec 语义检索作为额外一路信号
 * - 关键词提取可替换为 embedding 模型（不影响下游）
 */
import type { MemoryNodeStore } from './memory-node-store.js'
import type { KnowledgeStore } from './knowledge-store.js'
import type {
  ContextPack,
  GranularityLayer,
  MemoryScope,
  RetrievalHit,
  RetrievalTraceEntry,
  TaskIntent
} from './types.js'
import { getGranularityLayers } from './retrieval/granularity-router.js'
import { reciprocalRankFusion } from './retrieval/rrf.js'
import { buildContextPack } from './retrieval/context-pack.js'

export interface RetrievalInput {
  /** 查询文本 */
  query: string
  /** 任务意图（决定粒度路由） */
  taskIntent: TaskIntent
  /** 作用域过滤 */
  scopes?: MemoryScope[]
  /** 仓库 ID */
  repositoryId?: string
  /** 用户 ID */
  userId?: string
  /** 分支名（分支感知检索） */
  branchName?: string
  /** 每路检索上限（默认 10） */
  perChannelLimit?: number
  /** token 总预算（默认 4000） */
  tokenBudget?: number
}

/** 简单分词：按空白 + 标点拆分，过滤短词 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
}

export class RetrievalPipeline {
  constructor(
    private readonly memoryNodeStore: MemoryNodeStore,
    private readonly knowledgeStore: KnowledgeStore
  ) {}

  /**
   * 执行检索流水线。
   *
   * @returns ContextPack（含 memories / knowledge / totalTokens / retrievalTrace）
   */
  execute(input: RetrievalInput): ContextPack {
    const keywords = tokenize(input.query)
    if (keywords.length === 0) {
      return { memories: [], knowledge: [], totalTokens: 0, retrievalTrace: [] }
    }

    const limit = input.perChannelLimit ?? 10
    const layers = getGranularityLayers(input.taskIntent)
    const traces: RetrievalTraceEntry[] = []

    // ── 1. 记忆层 FTS5 检索 ──────────────────────────────────────────────
    const memStart = Date.now()
    const memoryResults = this.memoryNodeStore.searchFts({
      keywords,
      scopes: input.scopes,
      repositoryId: input.repositoryId,
      userId: input.userId,
      branchName: input.branchName,
      limit
    })
    traces.push({
      layer: 'paragraph', // MemoryNode 对应 paragraph 级别
      signal: 'lexical',
      hitCount: memoryResults.length,
      topScore: memoryResults[0]?.score ?? 0,
      latencyMs: Date.now() - memStart
    })

    // 将 MemoryNode 结果转成 RetrievalHit
    const memoryHits: RetrievalHit[] = memoryResults.map((node) => ({
      layer: 'paragraph' as GranularityLayer,
      content: node.summary ?? node.title,
      score: node.score,
      sourcePath: null,
      documentId: null,
      nodeId: node.id,
      nodeType: node.nodeType,
      nodeTitle: node.title,
      metadata: { status: node.status, confidence: node.confidence, importance: node.importance }
    }))

    // ── 2. 知识层多粒度 FTS5 检索 ────────────────────────────────────────
    const knowledgeHits: RetrievalHit[] = []

    for (const layer of layers) {
      const layerStart = Date.now()
      let hits: RetrievalHit[] = []

      switch (layer) {
        case 'proposition': {
          const results = this.knowledgeStore.searchPropositions(keywords, limit)
          hits = results.map((r) => ({
            layer: 'proposition' as const,
            content: r.content,
            score: r.score,
            sourcePath: null,
            documentId: r.documentId,
            nodeId: null,
            nodeType: null,
            nodeTitle: null,
            metadata: { propositionType: r.propositionType, sourcePattern: r.sourcePattern }
          }))
          break
        }
        case 'paragraph': {
          const results = this.knowledgeStore.searchParagraphs(keywords, limit)
          hits = results.map((r) => ({
            layer: 'paragraph' as const,
            content: r.content,
            score: r.score,
            sourcePath: null,
            documentId: r.documentId,
            nodeId: null,
            nodeType: null,
            nodeTitle: null,
            metadata: { headingPath: r.headingPath }
          }))
          break
        }
        case 'chunk': {
          const results = this.knowledgeStore.searchChunks(keywords, limit)
          hits = results.map((r) => ({
            layer: 'chunk' as const,
            content: r.content,
            score: r.score,
            sourcePath: null,
            documentId: r.documentId,
            nodeId: null,
            nodeType: null,
            nodeTitle: null,
            metadata: { symbolNames: r.symbolNames, startLine: r.startLine, endLine: r.endLine }
          }))
          break
        }
        case 'summary': {
          // summary 层暂用 searchParagraphs 降级（summary 表数据量少，后续可加专用 search）
          const results = this.knowledgeStore.searchParagraphs(keywords, limit)
          hits = results.map((r) => ({
            layer: 'summary' as const,
            content: r.content,
            score: r.score,
            sourcePath: null,
            documentId: r.documentId,
            nodeId: null,
            nodeType: null,
            nodeTitle: null,
            metadata: { headingPath: r.headingPath }
          }))
          break
        }
      }

      traces.push({
        layer,
        signal: 'lexical',
        hitCount: hits.length,
        topScore: hits[0]?.score ?? 0,
        latencyMs: Date.now() - layerStart
      })

      knowledgeHits.push(...hits)
    }

    // ── 3. RRF 融合 ──────────────────────────────────────────────────────
    const rrfStart = Date.now()
    const fusedMemories = reciprocalRankFusion([{ signal: 'lexical', hits: memoryHits }], 60, limit)
    const fusedKnowledge = reciprocalRankFusion([{ signal: 'lexical', hits: knowledgeHits }], 60, limit * layers.length)
    traces.push({
      layer: layers[0] ?? 'paragraph',
      signal: 'rrf_fusion',
      hitCount: fusedMemories.length + fusedKnowledge.length,
      topScore: Math.max(fusedMemories[0]?.score ?? 0, fusedKnowledge[0]?.score ?? 0),
      latencyMs: Date.now() - rrfStart
    })

    // ── 4. 构建 ContextPack ──────────────────────────────────────────────
    return buildContextPack({
      memoryHits: fusedMemories,
      knowledgeHits: fusedKnowledge,
      tokenBudget: input.tokenBudget,
      traces
    })
  }
}
