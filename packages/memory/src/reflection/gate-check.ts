/**
 * 门控检查（确定性，零 LLM）：判断是否应该触发 Reflection。
 *
 * 门控条件：
 * 1. candidate 压力：待审 candidate 数量超过阈值
 * 2. 证据阈值：自上次 reflection 以来积累了足够的新证据
 * 3. 冷却期：距上次 reflection 已过足够时间
 * 4. 置信衰减：存在置信度下降的活跃节点
 */
import type { MemoryNodeStore } from '../memory-node-store.js'
import type { MemoryNode } from '../types.js'

export interface GateCheckInput {
  /** 候选记忆数量（来自 LLM 或 proposition 提取） */
  pendingCandidateCount: number
  /** 自上次 reflection 以来的新证据数 */
  newEvidenceCount: number
  /** 距上次 reflection 的毫秒数 */
  msSinceLastReflection: number
  /** 可选：检查特定节点是否有置信衰减 */
  nodesToCheck?: MemoryNode[]
}

export interface GateConfig {
  /** candidate 压力阈值（默认 5） */
  candidatePressureThreshold: number
  /** 证据阈值（默认 3） */
  evidenceThreshold: number
  /** 冷却期毫秒（默认 5 分钟） */
  cooldownMs: number
  /** 是否启用置信衰减检查 */
  enableConfidenceDecayCheck: boolean
  /** 置信衰减阈值：confidence 低于此值视为衰减（默认 0.3） */
  confidenceDecayThreshold: number
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  candidatePressureThreshold: 5,
  evidenceThreshold: 3,
  cooldownMs: 5 * 60 * 1000,
  enableConfidenceDecayCheck: true,
  confidenceDecayThreshold: 0.3
}

export interface GateCheckResult {
  passed: boolean
  /** 通过的原因 */
  reasons: string[]
  /** 未通过的原因 */
  skipReasons: string[]
}

/**
 * 执行门控检查。
 *
 * 任一条件满足即通过（OR 逻辑），但冷却期是硬约束（必须满足）。
 */
export function checkGate(input: GateCheckInput, config = DEFAULT_GATE_CONFIG): GateCheckResult {
  const reasons: string[] = []
  const skipReasons: string[] = []

  // 硬约束：冷却期
  if (input.msSinceLastReflection < config.cooldownMs) {
    return {
      passed: false,
      reasons: [],
      skipReasons: [`Cooldown not met: ${input.msSinceLastReflection}ms < ${config.cooldownMs}ms`]
    }
  }

  // 条件 1：candidate 压力
  if (input.pendingCandidateCount >= config.candidatePressureThreshold) {
    reasons.push(`Candidate pressure: ${input.pendingCandidateCount} >= ${config.candidatePressureThreshold}`)
  }

  // 条件 2：证据阈值
  if (input.newEvidenceCount >= config.evidenceThreshold) {
    reasons.push(`Evidence threshold: ${input.newEvidenceCount} >= ${config.evidenceThreshold}`)
  }

  // 条件 3：置信衰减
  if (config.enableConfidenceDecayCheck && input.nodesToCheck) {
    const decayed = input.nodesToCheck.filter(
      (n) => n.status === 'active' && n.confidence < config.confidenceDecayThreshold
    )
    if (decayed.length > 0) {
      reasons.push(`Confidence decay: ${decayed.length} active nodes below ${config.confidenceDecayThreshold}`)
    }
  }

  // 至少一个条件满足才通过
  if (reasons.length === 0) {
    skipReasons.push('No gate condition met')
  }

  return {
    passed: reasons.length > 0,
    reasons,
    skipReasons
  }
}

/**
 * 统计 candidate 数量的快捷方法。
 */
export function countCandidates(store: MemoryNodeStore, repositoryId?: string): number {
  const nodes = store.list({
    status: 'candidate',
    ...(repositoryId ? { repositoryId } : {})
  } as Parameters<MemoryNodeStore['list']>[0])
  return nodes.length
}
