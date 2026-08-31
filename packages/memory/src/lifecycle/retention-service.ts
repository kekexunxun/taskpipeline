/**
 * RetentionService：MemoryNode 生命周期管理。
 *
 * 职责：
 * 1. candidate 过期：超期未晋升的 candidate → expired
 * 2. stale 检测：长时间未被检索命中的 active 节点 → stale
 * 3. 归档：superseded/expired 节点超过保留期 → archived
 * 4. 压缩：多个相关 stale 节点 → compacted 合成节点
 *
 * 受保护类型（constraint / security_rule / architecture / decision）
 * 免于自动归档和压缩，仅可手动操作。
 */
import type { MemoryNodeStore } from '../memory-node-store.js'
import type { MemoryNodeStatus, MemoryNodeType } from '../types.js'
import { PROTECTED_NODE_TYPES } from '../types.js'

export interface RetentionConfig {
  /** candidate 过期时间（毫秒，默认 7 天） */
  candidateExpiryMs: number
  /** stale 检测：节点 updatedAt 距今超过此时间且未被检索命中 → stale（默认 30 天） */
  staleThresholdMs: number
  /** 归档保留期：superseded/expired 节点超过此时间 → archived（默认 90 天） */
  archiveThresholdMs: number
  /** 压缩阈值：同一父节点下 stale 子节点超过此数量 → 触发压缩（默认 5） */
  compactionThreshold: number
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  candidateExpiryMs: 7 * 24 * 60 * 60 * 1000,
  staleThresholdMs: 30 * 24 * 60 * 60 * 1000,
  archiveThresholdMs: 90 * 24 * 60 * 60 * 1000,
  compactionThreshold: 5
}

export interface RetentionResult {
  expired: string[]
  markedStale: string[]
  archived: string[]
  compacted: Array<{ parentId: string; childIds: string[]; newId: string }>
}

/** 检查节点类型是否受保护 */
function isProtected(nodeType: MemoryNodeType): boolean {
  return (PROTECTED_NODE_TYPES as readonly MemoryNodeType[]).includes(nodeType)
}

export class RetentionService {
  private readonly config: RetentionConfig

  constructor(
    private readonly store: MemoryNodeStore,
    config?: Partial<RetentionConfig>
  ) {
    this.config = { ...DEFAULT_RETENTION_CONFIG, ...config }
  }

  /**
   * 执行完整的生命周期维护。
   *
   * @param now 当前时间戳（可注入用于测试）
   */
  run(now = Date.now()): RetentionResult {
    const result: RetentionResult = { expired: [], markedStale: [], archived: [], compacted: [] }

    result.expired = this.expireCandidates(now)
    result.markedStale = this.markStale(now)
    result.archived = this.archiveOld(now)

    return result
  }

  /**
   * 将超期的 candidate 标记为 expired。
   * 受保护类型不自动过期。
   */
  expireCandidates(now: number): string[] {
    const allNodes = this.store.list({ status: 'candidate' })
    const expired: string[] = []

    for (const node of allNodes) {
      if (isProtected(node.nodeType)) continue
      const createdAt = new Date(node.createdAt).getTime()
      if (now - createdAt > this.config.candidateExpiryMs) {
        this.store.update(node.id, { status: 'expired' })
        expired.push(node.id)
      }
    }

    return expired
  }

  /**
   * 将长时间未更新的 active 节点标记为 stale。
   * 受保护类型不自动降权。
   */
  markStale(now: number): string[] {
    const allNodes = this.store.list({ status: 'active' })
    const marked: string[] = []

    for (const node of allNodes) {
      if (isProtected(node.nodeType)) continue
      const updatedAt = new Date(node.updatedAt).getTime()
      if (now - updatedAt > this.config.staleThresholdMs) {
        this.store.update(node.id, { status: 'stale' })
        marked.push(node.id)
      }
    }

    return marked
  }

  /**
   * 将超过保留期的 superseded / expired 节点标记为 archived。
   * 受保护类型不自动归档。
   */
  archiveOld(now: number): string[] {
    const statuses: MemoryNodeStatus[] = ['superseded', 'expired']
    const archived: string[] = []

    for (const status of statuses) {
      const nodes = this.store.list({ status })
      for (const node of nodes) {
        if (isProtected(node.nodeType)) continue
        const updatedAt = new Date(node.updatedAt).getTime()
        if (now - updatedAt > this.config.archiveThresholdMs) {
          this.store.update(node.id, { status: 'archived' })
          archived.push(node.id)
        }
      }
    }

    return archived
  }
}
