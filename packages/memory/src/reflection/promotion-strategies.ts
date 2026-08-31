/**
 * 晋升策略执行器（确定性，零 LLM）。
 *
 * 六种策略：
 * - create：创建新 MemoryNode
 * - update：更新现有节点
 * - merge：合并到相似节点
 * - supersede：替代旧节点
 * - discard：丢弃候选
 * - needs_review：标记待人工审核
 *
 * 每个策略接收候选信息和现有节点数据，执行对应的数据库操作。
 */
import type { MemoryNodeStore } from '../memory-node-store.js'
import type { EvidenceStore } from '../evidence-store.js'
import type {
  MemoryCandidate,
  MemoryNode,
  MemoryNodeType,
  PromotionAction,
  PromotionResult,
  CreateMemoryNodeInput
} from '../types.js'
import { PROTECTED_NODE_TYPES } from '../types.js'

/** 相似度匹配结果 */
export interface MatchResult {
  node: MemoryNode
  similarity: number
  matchReason: string
}

/**
 * 简单的标题相似度计算（Jaccard on words）。
 * 后续可替换为 embedding cosine similarity。
 */
export function computeTitleSimilarity(titleA: string, titleB: string): number {
  const wordsA = new Set(
    titleA
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
  )
  const wordsB = new Set(
    titleB
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
  )
  if (wordsA.size === 0 || wordsB.size === 0) return 0

  let intersection = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++
  }
  const union = wordsA.size + wordsB.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * 在现有节点中查找与候选最相似的节点。
 */
export function findBestMatch(
  store: MemoryNodeStore,
  candidate: MemoryCandidate,
  repositoryId?: string,
  threshold = 0.3
): MatchResult | null {
  const existingNodes = store.list({
    ...(repositoryId ? { repositoryId } : {})
  } as Parameters<MemoryNodeStore['list']>[0])

  let bestMatch: MatchResult | null = null

  for (const node of existingNodes) {
    // 跳过非活跃节点
    if (node.status !== 'active' && node.status !== 'candidate') continue

    const similarity = computeTitleSimilarity(candidate.title, node.title)
    if (similarity >= threshold && (!bestMatch || similarity > bestMatch.similarity)) {
      bestMatch = { node, similarity, matchReason: `Title similarity: ${similarity.toFixed(2)}` }
    }
  }

  return bestMatch
}

/**
 * 根据候选和匹配结果决定晋升策略。
 */
export function decideAction(candidate: MemoryCandidate, bestMatch: MatchResult | null): PromotionAction {
  // 受保护类型不参与自动 merge/supersede
  const isProtected = (PROTECTED_NODE_TYPES as readonly MemoryNodeType[]).includes(candidate.nodeType)

  if (!bestMatch) {
    // 没有相似节点 → 创建新节点
    return 'create'
  }

  if (bestMatch.similarity > 0.8) {
    // 高度相似 → 更新现有节点
    return 'update'
  }

  if (bestMatch.similarity > 0.5 && !isProtected) {
    // 中度相似且非受保护 → 合并
    return 'merge'
  }

  if (bestMatch.similarity > 0.3 && !isProtected) {
    // 低度相似且非受保护 → 替代
    return 'supersede'
  }

  // 相似度太低或受保护 → 创建新节点
  return 'create'
}

/**
 * 执行晋升策略。
 */
export function executePromotion(
  action: PromotionAction,
  candidate: MemoryCandidate,
  match: MatchResult | null,
  memoryStore: MemoryNodeStore,
  evidenceStore: EvidenceStore,
  scope: 'user' | 'repo' | 'conversation' = 'repo',
  repositoryId?: string
): PromotionResult {
  switch (action) {
    case 'create': {
      const input: CreateMemoryNodeInput = {
        nodeType: candidate.nodeType,
        title: candidate.title,
        summary: candidate.summary,
        confidence: candidate.confidence,
        importance: candidate.importance,
        tags: candidate.tags,
        scope,
        repositoryId,
        status: 'candidate'
      }
      const node = memoryStore.create(input)
      // 关联证据
      if (candidate.evidence.length > 0) {
        evidenceStore.createMany(candidate.evidence.map((e) => ({ ...e, memoryNodeId: node.id })))
      }
      return { action: 'create', nodeId: node.id, mergedWithId: null, notes: `Created ${node.nodeType}: ${node.title}` }
    }

    case 'update': {
      if (!match) return { action: 'update', nodeId: null, mergedWithId: null, notes: 'No match to update' }
      const updated = memoryStore.update(match.node.id, {
        summary: candidate.summary,
        confidence: Math.max(match.node.confidence, candidate.confidence),
        importance: Math.max(match.node.importance, candidate.importance),
        tags: [...new Set([...match.node.tags, ...candidate.tags])]
      })
      return { action: 'update', nodeId: updated.id, mergedWithId: null, notes: `Updated: ${updated.title}` }
    }

    case 'merge': {
      if (!match) return { action: 'merge', nodeId: null, mergedWithId: null, notes: 'No match to merge into' }
      // 更新目标节点的摘要和标签
      const mergedSummary = match.node.summary ? `${match.node.summary}\n- ${candidate.summary}` : candidate.summary
      const updated = memoryStore.update(match.node.id, {
        summary: mergedSummary,
        tags: [...new Set([...match.node.tags, ...candidate.tags])]
      })
      return {
        action: 'merge',
        nodeId: updated.id,
        mergedWithId: updated.id,
        notes: `Merged into: ${updated.title}`
      }
    }

    case 'supersede': {
      if (!match) return { action: 'supersede', nodeId: null, mergedWithId: null, notes: 'No match to supersede' }
      // 标记旧节点为 superseded
      memoryStore.update(match.node.id, { status: 'superseded' })
      // 创建新节点
      const input: CreateMemoryNodeInput = {
        nodeType: candidate.nodeType,
        title: candidate.title,
        summary: `${candidate.summary}\n(Supersedes: ${match.node.title})`,
        confidence: candidate.confidence,
        importance: candidate.importance,
        tags: candidate.tags,
        scope,
        repositoryId,
        status: 'candidate'
      }
      const newNode = memoryStore.create(input)
      return {
        action: 'supersede',
        nodeId: newNode.id,
        mergedWithId: match.node.id,
        notes: `Superseded ${match.node.title} with ${newNode.title}`
      }
    }

    case 'discard': {
      return { action: 'discard', nodeId: null, mergedWithId: null, notes: `Discarded: ${candidate.title}` }
    }

    case 'needs_review': {
      // 创建为 candidate 但标记 metadata 需要人工审核
      const input: CreateMemoryNodeInput = {
        nodeType: candidate.nodeType,
        title: candidate.title,
        summary: candidate.summary,
        confidence: candidate.confidence,
        importance: candidate.importance,
        tags: [...candidate.tags, 'needs_review'],
        scope,
        repositoryId,
        status: 'candidate',
        metadata: { needsReview: true, originalImportance: candidate.importance }
      }
      const node = memoryStore.create(input)
      return {
        action: 'needs_review',
        nodeId: node.id,
        mergedWithId: null,
        notes: `Created for review: ${node.title}`
      }
    }

    default:
      return { action, nodeId: null, mergedWithId: null, notes: `Unknown action: ${action}` }
  }
}
