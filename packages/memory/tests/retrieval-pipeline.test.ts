import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryEngine } from '../src/memory-engine.js'
import { tokenize } from '../src/retrieval-pipeline.js'

let db: Database.Database

afterEach(() => {
  db?.close()
})

function createEngine(): MemoryEngine {
  db = new Database(':memory:')
  return new MemoryEngine(db)
}

describe('tokenize', () => {
  it('英文分词', () => {
    const tokens = tokenize('Hello World Authentication')
    expect(tokens).toContain('hello')
    expect(tokens).toContain('world')
    expect(tokens).toContain('authentication')
  })

  it('过滤短词', () => {
    const tokens = tokenize('I am a developer')
    expect(tokens).not.toContain('i')
    expect(tokens).not.toContain('a')
    expect(tokens).toContain('am') // 2 chars, included
    expect(tokens).toContain('developer')
  })

  it('中文分词（按空白）', () => {
    const tokens = tokenize('认证 模块 设计')
    expect(tokens).toContain('认证')
    expect(tokens).toContain('模块')
  })

  it('空字符串返回空', () => {
    expect(tokenize('')).toEqual([])
  })

  it('过滤标点', () => {
    const tokens = tokenize('hello, world! how are you?')
    expect(tokens).not.toContain(',')
    expect(tokens).not.toContain('!')
    expect(tokens).not.toContain('?')
  })
})

describe('RetrievalPipeline', () => {
  it('空查询返回空 pack', () => {
    const engine = createEngine()
    const pack = engine.retrieve({ query: '', taskIntent: 'general' })
    expect(pack.memories).toEqual([])
    expect(pack.knowledge).toEqual([])
  })

  it('检索 MemoryNode（FTS5）', () => {
    const engine = createEngine()
    // 写入一些记忆
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Terminal states are immutable',
      summary: 'COMPLETED, FAILED, CANCELLED are terminal states and cannot be modified',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active',
      confidence: 0.95,
      importance: 0.9
    })
    engine.memoryNodes.create({
      nodeType: 'architecture',
      title: 'Memory Engine Architecture',
      summary: 'The memory engine uses SQLite with FTS5 for full-text search and vector indexing',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active',
      confidence: 0.9,
      importance: 0.8
    })

    const pack = engine.retrieve({
      query: 'terminal states',
      taskIntent: 'bug_fix',
      repositoryId: 'repo-1'
    })

    // 应该检索到至少一条结果
    expect(pack.memories.length + pack.knowledge.length).toBeGreaterThanOrEqual(1)
    // 应该有检索追踪
    expect(pack.retrievalTrace.length).toBeGreaterThan(0)
  })

  it('检索 Knowledge（FTS5）', () => {
    const engine = createEngine()
    // 写入知识
    const { document } = engine.knowledge.upsertDocument({
      sourcePath: '/docs/auth.md',
      sourceType: 'markdown',
      content: '# Authentication\nOAuth2 flow implementation',
      repositoryId: 'repo-1'
    })
    engine.knowledge.insertParagraphs([
      {
        documentId: document.id,
        content: 'The authentication module handles OAuth2 authorization code flow with PKCE',
        headingPath: '# Authentication',
        tokenCount: 15
      }
    ])
    engine.knowledge.insertPropositions([
      {
        documentId: document.id,
        paragraphId: null,
        content: 'Constraint: all API endpoints require authentication token',
        propositionType: 'constraint',
        sourcePattern: 'raise_statement'
      }
    ])

    const pack = engine.retrieve({
      query: 'authentication OAuth2',
      taskIntent: 'feature_implementation',
      repositoryId: 'repo-1'
    })

    // 应该检索到知识层结果
    expect(pack.knowledge.length).toBeGreaterThanOrEqual(1)
    expect(pack.totalTokens).toBeGreaterThan(0)
  })

  it('粒度路由影响检索层', () => {
    const engine = createEngine()
    const { document } = engine.knowledge.upsertDocument({
      sourcePath: '/code.ts',
      sourceType: 'code',
      content: 'code'
    })
    engine.knowledge.insertPropositions([
      {
        documentId: document.id,
        paragraphId: null,
        content: 'Constraint: input validation required',
        propositionType: 'constraint',
        sourcePattern: 'raise_statement'
      }
    ])

    // bug_fix 优先检索 proposition
    const packBugFix = engine.retrieve({ query: 'validation', taskIntent: 'bug_fix' })
    // architecture_review 优先检索 summary
    const packArch = engine.retrieve({ query: 'validation', taskIntent: 'architecture_review' })

    // 两种 intent 都应该有结果（因为数据少，都会检索到）
    expect(packBugFix.retrievalTrace.length).toBeGreaterThan(0)
    expect(packArch.retrievalTrace.length).toBeGreaterThan(0)
  })

  it('分支感知检索', () => {
    const engine = createEngine()
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: 'Branch-specific procedure',
      summary: 'This procedure is specific to the feature branch',
      scope: 'repo',
      repositoryId: 'repo-1',
      branchName: 'feature-x',
      status: 'active'
    })
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'Global constraint',
      summary: 'This is a global constraint with no branch',
      scope: 'repo',
      repositoryId: 'repo-1',
      status: 'active'
    })

    // 检索 feature-x 分支：应该看到分支特定 + 全局
    const pack = engine.retrieve({
      query: 'constraint procedure',
      taskIntent: 'general',
      repositoryId: 'repo-1',
      branchName: 'feature-x'
    })
    expect(pack.memories.length).toBeGreaterThanOrEqual(1)
  })
})
