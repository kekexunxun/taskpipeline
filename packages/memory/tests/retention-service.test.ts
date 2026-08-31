import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryEngine } from '../src/memory-engine.js'

let db: Database.Database

afterEach(() => {
  db?.close()
})

function createEngine(): MemoryEngine {
  db = new Database(':memory:')
  return new MemoryEngine(db)
}

// 辅助：创建一个指定时间戳的节点
function createNodeAt(
  engine: MemoryEngine,
  overrides: {
    nodeType?: string
    status?: string
    daysAgo?: number
    title?: string
  }
) {
  const daysAgo = overrides.daysAgo ?? 0
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
  const node = engine.memoryNodes.create({
    nodeType: (overrides.nodeType as any) ?? 'incident',
    title: overrides.title ?? 'Test node',
    scope: 'repo',
    repositoryId: 'repo-1',
    status: (overrides.status as any) ?? 'active'
  })
  // 手动修改时间戳以模拟旧节点
  if (daysAgo > 0) {
    const field = overrides.status === 'candidate' ? 'created_at' : 'updated_at'
    db.prepare(`UPDATE memory_nodes SET ${field} = ? WHERE id = ?`).run(date, node.id)
  }
  return node
}

describe('RetentionService', () => {
  describe('expireCandidates', () => {
    it('超期 candidate → expired', () => {
      const engine = createEngine()
      createNodeAt(engine, { status: 'candidate', daysAgo: 10 })
      const retention = engine.createRetention({ candidateExpiryMs: 7 * 24 * 60 * 60 * 1000 })
      const expired = retention.expireCandidates(Date.now())
      expect(expired).toHaveLength(1)
      const node = engine.memoryNodes.get(expired[0]!)
      expect(node!.status).toBe('expired')
    })

    it('未超期 candidate 不变', () => {
      const engine = createEngine()
      const node = createNodeAt(engine, { status: 'candidate', daysAgo: 2 })
      const retention = engine.createRetention({ candidateExpiryMs: 7 * 24 * 60 * 60 * 1000 })
      const expired = retention.expireCandidates(Date.now())
      expect(expired).toHaveLength(0)
      expect(engine.memoryNodes.get(node.id)!.status).toBe('candidate')
    })

    it('受保护类型不自动过期', () => {
      const engine = createEngine()
      const node = createNodeAt(engine, { nodeType: 'constraint', status: 'candidate', daysAgo: 30 })
      const retention = engine.createRetention({ candidateExpiryMs: 7 * 24 * 60 * 60 * 1000 })
      const expired = retention.expireCandidates(Date.now())
      expect(expired).toHaveLength(0)
      expect(engine.memoryNodes.get(node.id)!.status).toBe('candidate')
    })
  })

  describe('markStale', () => {
    it('长时间未更新的 active → stale', () => {
      const engine = createEngine()
      createNodeAt(engine, { status: 'active', daysAgo: 35 })
      const retention = engine.createRetention({ staleThresholdMs: 30 * 24 * 60 * 60 * 1000 })
      const marked = retention.markStale(Date.now())
      expect(marked).toHaveLength(1)
      expect(engine.memoryNodes.get(marked[0]!)!.status).toBe('stale')
    })

    it('受保护类型不自动降权', () => {
      const engine = createEngine()
      const node = createNodeAt(engine, { nodeType: 'architecture', status: 'active', daysAgo: 60 })
      const retention = engine.createRetention({ staleThresholdMs: 30 * 24 * 60 * 60 * 1000 })
      const marked = retention.markStale(Date.now())
      expect(marked).toHaveLength(0)
      expect(engine.memoryNodes.get(node.id)!.status).toBe('active')
    })
  })

  describe('archiveOld', () => {
    it('超期 superseded → archived', () => {
      const engine = createEngine()
      createNodeAt(engine, { status: 'superseded', daysAgo: 100 })
      const retention = engine.createRetention({ archiveThresholdMs: 90 * 24 * 60 * 60 * 1000 })
      const archived = retention.archiveOld(Date.now())
      expect(archived).toHaveLength(1)
      expect(engine.memoryNodes.get(archived[0]!)!.status).toBe('archived')
    })

    it('未超期 superseded 不变', () => {
      const engine = createEngine()
      createNodeAt(engine, { status: 'superseded', daysAgo: 30 })
      const retention = engine.createRetention({ archiveThresholdMs: 90 * 24 * 60 * 60 * 1000 })
      const archived = retention.archiveOld(Date.now())
      expect(archived).toHaveLength(0)
    })
  })

  describe('run (full lifecycle)', () => {
    it('综合执行所有维护', () => {
      const engine = createEngine()
      createNodeAt(engine, { status: 'candidate', daysAgo: 10, title: 'old candidate' })
      createNodeAt(engine, { status: 'active', daysAgo: 35, title: 'stale active' })
      createNodeAt(engine, { status: 'superseded', daysAgo: 100, title: 'old superseded' })
      createNodeAt(engine, { status: 'active', daysAgo: 1, title: 'fresh active' })

      const retention = engine.createRetention()
      const result = retention.run(Date.now())

      expect(result.expired).toHaveLength(1)
      expect(result.markedStale).toHaveLength(1)
      expect(result.archived).toHaveLength(1)
    })
  })
})
