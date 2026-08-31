import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { TaskStore } from '@task-pipeline/core'
import type { ExtractedMemoryDraft } from './memory-extractor.js'

/**
 * 使用真实 better-sqlite3 内存数据库测试 MemoryService。
 * MemoryEngine 独占 db 实例，管理 memory_nodes / knowledge 等新表。
 * 重点验证 consolidateMemories 的判重逻辑（内容级验重）。
 */
const { MemoryService } = await import('./memory-service.js')

function fakeStore(): TaskStore {
  const settings = new Map<string, string>()
  return {
    getSetting: (key: string) => settings.get(key),
    setSetting: (key: string, value: string) => {
      settings.set(key, value)
    },
    listRepositoryProfiles: () => []
  } as unknown as TaskStore
}

let service: InstanceType<typeof MemoryService>

beforeEach(() => {
  const db = new Database(':memory:')
  const store = fakeStore()
  // 让 store.db 返回真实 db
  Object.defineProperty(store, 'db', { value: db, writable: false })
  service = new MemoryService(store)
})

function draft(scope: ExtractedMemoryDraft['scope'], title: string, content: string): ExtractedMemoryDraft {
  return { scope, title, content, tags: [] }
}

/** 预置一条 user scope 记忆（判重比对基准）。 */
function seed(title: string, content: string): void {
  const engine = service.getEngine()
  engine.memoryNodes.create({
    nodeType: 'procedure',
    title,
    summary: content,
    scope: 'user',
    userId: service.ensureUserId(),
    status: 'candidate'
  })
}

describe('consolidateMemories 验重', () => {
  it('标题相同（空白差异）不重复入库', () => {
    seed('构建命令', 'npm run build')
    const saved = service.consolidateMemories([draft('user', ' 构建命令 ', '完全不同的内容也没关系')], [], 'conv-1')
    expect(saved).toBe(0)
    const nodes = service.getEngine().memoryNodes.list({ scope: 'user' })
    expect(nodes).toHaveLength(1)
  })

  it('标题不同但内容相同 → 内容级判重拦截', () => {
    seed('部署流程', '先跑 typecheck 再跑 test 最后打 tag')
    const saved = service.consolidateMemories(
      [draft('user', '上线步骤', '先跑 typecheck 再跑 test 最后打 tag')],
      [],
      'conv-1'
    )
    expect(saved).toBe(0)
    const nodes = service.getEngine().memoryNodes.list({ scope: 'user' })
    expect(nodes).toHaveLength(1)
  })

  it('内容包含关系 → 判重（一方是另一方子集）', () => {
    seed('提交规范', 'commit message 使用 conventional commits，feat/fix/chore 前缀，描述用中文')
    const saved = service.consolidateMemories(
      [draft('user', '提交规范摘要', 'conventional commits，feat/fix/chore 前缀')],
      [],
      'conv-1'
    )
    expect(saved).toBe(0)
  })

  it('内容高度相似（trigram Jaccard ≥ 0.6）→ 判重', () => {
    seed('测试命令', '运行单元测试使用 npm run test，回归使用 npm run typecheck 加全量单测套件')
    const saved = service.consolidateMemories(
      [draft('user', '单测怎么跑', '运行单元测试使用 npm run test，回归使用 npm run typecheck 加全量单测')],
      [],
      'conv-1'
    )
    expect(saved).toBe(0)
  })

  it('批内去重：同批两条标题不同但内容相同，只入库一条', () => {
    const saved = service.consolidateMemories(
      [
        draft('user', '构建方式 A', 'monorepo 用 npm workspaces，根目录统一构建'),
        draft('user', '构建方式 B', 'monorepo 用 npm workspaces，根目录统一构建')
      ],
      [],
      'conv-1'
    )
    expect(saved).toBe(1)
    const nodes = service.getEngine().memoryNodes.list({ scope: 'user' })
    expect(nodes).toHaveLength(1)
  })

  it('内容确实不同 → 正常入库', () => {
    seed('已有记忆', '前端组件库使用 shadcn/ui')
    const saved = service.consolidateMemories(
      [draft('user', '数据库', '持久层使用 better-sqlite3，WAL 模式')],
      [],
      'conv-1'
    )
    expect(saved).toBe(1)
    const nodes = service.getEngine().memoryNodes.list({ scope: 'user' })
    expect(nodes).toHaveLength(2)
  })
})

