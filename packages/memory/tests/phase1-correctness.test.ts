/**
 * 第一阶段正确性修复的回归测试：
 * - Knowledge FTS rowid 错配（external content 表 + 触发器 + 存量迁移）
 * - 知识检索按仓库过滤
 * - 记忆检索 OR 可见性契约
 * - expired → archived 状态机放行
 * - CJK 问句召回
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MemoryEngine } from '../src/memory-engine.js'
import { analyzeKeywords } from '../src/retrieval/keywords.js'

let db: Database.Database

afterEach(() => {
  db?.close()
})

function createEngine(): MemoryEngine {
  db = new Database(':memory:')
  return new MemoryEngine(db)
}

function indexDoc(engine: MemoryEngine, sourcePath: string, content: string, repositoryId: string): void {
  const { document } = engine.knowledge.upsertDocument({ sourcePath, sourceType: 'markdown', content, repositoryId })
  engine.knowledge.insertParagraphs([{ documentId: document.id, content, headingPath: null, tokenCount: null }])
}

describe('Knowledge FTS 与粒度表 rowid 同步', () => {
  it('文档更新后：新词可命中且返回新内容，旧词不再命中', () => {
    const engine = createEngine()
    indexDoc(engine, '/wiki/a.md', 'oldalpha 构建约定', 'repo-1')
    expect(engine.knowledge.searchParagraphs(['oldalpha'])).toHaveLength(1)

    // 覆写内容（upsertDocument 走 deleteGranularData + 重新 insert 路径）
    indexDoc(engine, '/wiki/a.md', 'newbeta 构建约定', 'repo-1')
    const hits = engine.knowledge.searchParagraphs(['newbeta'])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.content).toContain('newbeta')
    expect(engine.knowledge.searchParagraphs(['oldalpha'])).toHaveLength(0)
  })

  it('删除文档后 FTS 无残留（旧词不再命中）', () => {
    const engine = createEngine()
    indexDoc(engine, '/wiki/b.md', 'gamma独有关键词 段落', 'repo-1')
    const docs = engine.knowledge.listDocuments('repo-1')
    engine.knowledge.deleteDocument(docs[0]!.id)
    expect(engine.knowledge.searchParagraphs(['gamma独有关键词'])).toHaveLength(0)
  })

  it('旧版独立 FTS 表（rowid 错配）在引擎初始化时迁移重建', () => {
    // 手工模拟旧 schema：粒度表 + 无 content= 关联的独立 FTS，且 rowid 故意错开
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE knowledge_documents (
        id TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_type TEXT NOT NULL, content_hash TEXT NOT NULL,
        title TEXT, content TEXT NOT NULL, repository_id TEXT, redacted INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE knowledge_paragraphs (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, content TEXT NOT NULL, heading_path TEXT, token_count INTEGER
      );
      CREATE VIRTUAL TABLE knowledge_paragraphs_fts USING fts5(content, tokenize='trigram');
      INSERT INTO knowledge_paragraphs (id, document_id, content) VALUES ('p1', 'd1', 'legacyrowid 旧版存量段落');
      INSERT INTO knowledge_paragraphs_fts (rowid, content) VALUES (99, '错误残留内容 wrongcontent');
    `)
    // 新引擎初始化应检测到旧版定义 → DROP 重建 → rebuild 回填存量
    const engine = new MemoryEngine(db)
    const hits = engine.knowledge.searchParagraphs(['legacyrowid'])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.content).toContain('旧版存量段落')
    expect(engine.knowledge.searchParagraphs(['wrongcontent'])).toHaveLength(0)
  })

  it('知识检索按 repositoryIds 过滤，不串到其他仓库', () => {
    const engine = createEngine()
    indexDoc(engine, '/wiki/x.md', 'reponlysecret 甲仓库约定', 'repo-1')
    indexDoc(engine, '/wiki/y.md', 'reponlysecret 乙仓库无关内容', 'repo-2')
    const filtered = engine.knowledge.searchParagraphs(['reponlysecret'], 10, ['repo-1'])
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.content).toContain('甲仓库')
    const unfiltered = engine.knowledge.searchParagraphs(['reponlysecret'])
    expect(unfiltered).toHaveLength(2)
  })
})

describe('MemoryNode 检索可见性契约', () => {
  function seedAll(engine: MemoryEngine): void {
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '用户偏好',
      summary: '始终中文回复 preferencealwayszh',
      scope: 'user',
      userId: 'u-1',
      status: 'active'
    })
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: '甲仓库构建',
      summary: 'repomarker 使用 npm run build',
      scope: 'repo',
      repositoryId: 'r-1',
      status: 'active'
    })
    engine.memoryNodes.create({
      nodeType: 'decision',
      title: '乙仓库构建',
      summary: 'repomarker 使用 cargo check',
      scope: 'repo',
      repositoryId: 'r-2',
      status: 'active'
    })
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '本次对话结论',
      summary: 'convmarker 待办事项',
      scope: 'conversation',
      conversationId: 'c-1',
      status: 'active'
    })
  }

  it('user/repo/conversation 各自按归属分支命中（旧平铺 AND 会全部落空）', () => {
    const engine = createEngine()
    seedAll(engine)
    const hits = engine.memoryNodes.searchFts({
      keywords: ['preferencealwayszh', 'repomarker', 'convmarker'],
      visibility: { userId: 'u-1', repositoryIds: ['r-1'], conversationId: 'c-1' }
    })
    const titles = hits.map((h) => h.title).sort()
    expect(titles).toEqual(['本次对话结论', '用户偏好', '甲仓库构建'])
  })

  it('多仓库查询命中全部授权仓库，未授权的不可见', () => {
    const engine = createEngine()
    seedAll(engine)
    const both = engine.memoryNodes.searchFts({
      keywords: ['repomarker'],
      visibility: { repositoryIds: ['r-1', 'r-2'] }
    })
    expect(both.map((h) => h.title).sort()).toEqual(['乙仓库构建', '甲仓库构建'])
    const onlyOne = engine.memoryNodes.searchFts({ keywords: ['repomarker'], visibility: { repositoryIds: ['r-2'] } })
    expect(onlyOne.map((h) => h.title)).toEqual(['乙仓库构建'])
  })

  it('空 visibility 不放开权限（无任何分支可命中时返回空）', () => {
    const engine = createEngine()
    seedAll(engine)
    expect(engine.memoryNodes.searchFts({ keywords: ['repomarker'], visibility: {} })).toHaveLength(0)
  })
})

describe('状态机与维护', () => {
  it('expired → archived 合法（Retention 归档超期候选不再中断）', () => {
    const engine = createEngine()
    const node = engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '超期候选',
      scope: 'user',
      userId: 'u-1',
      status: 'candidate'
    })
    engine.memoryNodes.update(node.id, { status: 'expired' })
    const archived = engine.memoryNodes.update(node.id, { status: 'archived' })
    expect(archived.status).toBe('archived')
  })

  it('expired → active 仍然非法', () => {
    const engine = createEngine()
    const node = engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '候选',
      scope: 'user',
      userId: 'u-1',
      status: 'candidate'
    })
    engine.memoryNodes.update(node.id, { status: 'expired' })
    expect(() => engine.memoryNodes.update(node.id, { status: 'active' })).toThrow(/Invalid status transition/)
  })
})

describe('CJK 关键词分析', () => {
  it('无空格中文问句产出整段 + 3 字 n-gram', () => {
    const keywords = analyzeKeywords('支付模块的编码约定是什么')
    expect(keywords).toContain('支付模块的编码约定是什么')
    expect(keywords).toContain('支付模')
    expect(keywords).toContain('编码约')
  })

  it('中文问句通过检索流水线命中记忆', () => {
    const engine = createEngine()
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: '支付模块编码约定',
      summary: '支付模块必须使用幂等键',
      scope: 'user',
      userId: 'u-1',
      status: 'active'
    })
    const pack = engine.retrieve({
      query: '支付模块要遵守什么约定',
      taskIntent: 'general',
      visibility: { userId: 'u-1' }
    })
    expect(pack.memories.some((hit) => hit.nodeTitle === '支付模块编码约定')).toBe(true)
  })
})
