import { describe, it, expect } from 'vitest'
import { splitMarkdown, estimateTokens } from '../src/knowledge/markdown-chunker.js'

describe('estimateTokens', () => {
  it('英文按 ~4 字符/token', () => {
    const tokens = estimateTokens('hello world')
    expect(tokens).toBe(3) // 11 chars / 4 = 2.75 → ceil = 3
  })

  it('中文按 ~1.5 字/token', () => {
    const tokens = estimateTokens('你好世界测试')
    expect(tokens).toBe(4) // 6 CJK / 1.5 = 4
  })

  it('混合文本', () => {
    const tokens = estimateTokens('hello 你好')
    // 6 non-CJK ("hello ") + 2 CJK ("你好")
    // non-CJK: 6/4 = 1.5 → ceil(1.5 + 1.33) = ceil(2.83) = 3
    expect(tokens).toBeGreaterThanOrEqual(2)
    expect(tokens).toBeLessThanOrEqual(4)
  })

  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('splitMarkdown', () => {
  it('空文档返回空数组', () => {
    expect(splitMarkdown('')).toEqual([])
  })

  it('无 heading 的文档作为一个 chunk', () => {
    const content = 'Hello world\nThis is a paragraph'
    const chunks = splitMarkdown(content)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.headingPath).toBeNull()
    expect(chunks[0]!.content).toContain('Hello world')
  })

  it('按 heading 切分', () => {
    const content = `# Title
Some intro

## Section A
Content A

## Section B
Content B`
    const chunks = splitMarkdown(content)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks[0]!.content).toContain('# Title')
    expect(chunks[1]!.content).toContain('## Section A')
    expect(chunks[2]!.content).toContain('## Section B')
  })

  it('headingPath 记录层级', () => {
    const content = `## Architecture
### Data Layer
Some content here`
    const chunks = splitMarkdown(content)
    // 找到包含 "Some content" 的 chunk
    const dataChunk = chunks.find((c) => c.content.includes('Some content'))
    expect(dataChunk).toBeDefined()
    expect(dataChunk!.headingPath).toContain('## Architecture')
    expect(dataChunk!.headingPath).toContain('### Data Layer')
  })

  it('同级 heading 弹出上级', () => {
    const content = `## A
content a
## B
content b`
    const chunks = splitMarkdown(content)
    const chunkB = chunks.find((c) => c.content.includes('content b'))
    expect(chunkB).toBeDefined()
    // B 的 headingPath 不应包含 A
    expect(chunkB!.headingPath).not.toContain('A')
    expect(chunkB!.headingPath).toContain('## B')
  })

  it('记录行号', () => {
    const content = `# Title
line1
line2
## Section
line4`
    const chunks = splitMarkdown(content)
    expect(chunks[0]!.startLine).toBe(0)
    expect(chunks[0]!.endLine).toBeLessThan(chunks[1]!.startLine)
  })

  it('跳过空内容段', () => {
    const content = `# Title

## Empty Section

## Real Section
content here`
    const chunks = splitMarkdown(content)
    // 空 section 不应产生 chunk
    const emptyChunk = chunks.find((c) => c.content === '')
    expect(emptyChunk).toBeUndefined()
  })
})
