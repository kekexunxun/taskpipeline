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

describe('KnowledgeStore', () => {
  describe('Documents', () => {
    it('创建文档', () => {
      const engine = createEngine()
      const { document, changed } = engine.knowledge.upsertDocument({
        sourcePath: '/docs/arch.md',
        sourceType: 'markdown',
        content: '# Architecture\nSome content here',
        title: 'Architecture Doc',
        repositoryId: 'repo-1'
      })
      expect(changed).toBe(true)
      expect(document.id).toBeTruthy()
      expect(document.sourcePath).toBe('/docs/arch.md')
      expect(document.sourceType).toBe('markdown')
      expect(document.title).toBe('Architecture Doc')
      expect(document.repositoryId).toBe('repo-1')
      expect(document.redacted).toBe(true) // default
      expect(document.contentHash).toBeTruthy()
    })

    it('相同 content hash 跳过更新', () => {
      const engine = createEngine()
      const content = '# Same content'
      const r1 = engine.knowledge.upsertDocument({
        sourcePath: '/docs/a.md',
        sourceType: 'markdown',
        content,
        repositoryId: 'repo-1'
      })
      const r2 = engine.knowledge.upsertDocument({
        sourcePath: '/docs/a.md',
        sourceType: 'markdown',
        content,
        repositoryId: 'repo-1'
      })
      expect(r2.changed).toBe(false)
      expect(r2.document.id).toBe(r1.document.id)
    })

    it('不同 content 触发更新', () => {
      const engine = createEngine()
      const r1 = engine.knowledge.upsertDocument({
        sourcePath: '/docs/a.md',
        sourceType: 'markdown',
        content: 'Version 1',
        repositoryId: 'repo-1'
      })
      const r2 = engine.knowledge.upsertDocument({
        sourcePath: '/docs/a.md',
        sourceType: 'markdown',
        content: 'Version 2',
        repositoryId: 'repo-1'
      })
      expect(r2.changed).toBe(true)
      expect(r2.document.id).toBe(r1.document.id)
      expect(r2.document.content).toBe('Version 2')
    })

    it('hasDocumentWithHash', () => {
      const engine = createEngine()
      const { document } = engine.knowledge.upsertDocument({
        sourcePath: '/a.md',
        sourceType: 'markdown',
        content: 'test'
      })
      expect(engine.knowledge.hasDocumentWithHash(document.contentHash)).toBe(true)
      expect(engine.knowledge.hasDocumentWithHash('nonexistent')).toBe(false)
    })

    it('getDocument / listDocuments', () => {
      const engine = createEngine()
      engine.knowledge.upsertDocument({
        sourcePath: '/a.md',
        sourceType: 'markdown',
        content: 'A',
        repositoryId: 'r1'
      })
      engine.knowledge.upsertDocument({
        sourcePath: '/b.md',
        sourceType: 'markdown',
        content: 'B',
        repositoryId: 'r1'
      })
      const docs = engine.knowledge.listDocuments('r1')
      expect(docs).toHaveLength(2)
    })

    it('deleteDocument 删除文档及粒度数据', () => {
      const engine = createEngine()
      const { document } = engine.knowledge.upsertDocument({
        sourcePath: '/a.md',
        sourceType: 'markdown',
        content: 'content'
      })
      // 写入 chunk
      engine.knowledge.insertChunks([
        {
          documentId: document.id,
          content: 'chunk content',
          tokenCount: 5,
          startLine: 0,
          endLine: 2,
          symbolNames: null
        }
      ])
      engine.knowledge.deleteDocument(document.id)
      expect(engine.knowledge.getDocument(document.id)).toBeUndefined()
      expect(engine.knowledge.listChunks(document.id)).toEqual([])
    })

    it('deleteByRepository', () => {
      const engine = createEngine()
      engine.knowledge.upsertDocument({
        sourcePath: '/a.md',
        sourceType: 'markdown',
        content: 'A',
        repositoryId: 'r1'
      })
      engine.knowledge.upsertDocument({
        sourcePath: '/b.md',
        sourceType: 'markdown',
        content: 'B',
        repositoryId: 'r2'
      })
      const deleted = engine.knowledge.deleteByRepository('r1')
      expect(deleted).toBe(1)
      expect(engine.knowledge.listDocuments('r1')).toEqual([])
      expect(engine.knowledge.listDocuments('r2')).toHaveLength(1)
    })
  })

  describe('Chunks', () => {
    it('批量写入 + 查询', () => {
      const engine = createEngine()
      const { document } = engine.knowledge.upsertDocument({
        sourcePath: '/code.ts',
        sourceType: 'code',
        content: 'code'
      })
      const chunks = engine.knowledge.insertChunks([
        {
          documentId: document.id,
          content: 'function hello() {}',
          tokenCount: 5,
          startLine: 0,
          endLine: 0,
          symbolNames: ['hello']
        },
        {
          documentId: document.id,
          content: 'function world() {}',
          tokenCount: 5,
          startLine: 2,
          endLine: 2,
          symbolNames: ['world']
        }
      ])
      expect(chunks).toHaveLength(2)
      expect(chunks[0]!.id).toBeTruthy()
      expect(chunks[0]!.symbolNames).toEqual(['hello'])

      const listed = engine.knowledge.listChunks(document.id)
      expect(listed).toHaveLength(2)
    })
  })

  describe('Paragraphs', () => {
    it('批量写入 + 查询', () => {
      const engine = createEngine()
      const { document } = engine.knowledge.upsertDocument({
        sourcePath: '/doc.md',
        sourceType: 'markdown',
        content: 'doc'
      })
      const paras = engine.knowledge.insertParagraphs([
        { documentId: document.id, content: '# Title\nIntro', headingPath: null, tokenCount: 10 },
        {
          documentId: document.id,
          content: '## Section A\nContent A',
          headingPath: '# Title > ## Section A',
          tokenCount: 8
        }
      ])
      expect(paras).toHaveLength(2)
      expect(paras[1]!.headingPath).toContain('Section A')

      const listed = engine.knowledge.listParagraphs(document.id)
      expect(listed).toHaveLength(2)
    })
  })

  describe('Propositions', () => {
    it('批量写入 + 查询', () => {
      const engine = createEngine()
      const { document } = engine.knowledge.upsertDocument({
        sourcePath: '/code.py',
        sourceType: 'code',
        content: 'code'
      })
      const props = engine.knowledge.insertPropositions([
        {
          documentId: document.id,
          paragraphId: null,
          content: 'Constraint: input must be valid',
          propositionType: 'constraint',
          sourcePattern: 'raise_statement'
        },
        {
          documentId: document.id,
          paragraphId: null,
          content: 'Security: rotate tokens',
          propositionType: 'security_rule',
          sourcePattern: 'security_comment'
        }
      ])
      expect(props).toHaveLength(2)
      expect(props[0]!.propositionType).toBe('constraint')

      const listed = engine.knowledge.listPropositions(document.id)
      expect(listed).toHaveLength(2)
    })
  })

  describe('Summaries', () => {
    it('批量写入 + 查询', () => {
      const engine = createEngine()
      const { document } = engine.knowledge.upsertDocument({
        sourcePath: '/module.ts',
        sourceType: 'code',
        content: 'code'
      })
      const summaries = engine.knowledge.insertSummaries([
        {
          documentId: document.id,
          content: 'This module handles auth',
          keySymbols: ['login', 'logout'],
          tokenCount: 20
        }
      ])
      expect(summaries).toHaveLength(1)
      expect(summaries[0]!.keySymbols).toEqual(['login', 'logout'])

      const listed = engine.knowledge.listSummaries(document.id)
      expect(listed).toHaveLength(1)
    })
  })

  describe('FTS5 检索', () => {
    it('searchPropositions 检索匹配', () => {
      const engine = createEngine()
      const { document } = engine.knowledge.upsertDocument({
        sourcePath: '/code.py',
        sourceType: 'code',
        content: 'code'
      })
      engine.knowledge.insertPropositions([
        {
          documentId: document.id,
          paragraphId: null,
          content: 'Constraint: input validation is required for all endpoints',
          propositionType: 'constraint',
          sourcePattern: 'raise_statement'
        },
        {
          documentId: document.id,
          paragraphId: null,
          content: 'Fact: the system uses SQLite for storage',
          propositionType: 'fact',
          sourcePattern: 'docstring'
        }
      ])

      const results = engine.knowledge.searchPropositions(['validation'])
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0]!.content).toContain('validation')
      // BM25 score 通过 CAST INTEGER 截断，小数据集可能为 0，只验证非负
      expect(results[0]!.score).toBeGreaterThanOrEqual(0)
    })

    it('searchParagraphs 检索匹配', () => {
      const engine = createEngine()
      const { document } = engine.knowledge.upsertDocument({
        sourcePath: '/doc.md',
        sourceType: 'markdown',
        content: 'doc'
      })
      engine.knowledge.insertParagraphs([
        {
          documentId: document.id,
          content: 'The authentication module handles OAuth2 flows',
          headingPath: null,
          tokenCount: 10
        }
      ])

      const results = engine.knowledge.searchParagraphs(['authentication'])
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('searchChunks 检索匹配', () => {
      const engine = createEngine()
      const { document } = engine.knowledge.upsertDocument({
        sourcePath: '/app.ts',
        sourceType: 'code',
        content: 'code'
      })
      engine.knowledge.insertChunks([
        {
          documentId: document.id,
          content: 'export function calculateTotal(items: Item[]) { return items.reduce(...) }',
          tokenCount: 15,
          startLine: 0,
          endLine: 5,
          symbolNames: ['calculateTotal']
        }
      ])

      const results = engine.knowledge.searchChunks(['calculateTotal'])
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('空关键词返回空', () => {
      const engine = createEngine()
      expect(engine.knowledge.searchPropositions([])).toEqual([])
      expect(engine.knowledge.searchParagraphs([])).toEqual([])
      expect(engine.knowledge.searchChunks([])).toEqual([])
    })
  })
})