describe('CRUD 接口兼容', () => {
  it('upsertMemory 创建后 listMemories 返回旧 Memory 格式', () => {
    const memory = service.upsertMemory({
      scope: 'user',
      title: '测试记忆',
      content: '测试内容',
      tags: ['test'],
      pinned: false,
      importance: 0.5,
      source: 'manual'
    })
    expect(memory.id).toBeTruthy()
    expect(memory.title).toBe('测试记忆')
    expect(memory.content).toBe('测试内容')
    expect(memory.pinned).toBe(false)

    const list = service.listMemories({ scope: 'user' })
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('测试记忆')
    expect(list[0].content).toBe('测试内容')
  })

  it('upsertMemory 带 id 更新已有节点', () => {
    const created = service.upsertMemory({
      scope: 'user',
      title: '原始标题',
      content: '原始内容',
      tags: [],
      pinned: false,
      importance: 0.5,
      source: 'manual'
    })
    const updated = service.upsertMemory({
      id: created.id,
      scope: 'user',
      title: '新标题',
      content: '新内容',
      tags: ['updated'],
      pinned: true,
      importance: 0.8,
      source: 'manual'
    })
    expect(updated.title).toBe('新标题')
    expect(updated.content).toBe('新内容')
    expect(updated.pinned).toBe(true)
  })

  it('deleteMemory 删除非受保护节点', () => {
    const memory = service.upsertMemory({
      scope: 'user',
      title: '待删除',
      content: '内容',
      tags: [],
      pinned: false,
      importance: 0.5,
      source: 'manual'
    })
    service.deleteMemory(memory.id)
    const list = service.listMemories({ scope: 'user' })
    expect(list).toHaveLength(0)
  })

  it('deleteMemory 受保护类型只归档不删除', () => {
    const memory = service.upsertMemory({
      scope: 'user',
      title: '架构约束',
      content: '必须使用 TypeScript',
      tags: ['constraint'],
      pinned: true,
      importance: 0.9,
      source: 'manual'
    })
    service.deleteMemory(memory.id)
    // 受保护类型归档后不出现在 listMemories（只查活跃/candidate）
    const list = service.listMemories({ scope: 'user' })
    expect(list).toHaveLength(0)
    // 但节点仍在 DB 中（archived 状态）
    const node = service.getEngine().memoryNodes.get(memory.id)
    expect(node).toBeTruthy()
    expect(node!.status).toBe('archived')
  })
})

describe('启动迁移', () => {
  it('runLegacyMigration 物理删除旧表，后续调用幂等', () => {
    const db = (service.getEngine() as unknown as { db: Database.Database }).db
    // 手动建旧表（模拟迁移前的状态）
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT, repository_id TEXT, conversation_id TEXT,
          title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0.5,
          source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )
      `)
    } catch {
      /* 表可能已存在 */
    }
    db.prepare(
      `INSERT INTO memories (id, scope, user_id, title, content, tags, pinned, importance, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'legacy-1',
      'user',
      service.ensureUserId(),
      '旧记忆',
      '旧内容',
      '["legacy"]',
      1,
      0.7,
      'auto',
      new Date().toISOString(),
      new Date().toISOString()
    )

    // 执行迁移：返回 null（不再做数据迁移，仅清理旧表）
    const result = service.runLegacyMigration()
    expect(result).toBeNull()

    // 旧表已被物理删除
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").all()
    expect(tableCheck).toEqual([])

    // 重复调用安全（幂等）
    const result2 = service.runLegacyMigration()
    expect(result2).toBeNull()
  })
})

