/**
 * Reciprocal Rank Fusion (RRF) 算法实现。
 *
 * 将多路检索结果（语义 / 字面 / 不同粒度层）融合为统一排序列表。
 * 公式：score(d) = Σ 1 / (k + rank_i(d))
 * 其中 k 是平滑常数（默认 60），rank_i(d) 是文档在第 i 路结果中的排名（从 1 开始）。
 */
import type { RetrievalHit } from '../types.js'

export interface RrfInput {
  /** 信号来源标识 */
  signal: 'semantic' | 'lexical' | 'rrf_fusion'
  /** 该路排序结果（按 score 降序排列） */
  hits: RetrievalHit[]
  /** 可选：覆盖默认 k 值 */
  k?: number
}

/**
 * 对多路检索结果执行 RRF 融合。
 *
 * @param inputs 多路检索结果
 * @param k 平滑常数（默认 60）
 * @param topK 返回前 N 条结果（默认 20）
 * @returns 融合后的排序列表，score 为 RRF 分数
 */
export function reciprocalRankFusion(inputs: RrfInput[], k = 60, topK = 20): RetrievalHit[] {
  // 用 content+layer 作为去重 key
  const scoreMap = new Map<string, { hit: RetrievalHit; rrfScore: number }>()

  for (const input of inputs) {
    const rank = input.hits
    for (let i = 0; i < rank.length; i++) {
      const hit = rank[i]!
      const key = `${hit.layer}::${hit.documentId ?? hit.nodeId ?? ''}::${hit.content.slice(0, 100)}`
      const existing = scoreMap.get(key)
      const rrfContribution = 1 / (k + i + 1) // rank 从 1 开始

      if (existing) {
        existing.rrfScore += rrfContribution
      } else {
        scoreMap.set(key, {
          hit: { ...hit, score: 0 }, // score 后面用 rrfScore 覆盖
          rrfScore: rrfContribution
        })
      }
    }
  }

  // 按 RRF 分数降序排列，取 topK
  const sorted = [...scoreMap.values()].sort((a, b) => b.rrfScore - a.rrfScore).slice(0, topK)

  return sorted.map((entry) => ({
    ...entry.hit,
    score: Math.round(entry.rrfScore * 10000) // 放大到整数方便比较
  }))
}
