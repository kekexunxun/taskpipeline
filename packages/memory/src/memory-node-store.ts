/**
 * MemoryNode 存储层：CRUD + 状态机转换。
 *
 * 设计原则：
 * - 与现有 MemoryStore 保持一致的 better-sqlite3 同步 API 风格
 * - 状态机转换有显式校验（非法转换抛错）
 * - 受保护类型（constraint/architecture/decision/security_rule）有归档豁免
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  ACTIVE_STATUSES,
  PENALIZED_STATUSES,
  PROTECTED_NODE_TYPES,
  type CreateMemoryNodeInput,
  type MemoryNode,
  type MemoryNodeStatus,
  type MemoryNodeType,
  type MemoryScope,
  type UpdateMemoryNodeInput
} from './types.js'

/** 合法的状态转换表 */
const VALID_TRANSITIONS: Record<MemoryNodeStatus, MemoryNodeStatus[]> = {
  candidate: ['active', 'expired'],
  active: ['stale', 'superseded', 'archived'],
  stale: ['active', 'superseded', 'archived'],
  superseded: ['archived'],
  archived: ['active'], // 允许从归档恢复
  compacted: ['active'], // 允许从压缩恢复
  expired: [] // 终态，不可转换
}

/** 将 FTS5 关键词数组转成 MATCH 表达式（复用现有 MemoryStore 的 ftsQuery 逻辑） */
function ftsQuery(keywords: string[]): string {
  const cleaned = keywords.map((kw) => kw.trim().replace(/"/g, '""')).filter((kw) => kw.length > 0)
  if (!cleaned.length) return ''
  return cleaned.map((kw) => (kw.length <= 2 ? `"${kw}"` : `"${kw}"*`)).join(' OR ')
}

export class MemoryNodeStore {
  constructor(readonly db: Database.Database) {}

  private now(): string {
    return new Date().toISOString()
  }

  /** 行 → MemoryNode 对象 */
  private parseNode(row: Record<string, unknown>): MemoryNode {
    return {
      id: String(row.id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      nodeType: String(row.node_type) as MemoryNodeType,
      title: String(row.title),
      summary: row.summary ? String(row.summary) : null,
      status: String(row.status) as MemoryNodeStatus,
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

  /** 创建 MemoryNode */
  create(input: CreateMemoryNodeInput): MemoryNode {
    const now = this.now()
    const node: MemoryNode = {
      id: randomUUID(),
      parentId: input.parentId ?? null,
      nodeType: input.nodeType,
      title: input.title,
      summary: input.summary ?? null,
      status: input.status ?? 'candidate',
      confidence: input.confidence ?? 0.5,
      importance: input.importance ?? 0.5,
      scope: input.scope,
      userId: input.userId ?? null,
      repositoryId: input.repositoryId ?? null,
      conversationId: input.conversationId ?? null,
      branchName: input.branchName ?? null,
      metadata: input.metadata ?? null,
      tags: input.tags ?? [],
      source: input.source ?? 'auto',
      createdAt: now,
      updatedAt: now
    }
    this.db
      .prepare(
        `
      INSERT INTO memory_nodes
        (id, parent_id, node_type, title, summary, status, confidence, importance,
         scope, user_id, repository_id, conversation_id, branch_name,
         metadata, tags, source, created_at, updated_at)
      VALUES
        (@id, @parentId, @nodeType, @title, @summary, @status, @confidence, @importance,
         @scope, @userId, @repositoryId, @conversationId, @branchName,
         @metadata, @tags, @source, @createdAt, @updatedAt)
    `
      )
      .run({
        ...node,
        metadata: node.metadata ? JSON.stringify(node.metadata) : null,
        tags: JSON.stringify(node.tags)
      })
    return node
  }

  /** 按 id 获取单个节点 */
  get(id: string): MemoryNode | undefined {
    const row = this.db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.parseNode(row) : undefined
  }

  /** 更新节点（所有字段可选） */
  update(id: string, patch: UpdateMemoryNodeInput): MemoryNode {
    const current = this.get(id)
    if (!current) throw new Error(`MemoryNode not found: ${id}`)

    // 状态转换校验
    if (patch.status && patch.status !== current.status) {
      this.validateTransition(current.status, patch.status, current.nodeType)
    }

    const next: MemoryNode = {
      ...current,
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.nodeType !== undefined ? { nodeType: patch.nodeType } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
      ...(patch.branchName !== undefined ? { branchName: patch.branchName } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      updatedAt: this.now()
    }

    this.db
      .prepare(
        `
      UPDATE memory_nodes SET
        parent_id = @parentId, node_type = @nodeType, title = @title,
        summary = @summary, status = @status, confidence = @confidence,
        importance = @importance, branch_name = @branchName,
        metadata = @metadata, tags = @tags, source = @source, updated_at = @updatedAt
      WHERE id = @id
    `
      )
      .run({
        id: next.id,
        parentId: next.parentId,
        nodeType: next.nodeType,
        title: next.title,
        summary: next.summary,
        status: next.status,
        confidence: next.confidence,
        importance: next.importance,
        branchName: next.branchName,
        metadata: next.metadata ? JSON.stringify(next.metadata) : null,
        tags: JSON.stringify(next.tags),
        source: next.source,
        updatedAt: next.updatedAt
      })

    return next
  }

  /** 状态转换校验 */
  private validateTransition(from: MemoryNodeStatus, to: MemoryNodeStatus, nodeType: MemoryNodeType): void {
    const allowed = VALID_TRANSITIONS[from]
    if (!allowed.includes(to)) {
      throw new Error(`Invalid status transition: ${from} → ${to} (node_type=${nodeType})`)
    }
  }

  /** 删除节点 */
  delete(id: string): void {
    this.db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(id)
  }

  /** 按条件批量删除 */
  deleteMany(filter: { repositoryId?: string; conversationId?: string; scope?: MemoryScope }): number {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.repositoryId) {
      clauses.push('repository_id = ?')
      params.push(filter.repositoryId)
    }
    if (filter.conversationId) {
      clauses.push('conversation_id = ?')
      params.push(filter.conversationId)
    }
    if (filter.scope) {
      clauses.push('scope = ?')
      params.push(filter.scope)
    }
    if (!clauses.length) return 0
    return this.db.prepare(`DELETE FROM memory_nodes WHERE ${clauses.join(' AND ')}`).run(...params).changes
  }

  /** 列表查询 */
  list(
    filter: {
      scope?: MemoryScope
      scopes?: MemoryScope[]
      repositoryId?: string
      userId?: string
      conversationId?: string
      status?: MemoryNodeStatus
      statuses?: MemoryNodeStatus[]
      nodeType?: MemoryNodeType
      branchName?: string
    } = {}
  ): MemoryNode[] {
    const clauses: string[] = []
    const params: unknown[] = []

    if (filter.scopes?.length) {
      clauses.push(`scope IN (${filter.scopes.map(() => '?').join(',')})`)
      params.push(...filter.scopes)
    }
    if (filter.scope) {
      clauses.push('scope = ?')
      params.push(filter.scope)
    }
    if (filter.repositoryId) {
      clauses.push('repository_id = ?')
      params.push(filter.repositoryId)
    }
    if (filter.userId) {
      clauses.push('user_id = ?')
      params.push(filter.userId)
    }
    if (filter.conversationId) {
      clauses.push('conversation_id = ?')
      params.push(filter.conversationId)
    }
    if (filter.statuses?.length) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(',')})`)
      params.push(...filter.statuses)
    }
    if (filter.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter.nodeType) {
      clauses.push('node_type = ?')
      params.push(filter.nodeType)
    }
    if (filter.branchName) {
      clauses.push('branch_name = ?')
      params.push(filter.branchName)
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM memory_nodes ${where} ORDER BY importance DESC, updated_at DESC`)
      .all(...params) as Record<string, unknown>[]
    return rows.map((row) => this.parseNode(row))
  }

  /** 获取子节点 */
  listChildren(parentId: string): MemoryNode[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_nodes WHERE parent_id = ? ORDER BY importance DESC')
      .all(parentId) as Record<string, unknown>[]
    return rows.map((row) => this.parseNode(row))
  }

  /** FTS5 字面检索（降级通道） */
  searchFts(input: {
    keywords: string[]
    scopes?: MemoryScope[]
    repositoryId?: string
    userId?: string
    branchName?: string
    limit?: number
  }): Array<MemoryNode & { score: number }> {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50))
    const query = ftsQuery(input.keywords)
    if (!query) return []

    const clauses: string[] = ['memory_nodes_fts MATCH ?']
    const params: unknown[] = [query]

    // 只检索活跃/降权状态的节点
    clauses.push(
      `memory_nodes.status IN (${ACTIVE_STATUSES.concat(PENALIZED_STATUSES)
        .map(() => '?')
        .join(',')})`
    )
    params.push(...ACTIVE_STATUSES, ...PENALIZED_STATUSES)

    if (input.scopes?.length) {
      clauses.push(`memory_nodes.scope IN (${input.scopes.map(() => '?').join(',')})`)
      params.push(...input.scopes)
    }
    if (input.repositoryId) {
      clauses.push('memory_nodes.repository_id = ?')
      params.push(input.repositoryId)
    }
    if (input.userId) {
      clauses.push('memory_nodes.user_id = ?')
      params.push(input.userId)
    }
    if (input.branchName) {
      // 分支感知：优先当前分支，回退全局（branch_name IS NULL）
      clauses.push('(memory_nodes.branch_name = ? OR memory_nodes.branch_name IS NULL)')
      params.push(input.branchName)
    }

    params.push(limit)

    const rows = this.db
      .prepare(
        `
      SELECT memory_nodes.*, CAST(-bm25(memory_nodes_fts) * 100 AS INTEGER) AS score
      FROM memory_nodes_fts
      JOIN memory_nodes ON memory_nodes.rowid = memory_nodes_fts.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY
        CASE WHEN memory_nodes.status = 'active' THEN 0 ELSE 1 END,
        memory_nodes.importance DESC,
        score DESC
      LIMIT ?
    `
      )
      .all(...params) as Array<Record<string, unknown>>

    return rows.map((row) => ({ ...this.parseNode(row), score: Number(row.score) }))
  }

  /** 检查节点类型是否受保护（免于自动归档/压缩） */
  isProtected(nodeType: MemoryNodeType): boolean {
    return (PROTECTED_NODE_TYPES as readonly MemoryNodeType[]).includes(nodeType)
  }

  /** 晋升 candidate → active */
  promote(id: string, confidence?: number): MemoryNode {
    const node = this.get(id)
    if (!node) throw new Error(`MemoryNode not found: ${id}`)
    if (node.status !== 'candidate') throw new Error(`Cannot promote non-candidate node: ${id} (status=${node.status})`)
    return this.update(id, { status: 'active', ...(confidence !== undefined ? { confidence } : {}) })
  }

  /** 更新祖先节点摘要（ConsolidationService 调用） */
  updateAncestorSummaries(parentId: string): void {
    const children = this.listChildren(parentId)
    const summary = children
      .filter((c) => c.status === 'active')
      .map((c) => `- [${c.nodeType}] ${c.title}: ${c.summary ?? ''}`)
      .join('\n')
    if (summary) {
      this.update(parentId, { summary })
    }
  }
}
