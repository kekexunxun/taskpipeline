import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryEngine } from '../src/memory-engine.js'
import { migrateMemories, migrateWikiDocs } from '../src/bridge/legacy-bridge.js'
import type { LegacyMemory, LegacyWikiDoc } from '../src/bridge/legacy-bridge.js'

let db: Database.Database

afterEach(() => {
  db?.close()
})

function createEngine(): MemoryEngine {
  db = new Database(':memory:')
  return new MemoryEngine(db)
}

describe('migrateMemories', () => {
  it('迁移旧 memory 到新 MemoryNode', () => {
    const engine = createEngine()
    const memories: LegacyMemory[] = [
      {
        id: 'mem-1',
        scope: 'repo',
        repositoryId: 'repo-1',
        title: 'Use TypeScript for all modules',
        content: 'All new modules must be written in TypeScript',
        tags: ['constraint', 'typescript'],
        pinned: true,
        importance: 0.9,
        source: 'manual',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      },
      {
        id: 'mem-2',
        scope: 'user',
        userId: 'user-1',
        title: 'Architecture decision: event sourcing',
        content: 'We decided to use event sourcing for the audit module',
        tags: ['decision', 'architecture'],
        pinned: false,
        importance: 0.7,
        source: 'auto',
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z'
      }
    ]

    const result = migrateMemories(engine.memoryNodes, memories)
    expect(result.migrated).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.errors).toEqual([])

    // 验证节点
    const nodes = engine.memoryNodes.list({ repositoryId: 'repo-1' })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.nodeType).toBe('constraint')
    expect(nodes[0]!.status).toBe('active') // pinned → active
    expect(nodes[0]!.metadata!.legacyId).toBe('mem-1')

    const userNodes = engine.memoryNodes.list({ userId: 'user-1' })
    expect(userNodes).toHaveLength(1)
    expect(userNodes[0]!.nodeType).toBe('architecture') // tags=['decision','architecture'] → architecture 优先
    expect(userNodes[0]!.status).toBe('candidate') // not pinned → candidate
  })

  it('幂等：重复迁移跳过已存在的', () => {
    const engine = createEngine()
    const memories: LegacyMemory[] = [
      {
        id: 'mem-1',
        scope: 'repo',
        repositoryId: 'repo-1',
        title: 'Test',
        content: 'Test content',
        tags: ['procedure'],
        pinned: false,
        importance: 0.5,
        source: 'auto',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      }
    ]

    migrateMemories(engine.memoryNodes, memories)
    const result = migrateMemories(engine.memoryNodes, memories)
    expect(result.migrated).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('空列表返回零', () => {
    const engine = createEngine()
    const result = migrateMemories(engine.memoryNodes, [])
    expect(result.migrated).toBe(0)
    expect(result.skipped).toBe(0)
  })
})

describe('migrateWikiDocs', () => {
  it('迁移 wiki docs 到 knowledge', () => {
    const engine = createEngine()
    const docs: LegacyWikiDoc[] = [
      {
        id: 'wiki-1',
        repositoryId: 'repo-1',
        path: '/docs/architecture.md',
        title: 'Architecture Overview',
        content: '# Architecture\nThe system uses microservices',
        hash: 'abc123',
        updatedAt: '2024-01-01T00:00:00Z'
      }
    ]

    const result = migrateWikiDocs(engine.knowledge, docs)
    expect(result.migrated).toBe(1)

    const knowledgeDocs = engine.knowledge.listDocuments('repo-1')
    expect(knowledgeDocs).toHaveLength(1)
    expect(knowledgeDocs[0]!.sourcePath).toBe('/docs/architecture.md')
  })

  it('幂等：相同 hash 跳过', () => {
    const engine = createEngine()
    const docs: LegacyWikiDoc[] = [
      {
        id: 'wiki-1',
        repositoryId: 'repo-1',
        path: '/docs/a.md',
        title: 'A',
        content: 'Same content',
        hash: 'abc',
        updatedAt: '2024-01-01T00:00:00Z'
      }
    ]

    migrateWikiDocs(engine.knowledge, docs)
    const result = migrateWikiDocs(engine.knowledge, docs)
    expect(result.migrated).toBe(0)
    expect(result.skipped).toBe(1)
  })
})
