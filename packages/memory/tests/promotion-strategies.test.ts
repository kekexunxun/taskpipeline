import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryEngine } from '../src/memory-engine.js'
import {
  computeTitleSimilarity,
  decideAction,
  executePromotion,
  findBestMatch
} from '../src/reflection/promotion-strategies.js'
import type { MemoryCandidate } from '../src/types.js'

let db: Database.Database

afterEach(() => {
  db?.close()
})

function createEngine(): MemoryEngine {
  db = new Database(':memory:')
  return new MemoryEngine(db)
}

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    nodeType: 'constraint',
    title: 'Input validation required',
    summary: 'All API inputs must be validated',
    importance: 0.8,
    confidence: 0.9,
    tags: ['api', 'validation'],
    evidence: [],
    ...overrides
  }
}

describe('computeTitleSimilarity', () => {
  it('完全相同标题 → 1.0', () => {
    expect(computeTitleSimilarity('hello world', 'hello world')).toBe(1)
  })

  it('完全不同 → 0', () => {
    expect(computeTitleSimilarity('hello world', 'foo bar')).toBe(0)
  })

  it('部分重叠 → 0-1 之间', () => {
    const sim = computeTitleSimilarity('input validation required', 'input validation check')
    expect(sim).toBeGreaterThan(0)
    expect(sim).toBeLessThan(1)
  })

  it('空字符串 → 0', () => {
    expect(computeTitleSimilarity('', 'hello')).toBe(0)
    expect(computeTitleSimilarity('hello', '')).toBe(0)
  })
})

describe('findBestMatch', () => {
  it('无现有节点 → null', () => {
    const engine = createEngine()
    const match = findBestMatch(engine.memoryNodes, makeCandidate())
    expect(match).toBeNull()
  })

  it('找到高相似节点', () => {
    const engine = createEngine()
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Input validation required for all endpoints',
      summary: 'All inputs must be validated',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active'
    })
    const match = findBestMatch(engine.memoryNodes, makeCandidate(), 'repo-1')
    expect(match).not.toBeNull()
    expect(match!.similarity).toBeGreaterThan(0.3)
  })

  it('跳过非活跃节点', () => {
    const engine = createEngine()
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Input validation required',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'superseded'
    })
    const match = findBestMatch(engine.memoryNodes, makeCandidate(), 'repo-1')
    expect(match).toBeNull()
  })
})

describe('decideAction', () => {
  it('无匹配 → create', () => {
    expect(decideAction(makeCandidate(), null)).toBe('create')
  })

  it('高相似 → update', () => {
    const match = { node: {} as any, similarity: 0.9, matchReason: 'test' }
    expect(decideAction(makeCandidate(), match)).toBe('update')
  })

  it('中相似 + 非受保护 → merge', () => {
    const match = { node: {} as any, similarity: 0.6, matchReason: 'test' }
    expect(decideAction(makeCandidate({ nodeType: 'incident' }), match)).toBe('merge')
  })

  it('中相似 + 受保护 → create（不 merge）', () => {
    const match = { node: {} as any, similarity: 0.6, matchReason: 'test' }
    expect(decideAction(makeCandidate({ nodeType: 'constraint' }), match)).toBe('create')
  })

  it('低相似 + 非受保护 → supersede', () => {
    const match = { node: {} as any, similarity: 0.4, matchReason: 'test' }
    expect(decideAction(makeCandidate({ nodeType: 'incident' }), match)).toBe('supersede')
  })
})

describe('executePromotion', () => {
  it('create：创建新节点', () => {
    const engine = createEngine()
    const candidate = makeCandidate()
    const result = executePromotion('create', candidate, null, engine.memoryNodes, engine.evidence, 'repo', 'repo-1')
    expect(result.action).toBe('create')
    expect(result.nodeId).toBeTruthy()
    const node = engine.memoryNodes.get(result.nodeId!)
    expect(node).toBeDefined()
    expect(node!.title).toBe(candidate.title)
    expect(node!.status).toBe('candidate')
  })

  it('update：更新现有节点', () => {
    const engine = createEngine()
    const existing = engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Input validation',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active',
      confidence: 0.5
    })
    const match = { node: existing, similarity: 0.9, matchReason: 'test' }
    const candidate = makeCandidate({ confidence: 0.95 })
    const result = executePromotion('update', candidate, match, engine.memoryNodes, engine.evidence)
    expect(result.action).toBe('update')
    expect(result.nodeId).toBe(existing.id)
    const updated = engine.memoryNodes.get(existing.id)
    expect(updated!.confidence).toBe(0.95) // max(0.5, 0.95)
  })

  it('discard：不创建节点', () => {
    const engine = createEngine()
    const result = executePromotion('discard', makeCandidate(), null, engine.memoryNodes, engine.evidence)
    expect(result.action).toBe('discard')
    expect(result.nodeId).toBeNull()
  })

  it('supersede：标记旧节点 + 创建新节点', () => {
    const engine = createEngine()
    const existing = engine.memoryNodes.create({
      nodeType: 'incident',
      title: 'Old issue',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active'
    })
    const match = { node: existing, similarity: 0.4, matchReason: 'test' }
    const result = executePromotion(
      'supersede',
      makeCandidate({ nodeType: 'incident' }),
      match,
      engine.memoryNodes,
      engine.evidence,
      'repo',
      'repo-1'
    )
    expect(result.action).toBe('supersede')
    expect(result.nodeId).toBeTruthy()
    expect(result.mergedWithId).toBe(existing.id)
    // 旧节点被标记为 superseded
    const oldNode = engine.memoryNodes.get(existing.id)
    expect(oldNode!.status).toBe('superseded')
  })

  it('needs_review：创建带标记的节点', () => {
    const engine = createEngine()
    const result = executePromotion(
      'needs_review',
      makeCandidate(),
      null,
      engine.memoryNodes,
      engine.evidence,
      'repo',
      'repo-1'
    )
    expect(result.action).toBe('needs_review')
    expect(result.nodeId).toBeTruthy()
    const node = engine.memoryNodes.get(result.nodeId!)
    expect(node!.tags).toContain('needs_review')
    expect(node!.metadata).toBeDefined()
    expect((node!.metadata as any).needsReview).toBe(true)
  })
})
