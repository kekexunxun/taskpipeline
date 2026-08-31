import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryEngine } from '../src/memory-engine.js'
import type { CandidateGenerator, CandidateGenerationInput } from '../src/reflection-pipeline.js'
import type { MemoryCandidate } from '../src/types.js'

let db: Database.Database

afterEach(() => {
  db?.close()
})

function createEngine(): MemoryEngine {
  db = new Database(':memory:')
  return new MemoryEngine(db)
}

/** 模拟 LLM CandidateGenerator */
class MockGenerator implements CandidateGenerator {
  constructor(private readonly candidates: MemoryCandidate[]) {}
  async generate(_input: CandidateGenerationInput): Promise<MemoryCandidate[]> {
    return this.candidates
  }
}

describe('ReflectionPipeline', () => {
  it('门控不通过 → 跳过', async () => {
    const engine = createEngine()
    const pipeline = engine.createReflection()
    const result = await pipeline.reflect({
      msSinceLastReflection: 1000, // 冷却期未过
      newEvidenceCount: 10,
      candidates: [
        {
          nodeType: 'constraint',
          title: 'Test',
          summary: 'Test',
          importance: 0.5,
          confidence: 0.5,
          tags: [],
          evidence: []
        }
      ]
    })
    expect(result.gatePassed).toBe(false)
    expect(result.results).toEqual([])
  })

  it('直接提供候选 → 执行晋升', async () => {
    const engine = createEngine()
    const pipeline = engine.createReflection()
    const result = await pipeline.reflect({
      msSinceLastReflection: 10 * 60 * 1000,
      newEvidenceCount: 5,
      repositoryId: 'repo-1',
      candidates: [
        {
          nodeType: 'constraint',
          title: 'Input validation required',
          summary: 'All inputs must be validated',
          importance: 0.8,
          confidence: 0.9,
          tags: ['api'],
          evidence: []
        }
      ]
    })
    expect(result.gatePassed).toBe(true)
    expect(result.candidateCount).toBe(1)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.action).toBe('create')
    expect(result.results[0]!.nodeId).toBeTruthy()
  })

  it('通过 LLM Generator 生成候选', async () => {
    const engine = createEngine()
    const generator = new MockGenerator([
      {
        nodeType: 'architecture',
        title: 'Event-driven architecture',
        summary: 'System uses event sourcing pattern',
        importance: 0.9,
        confidence: 0.85,
        tags: ['architecture'],
        evidence: [{ memoryNodeId: '', evidenceType: 'conversation', content: 'Discussed in meeting' }]
      }
    ])
    const pipeline = engine.createReflection(generator)
    const result = await pipeline.reflect({
      msSinceLastReflection: 10 * 60 * 1000,
      newEvidenceCount: 3,
      repositoryId: 'repo-1',
      evidence: [{ type: 'conversation', content: 'We decided on event sourcing' }]
    })
    expect(result.gatePassed).toBe(true)
    expect(result.candidateCount).toBe(1)
    expect(result.results[0]!.action).toBe('create')
    // 验证节点确实被创建
    const node = engine.memoryNodes.get(result.results[0]!.nodeId!)
    expect(node).toBeDefined()
    expect(node!.nodeType).toBe('architecture')
  })

  it('相似节点存在 → 自动 update', async () => {
    const engine = createEngine()
    // 先创建相似节点
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Input validation required for all API endpoints',
      summary: 'Old summary',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active',
      confidence: 0.5
    })

    const pipeline = engine.createReflection()
    const result = await pipeline.reflect({
      msSinceLastReflection: 10 * 60 * 1000,
      newEvidenceCount: 5,
      repositoryId: 'repo-1',
      candidates: [
        {
          nodeType: 'constraint',
          title: 'Input validation required for all API endpoints',
          summary: 'Updated: all inputs must go through validation middleware',
          importance: 0.9,
          confidence: 0.95,
          tags: ['api', 'validation'],
          evidence: []
        }
      ]
    })
    expect(result.results[0]!.action).toBe('update')
  })

  it('门控通过后无候选 → 空结果', async () => {
    const engine = createEngine()
    const pipeline = engine.createReflection()
    const result = await pipeline.reflect({
      msSinceLastReflection: 10 * 60 * 1000,
      newEvidenceCount: 5
      // 没有 candidates，也没有 generator
    })
    expect(result.gatePassed).toBe(true)
    expect(result.candidateCount).toBe(0)
    expect(result.results).toEqual([])
  })

  it('受保护类型不被 merge/supersede', async () => {
    const engine = createEngine()
    // 创建受保护的 constraint 节点
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Input validation required for all API endpoints',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active',
      confidence: 0.7
    })

    const pipeline = engine.createReflection()
    const result = await pipeline.reflect({
      msSinceLastReflection: 10 * 60 * 1000,
      newEvidenceCount: 5,
      repositoryId: 'repo-1',
      candidates: [
        {
          nodeType: 'constraint', // 受保护类型
          title: 'Input validation required for API',
          summary: 'New constraint',
          importance: 0.8,
          confidence: 0.9,
          tags: [],
          evidence: []
        }
      ]
    })
    // constraint 是受保护类型，不应 merge/supersede，应该 create 或 update
    const action = result.results[0]!.action
    expect(['create', 'update']).toContain(action)
  })
})
