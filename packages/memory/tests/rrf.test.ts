import { describe, it, expect } from 'vitest'
import { reciprocalRankFusion } from '../src/retrieval/rrf.js'
import type { RetrievalHit } from '../src/types.js'

function makeHit(content: string, score: number, layer = 'paragraph' as const): RetrievalHit {
  return {
    layer,
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

describe('reciprocalRankFusion', () => {
  it('单路输入保持原始排序', () => {
    const hits = [makeHit('A', 100), makeHit('B', 80), makeHit('C', 60)]
    const result = reciprocalRankFusion([{ signal: 'lexical', hits }])
    expect(result).toHaveLength(3)
    expect(result[0]!.content).toBe('A')
    expect(result[1]!.content).toBe('B')
    expect(result[2]!.content).toBe('C')
  })

  it('多路输入融合：两路都排第一的项得分最高', () => {
    const path1 = [makeHit('X', 90), makeHit('Y', 80)]
    const path2 = [makeHit('X', 70), makeHit('Z', 60)]
    const result = reciprocalRankFusion([
      { signal: 'lexical', hits: path1 },
      { signal: 'semantic', hits: path2 }
    ])
    // X 在两路都排第一，RRF 分数最高
    expect(result[0]!.content).toBe('X')
  })

  it('去重：相同内容不重复计算', () => {
    const hits = [makeHit('same content', 50)]
    const result = reciprocalRankFusion([
      { signal: 'lexical', hits },
      { signal: 'semantic', hits }
    ])
    // 虽然两路都有，但去重后只有一条
    expect(result).toHaveLength(1)
  })

  it('topK 限制', () => {
    const hits = Array.from({ length: 10 }, (_, i) => makeHit(`item-${i}`, 100 - i))
    const result = reciprocalRankFusion([{ signal: 'lexical', hits }], 60, 3)
    expect(result).toHaveLength(3)
  })

  it('空输入返回空', () => {
    expect(reciprocalRankFusion([])).toEqual([])
  })

  it('score 为非负数', () => {
    const hits = [makeHit('A', 10)]
    const result = reciprocalRankFusion([{ signal: 'lexical', hits }])
    expect(result[0]!.score).toBeGreaterThan(0)
  })
})