describe('零 LLM 检索', () => {
  it('search 不需要 LLM 关键词提取，直接 tokenize 走 FTS5', async () => {
    // 创建一些记忆节点
    const engine = service.getEngine()
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: 'ESLint 规范',
      summary: '所有代码必须通过 ESLint 检查，使用 prettier 格式化',
      scope: 'user',
      userId: service.ensureUserId(),
      status: 'active',
      importance: 0.8,
      tags: ['constraint', 'eslint']
    })
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '构建命令',
      summary: '使用 npm run build 构建项目，npm test 运行测试',
      scope: 'user',
      userId: service.ensureUserId(),
      status: 'active',
      importance: 0.6,
      tags: ['procedure', 'build']
    })

    // 直接搜索，不传 keywordRewriter
    const result = await service.search({
      userId: service.ensureUserId(),
      query: 'ESLint 代码检查规范'
    })

    // 应该能检索到 ESLint 相关记忆
    expect(result.memories.length).toBeGreaterThanOrEqual(1)
    expect(result.memories[0].title).toBe('ESLint 规范')
    // 关键词由 fallbackKeywords 提取，不是 LLM
    expect(result.keywords.length).toBeGreaterThan(0)
  })

  it('search 空查询返回空结果', async () => {
    const result = await service.search({
      userId: service.ensureUserId(),
      query: ''
    })
    expect(result.memories).toHaveLength(0)
    expect(result.wikiDocs).toHaveLength(0)
  })
})

describe('反思晋升', () => {
  it('runReflection: candidate 无匹配时自动晋升为 active', () => {
    const engine = service.getEngine()
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '新流程',
      summary: '完全新的内容',
      scope: 'user',
      userId: service.ensureUserId(),
      status: 'candidate',
      confidence: 0.5
    })
    const result = service.runReflection()
    expect(result.promoted).toBe(1)
    const nodes = engine.memoryNodes.list({ status: 'active' })
    expect(nodes.some((n) => n.title === '新流程')).toBe(true)
  })

  it('runReflection: candidate 与 active 标题高度相似时合并', () => {
    const engine = service.getEngine()
    const userId = service.ensureUserId()
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '构建命令',
      summary: '使用 npm run build',
      scope: 'user',
      userId,
      status: 'active',
      confidence: 0.8
    })
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '构建命令',
      summary: '增加 pnpm build 作为替代方案',
      scope: 'user',
      userId,
      status: 'candidate',
      confidence: 0.5
    })
    const result = service.runReflection()
    expect(result.merged).toBe(1)
    // 活跃节点应被合并更新
    const active = engine.memoryNodes.list({ status: 'active' })
    const buildNode = active.find((n) => n.title === '构建命令')
    expect(buildNode).toBeTruthy()
    expect(buildNode!.summary).toContain('pnpm build')
  })

  it('runReflection: 无 candidate 时返回零', () => {
    const result = service.runReflection()
    expect(result.promoted + result.merged + result.superseded).toBe(0)
  })
})

describe('生命周期维护', () => {
  it('runRetention: 过期 candidate 被标记 expired', () => {
    const engine = service.getEngine()
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '过期候选',
      summary: '超过 7 天的 candidate',
      scope: 'user',
      userId: service.ensureUserId(),
      status: 'candidate',
      confidence: 0.3
    })
    // 手动把 createdAt 改到 8 天前
    const node = engine.memoryNodes.list({ status: 'candidate' }).find((n) => n.title === '过期候选')
    expect(node).toBeTruthy()
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    engine.memoryNodes.update(node!.id, {
      /* 触发 updatedAt */
    })
    // 直接 DB 操作修改 created_at（因为 update 不允计修改 createdAt）
    const db = (engine as unknown as { db: Database.Database }).db
    db.prepare('UPDATE memory_nodes SET created_at = ? WHERE id = ?').run(eightDaysAgo, node!.id)

    const result = service.runRetention()
    expect(result.expired).toBeGreaterThanOrEqual(1)
    const expired = engine.memoryNodes.list({ status: 'expired' })
    expect(expired.some((n) => n.title === '过期候选')).toBe(true)
  })

  it('runRetention: 受保护类型不自动过期', () => {
    const engine = service.getEngine()
    engine.memoryNodes.create({
      nodeType: 'constraint',
      title: '安全约束',
      summary: '必须通过安全审查',
      scope: 'user',
      userId: service.ensureUserId(),
      status: 'candidate',
      confidence: 0.9
    })
    const node = engine.memoryNodes.list({ status: 'candidate' }).find((n) => n.title === '安全约束')
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const db = (engine as unknown as { db: Database.Database }).db
    db.prepare('UPDATE memory_nodes SET created_at = ? WHERE id = ?').run(eightDaysAgo, node!.id)

    service.runRetention()
    // 受保护类型仍然是 candidate（未被过期）
    const stillCandidate = engine.memoryNodes.get(node!.id)
    expect(stillCandidate!.status).toBe('candidate')
  })
})
