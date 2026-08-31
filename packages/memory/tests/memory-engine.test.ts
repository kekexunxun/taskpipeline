/**
 * MemoryEngine 初始化测试。
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryEngine } from '../src/memory-engine.js'

let db: Database.Database

afterEach(() => {
  db?.close()
})

describe('MemoryEngine', () => {
  it('初始化所有表', () => {
    db = new Database(':memory:')
    const engine = new MemoryEngine(db)

    // 验证核心表存在
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    const tableNames = tables.map((t) => t.name)

    expect(tableNames).toContain('memory_nodes')
    expect(tableNames).toContain('evidence_links')
    expect(tableNames).toContain('knowledge_documents')
    expect(tableNames).toContain('knowledge_chunks')
    expect(tableNames).toContain('knowledge_paragraphs')
    expect(tableNames).toContain('knowledge_propositions')
    expect(tableNames).toContain('knowledge_summaries')
    expect(tableNames).toContain('index_manifest')

    // 验证 FTS5 虚拟表
    expect(tableNames).toContain('memory_nodes_fts')
    expect(tableNames).toContain('knowledge_chunks_fts')
    expect(tableNames).toContain('knowledge_paragraphs_fts')
    expect(tableNames).toContain('knowledge_propositions_fts')
    expect(tableNames).toContain('knowledge_summaries_fts')

    engine.dispose()
  })

  it('幂等初始化（多次构造不报错）', () => {
    db = new Database(':memory:')
    const engine1 = new MemoryEngine(db)
    engine1.dispose()
    const engine2 = new MemoryEngine(db)
    engine2.dispose()
  })

  it('CRUD 流程：创建 MemoryNode + Evidence', () => {
    db = new Database(':memory:')
    const engine = new MemoryEngine(db)

    // 创建节点
    const node = engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Terminal states are immutable',
      summary: 'COMPLETED, FAILED, CANCELLED are terminal',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active',
      confidence: 0.95,
      importance: 0.9
    })
    expect(node.id).toBeTruthy()

    // 关联证据
    const evidence = engine.evidence.create({
      memoryNodeId: node.id,
      evidenceType: 'task',
      sourceId: 'task-123',
      content: 'Retry loop re-entered COMPLETED task'
    })
    expect(evidence.memoryNodeId).toBe(node.id)

    // 查询证据
    const links = engine.evidence.listByMemoryNode(node.id)
    expect(links).toHaveLength(1)
    expect(links[0]!.evidenceType).toBe('task')

    engine.dispose()
  })
})
