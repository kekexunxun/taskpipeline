import { describe, it, expect } from 'vitest'
import {
  extractPropositionsFromCode,
  extractPropositionsFromMarkdown,
  extractPropositions
} from '../src/knowledge/proposition-extractor.js'

describe('extractPropositionsFromCode', () => {
  it('提取 SECURITY 注释', () => {
    const code = `// SECURITY: Token must be rotated every 90 days`
    const props = extractPropositionsFromCode(code)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('security_rule')
    expect(props[0]!.sourcePattern).toBe('security_comment')
    expect(props[0]!.content).toContain('Token must be rotated')
  })

  it('提取 Python SECURITY 注释', () => {
    const code = `# SECURITY: Never log PII data`
    const props = extractPropositionsFromCode(code)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('security_rule')
  })

  it('提取 raise 语句', () => {
    const code = `raise ValueError("Invalid input provided")`
    const props = extractPropositionsFromCode(code)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('constraint')
    expect(props[0]!.sourcePattern).toBe('raise_statement')
    expect(props[0]!.content).toContain('ValueError')
    expect(props[0]!.content).toContain('Invalid input')
  })

  it('提取 throw 语句', () => {
    const code = `throw new Error("Connection timeout")`
    const props = extractPropositionsFromCode(code)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('constraint')
    expect(props[0]!.content).toContain('Error')
  })

  it('提取 assert 语句', () => {
    const code = `assert user.is_authenticated, "User must be logged in"`
    const props = extractPropositionsFromCode(code)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('constraint')
    expect(props[0]!.sourcePattern).toBe('assert_statement')
  })

  it('提取 TODO/FIXME', () => {
    const code = `// TODO: Implement retry logic for flaky connections`
    const props = extractPropositionsFromCode(code)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('risk')
    expect(props[0]!.sourcePattern).toBe('todo_fixme')
    expect(props[0]!.content).toContain('TODO')
  })

  it('提取 FIXME', () => {
    const code = `# FIXME: Memory leak in connection pool`
    const props = extractPropositionsFromCode(code)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('risk')
  })

  it('提取 docstring', () => {
    const code = `"""This module handles user authentication and session management."""`
    const props = extractPropositionsFromCode(code)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('fact')
    expect(props[0]!.sourcePattern).toBe('docstring')
  })

  it('跳过装饰性 docstring（Args/Returns/Raises）', () => {
    const code = `"""Args: user_id (str): The user identifier."""`
    const props = extractPropositionsFromCode(code)
    expect(props).toHaveLength(0)
  })

  it('跳过太短的 docstring', () => {
    const code = `"""Short."""`
    const props = extractPropositionsFromCode(code)
    expect(props).toHaveLength(0)
  })

  it('多行代码提取多个 proposition', () => {
    const code = `
# SECURITY: Rate limit all API endpoints
def process():
    """Process the incoming request and validate permissions."""
    if not valid:
        raise ValueError("Request validation failed")
    # TODO: Add caching layer
`
    const props = extractPropositionsFromCode(code)
    expect(props.length).toBeGreaterThanOrEqual(3)
    const types = props.map((p) => p.propositionType)
    expect(types).toContain('security_rule')
    expect(types).toContain('fact')
    expect(types).toContain('constraint')
    expect(types).toContain('risk')
  })

  it('空代码返回空数组', () => {
    expect(extractPropositionsFromCode('')).toEqual([])
  })
})

describe('extractPropositionsFromMarkdown', () => {
  it('提取列表项为 fact', () => {
    const md = `- The system uses SQLite for local storage`
    const props = extractPropositionsFromMarkdown(md)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('fact')
    expect(props[0]!.sourcePattern).toBe('markdown_bullet')
  })

  it('提取含 MUST/NEVER 的列表项为 constraint', () => {
    const md = `- Users MUST verify their email before accessing the system`
    const props = extractPropositionsFromMarkdown(md)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('constraint')
  })

  it('提取 decision 类型的列表项', () => {
    const md = `- Decision: Use TypeScript for all new modules`
    const props = extractPropositionsFromMarkdown(md)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('decision')
  })

  it('提取粗体约束', () => {
    const md = `**MUST** Run all tests before merging`
    const props = extractPropositionsFromMarkdown(md)
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('constraint')
    expect(props[0]!.content).toContain('MUST')
  })

  it('跳过太短的列表项', () => {
    const md = `- Hi`
    const props = extractPropositionsFromMarkdown(md)
    expect(props).toHaveLength(0)
  })

  it('混合内容', () => {
    const md = `# Architecture

- The backend uses Node.js with Express
- **NEVER** expose internal APIs directly
- Decision: Chose PostgreSQL over MySQL
- Simple text paragraph
`
    const props = extractPropositionsFromMarkdown(md)
    expect(props.length).toBeGreaterThanOrEqual(3)
  })
})

describe('extractPropositions (router)', () => {
  it('markdown 类型走 Markdown 提取器', () => {
    const props = extractPropositions('- This is a fact about the system', 'markdown')
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('fact')
  })

  it('adr 类型走 Markdown 提取器', () => {
    const props = extractPropositions('- Decision: Use AME design pattern', 'adr')
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('decision')
  })

  it('code 类型走 Code 提取器', () => {
    const props = extractPropositions('raise ValueError("bad input")', 'code')
    expect(props).toHaveLength(1)
    expect(props[0]!.propositionType).toBe('constraint')
  })

  it('test_report / log / diff 暂不提取', () => {
    expect(extractPropositions('some content', 'test_report')).toEqual([])
    expect(extractPropositions('some content', 'log')).toEqual([])
    expect(extractPropositions('some content', 'diff')).toEqual([])
  })
})
