/**
 * Evidence 链接存储层：关联 MemoryNode 到原始来源。
 *
 * 每条 EvidenceLink 记录"这条记忆是从哪里来的"——哪次对话、哪个任务、
 * 哪段代码引用、测试结果、review 笔记或 git diff。
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { CreateEvidenceLinkInput, EvidenceLink, EvidenceType } from './types.js'

export class EvidenceStore {
  constructor(readonly db: Database.Database) {}

  private now(): string {
    return new Date().toISOString()
  }

  private parseLink(row: Record<string, unknown>): EvidenceLink {
    return {
      id: String(row.id),
      memoryNodeId: String(row.memory_node_id),
      evidenceType: String(row.evidence_type) as EvidenceType,
      sourceId: row.source_id ? String(row.source_id) : null,
      sourceRef: row.source_ref ? String(row.source_ref) : null,
      content: row.content ? String(row.content) : null,
      createdAt: String(row.created_at)
    }
  }

  /** 创建证据链接 */
  create(input: CreateEvidenceLinkInput): EvidenceLink {
    const link: EvidenceLink = {
      id: randomUUID(),
      memoryNodeId: input.memoryNodeId,
      evidenceType: input.evidenceType,
      sourceId: input.sourceId ?? null,
      sourceRef: input.sourceRef ?? null,
      content: input.content ?? null,
      createdAt: this.now()
    }
    this.db
      .prepare(
        `
      INSERT INTO evidence_links (id, memory_node_id, evidence_type, source_id, source_ref, content, created_at)
      VALUES (@id, @memoryNodeId, @evidenceType, @sourceId, @sourceRef, @content, @createdAt)
    `
      )
      .run({
        id: link.id,
        memoryNodeId: link.memoryNodeId,
        evidenceType: link.evidenceType,
        sourceId: link.sourceId,
        sourceRef: link.sourceRef,
        content: link.content,
        createdAt: link.createdAt
      })
    return link
  }

  /** 批量创建证据链接 */
  createMany(inputs: CreateEvidenceLinkInput[]): EvidenceLink[] {
    return inputs.map((input) => this.create(input))
  }

  /** 获取某个 MemoryNode 的所有证据 */
  listByMemoryNode(memoryNodeId: string): EvidenceLink[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence_links WHERE memory_node_id = ? ORDER BY created_at DESC')
      .all(memoryNodeId) as Record<string, unknown>[]
    return rows.map((row) => this.parseLink(row))
  }

  /** 按来源类型过滤 */
  listByType(memoryNodeId: string, evidenceType: EvidenceType): EvidenceLink[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence_links WHERE memory_node_id = ? AND evidence_type = ? ORDER BY created_at DESC')
      .all(memoryNodeId, evidenceType) as Record<string, unknown>[]
    return rows.map((row) => this.parseLink(row))
  }

  /** 删除某个 MemoryNode 的所有证据 */
  deleteByMemoryNode(memoryNodeId: string): number {
    return this.db.prepare('DELETE FROM evidence_links WHERE memory_node_id = ?').run(memoryNodeId).changes
  }

  /** 按来源 ID 查找（例如：某次对话产生了哪些记忆的证据） */
  listBySourceId(sourceId: string): EvidenceLink[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence_links WHERE source_id = ? ORDER BY created_at DESC')
      .all(sourceId) as Record<string, unknown>[]
    return rows.map((row) => this.parseLink(row))
  }
}
