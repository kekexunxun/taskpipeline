import { describe, it, expect } from 'vitest'
import { buildContextPack } from '../src/retrieval/context-pack.js'
import type { RetrievalHit } from '../src/types.js'

function makeHit(content: string, score: number): RetrievalHit {
  return {
    layer: 'paragraph',
    content,
    score,
    sourcePath: null,
    documentId: null,
    nodeId: null,
    nodeType: null,
    nodeTitle: null,
    metadata: null
  }
}

describe('buildContextPack', () => {
  it('空输入返回空 pack', () => {
    const pack = buildContextPack({ memoryHits: [], knowledgeHits: [] })
    expect(pack.memories).toEqual([])
    expect(pack.knowledge).toEqual([])
    expect(pack.totalTokens).toBe(0)
  })

  it('memories 优先于 knowledge', () => {
    const memories = [makeHit('memory content', 100)]
    const knowledge = [makeHit('knowledge content', 90)]
    const pack = buildContextPack({ memoryHits: memories, knowledgeHits: knowledge })
    expect(pack.memories).toHaveLength(1)
    expect(pack.knowledge).toHaveLength(1)
    expect(pack.memories[0]!.content).toBe('memory content')
  })

  it('token 预算裁剪', () => {
    // 每个 hit 约 3-5 tokens
    const memories = [makeHit('short', 100), makeHit('another short one', 90), makeHit('yet another piece of text', 80)]
    // 设置很小预算
    const pack = buildContextPack({ memoryHits: memories, knowledgeHits: [], tokenBudget: 5 })
    // 应该只能装下 1-2 条
    expect(pack.memories.length).toBeLessThanOrEqual(2)
    expect(pack.totalTokens).toBeLessThanOrEqual(5)
  })

  it('按 score 降序填充', () => {
    const memories = [makeHit('low score', 10), makeHit('high score', 100), makeHit('mid score', 50)]
    const pack = buildContextPack({ memoryHits: memories, knowledgeHits: [], tokenBudget: 10 })
    // 第一条应该是 high score
    if (pack.memories.length > 0) {
      expect(pack.memories[0]!.content).toBe('high score')
    }
  })

  it('保留检索追踪', () => {
    const traces = [
      { layer: 'paragraph' as const, signal: 'lexical' as const, hitCount: 5, topScore: 100, latencyMs: 10 }
    ]
    const pack = buildContextPack({ memoryHits: [], knowledgeHits: [], traces })
    expect(pack.retrievalTrace).toEqual(traces)
  })

  it('totalTokens 正确计算', () => {
    const memories = [makeHit('hello world test', 100)]
    const pack = buildContextPack({ memoryHits: memories, knowledgeHits: [] })
    expect(pack.totalTokens).toBeGreaterThan(0)
  })
})
