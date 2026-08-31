/**
 * ContextPack 构建器：将检索结果按 token 预算裁剪，输出最终 ContextPack。
 *
 * 策略：
 * 1. 按 score 降序排列所有候选 hit
 * 2. 贪心填充：逐条加入直到 token 预算耗尽
 * 3. memories 和 knowledge 分别计数，共享总预算
 * 4. 记录检索追踪（retrievalTrace）用于调试
 */
import type { ContextPack, RetrievalHit, RetrievalTraceEntry } from '../types.js'

/** 粗略估算 token 数（与 markdown-chunker 的 estimateTokens 保持一致） */
export function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const nonCjk = text.length - cjkChars
  return Math.ceil(cjkChars / 1.5 + nonCjk / 4)
}

export interface BuildContextPackInput {
  /** 记忆层检索结果 */
  memoryHits: RetrievalHit[]
  /** 知识层检索结果 */
  knowledgeHits: RetrievalHit[]
  /** token 总预算（默认 4000） */
  tokenBudget?: number
  /** 检索追踪条目 */
  traces?: RetrievalTraceEntry[]
}

/**
 * 构建 ContextPack：按 token 预算裁剪检索结果。
 *
 * 优先级：memoryHits 优先于 knowledgeHits（记忆更具体）。
 */
export function buildContextPack(input: BuildContextPackInput): ContextPack {
  const budget = input.tokenBudget ?? 4000
  const traces = input.traces ?? []

  // 合并并按 score 降序排列
  const allMemories = [...input.memoryHits].sort((a, b) => b.score - a.score)
  const allKnowledge = [...input.knowledgeHits].sort((a, b) => b.score - a.score)

  const memories: RetrievalHit[] = []
  const knowledge: RetrievalHit[] = []
  let totalTokens = 0

  // 先填充 memories（优先级更高）
  for (const hit of allMemories) {
    const tokens = estimateTokens(hit.content)
    if (totalTokens + tokens > budget) break
    memories.push(hit)
    totalTokens += tokens
  }

  // 剩余预算填充 knowledge
  for (const hit of allKnowledge) {
    const tokens = estimateTokens(hit.content)
    if (totalTokens + tokens > budget) break
    knowledge.push(hit)
    totalTokens += tokens
  }

  return {
    memories,
    knowledge,
    totalTokens,
    retrievalTrace: traces
  }
}
