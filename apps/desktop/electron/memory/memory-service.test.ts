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

describe('检索可见性契约（写入→检索跨层往返）', () => {
  it('repo 记忆自动写入后按 repositoryIds 可命中，其它仓库不可见', async () => {
    service.consolidateMemories(
      [draft('repo', '支付仓库约定', 'paygate 模块统一使用幂等键 paygate-idem-key')],
      ['r-pay'],
      'conv-1'
    )
    const userId = service.ensureUserId()
    const hit = await service.search({ userId, repositoryIds: ['r-pay'], query: 'paygate-idem-key' })
    expect(hit.memories.some((m) => m.title === '支付仓库约定')).toBe(true)
    const miss = await service.search({ userId, repositoryIds: ['r-other'], query: 'paygate-idem-key' })
    expect(miss.memories.some((m) => m.title === '支付仓库约定')).toBe(false)
  })

  it('user 记忆在带 repositoryIds 的查询中不再被 AND 条件误排除', async () => {
    const userId = service.ensureUserId()
    service.upsertMemory({
      scope: 'user',
      title: '回复语言',
      content: '统一使用中文回复 userreply-zh',
      tags: [],
      pinned: false,
      importance: 0.5,
      source: 'manual'
    })
    const result = await service.search({ userId, repositoryIds: ['r-any'], query: 'userreply-zh' })
    expect(result.memories.some((m) => m.title === '回复语言')).toBe(true)
  })

  it('conversation 记忆只对所属对话可见', async () => {
    const userId = service.ensureUserId()
    service.consolidateMemories([draft('conversation', '本轮结论', '本对话临时结论 convmarker-tmp')], [], 'conv-a')
    const mine = await service.search({ userId, conversationId: 'conv-a', query: 'convmarker-tmp' })
    expect(mine.memories.some((m) => m.title === '本轮结论')).toBe(true)
    const others = await service.search({ userId, conversationId: 'conv-b', query: 'convmarker-tmp' })
    expect(others.memories.some((m) => m.title === '本轮结论')).toBe(false)
  })

  it('多仓库任务：两个仓库的记忆都能命中', async () => {
    const userId = service.ensureUserId()
    service.consolidateMemories([draft('repo', '甲约定', '多仓命中 multirepo-alpha')], ['r-1'], 'task-1')
    service.consolidateMemories([draft('repo', '乙约定', '多仓命中 multirepo-beta')], ['r-2'], 'task-2')
    const result = await service.search({ userId, repositoryIds: ['r-1', 'r-2'], query: '多仓命中' })
    expect(result.memories.map((m) => m.title).sort()).toEqual(['乙约定', '甲约定'])
  })
})

describe('置顶与生命周期解耦', () => {
  it('手工新增不置顶也是 active，立即可检索', async () => {
    const userId = service.ensureUserId()
    const memory = service.upsertMemory({
      scope: 'user',
      title: '编辑器偏好',
      content: '默认缩进两空格 editorindent-2s',
      tags: [],
      pinned: false,
      importance: 0.5,
      source: 'manual'
    })
    expect(memory.status).toBe('active')
    expect(memory.pinned).toBe(false)
    const result = await service.search({ userId, query: 'editorindent-2s' })
    expect(result.memories.some((m) => m.title === '编辑器偏好')).toBe(true)
  })

  it('置顶/取消置顶只改 metadata，不回退生命周期状态', () => {
    const memory = service.upsertMemory({
      scope: 'user',
      title: '命名风格',
      content: '变量用 camelCase',
      tags: [],
      pinned: false,
      importance: 0.5,
      source: 'manual'
    })
    const pinned = service.updateMemory(memory.id, { pinned: true })
    expect(pinned.pinned).toBe(true)
    expect(pinned.status).toBe('active')
    const unpinned = service.updateMemory(memory.id, { pinned: false })
    expect(unpinned.pinned).toBe(false)
    expect(unpinned.status).toBe('active') // 旧实现会回退到 candidate（非法转换报错/丢可见性）
  })

  it('置顶记忆在注入排序中优先', async () => {
    const userId = service.ensureUserId()
    service.upsertMemory({
      scope: 'user',
      title: '普通记忆',
      content: '排序验证 rankmarker 内容一',
      tags: [],
      pinned: false,
      importance: 0.5,
      source: 'manual'
    })
    service.upsertMemory({
      scope: 'user',
      title: '置顶记忆',
      content: '排序验证 rankmarker 内容二',
      tags: [],
      pinned: true,
      importance: 0.5,
      source: 'manual'
    })
    const result = await service.search({ userId, query: '排序验证 rankmarker' })
    expect(result.memories[0]?.title).toBe('置顶记忆')
  })
})

describe('作用域/仓库归属编辑落库', () => {
  it('user → repo 切换携带仓库归属，可见性随契约迁移', async () => {
    const userId = service.ensureUserId()
    const memory = service.upsertMemory({
      scope: 'user',
      title: '归属修正',
      content: '归属切换测试 scopeflip-marker',
      tags: [],
      pinned: false,
      importance: 0.5,
      source: 'manual'
    })
    const moved = service.updateMemory(memory.id, { scope: 'repo', repositoryId: 'r-x' })
    expect(moved.scope).toBe('repo')
    expect(moved.repositoryId).toBe('r-x')
    const asUser = await service.search({ userId, query: 'scopeflip-marker' })
    expect(asUser.memories.some((m) => m.title === '归属修正')).toBe(false)
    const asRepo = await service.search({ userId, repositoryIds: ['r-x'], query: 'scopeflip-marker' })
    expect(asRepo.memories.some((m) => m.title === '归属修正')).toBe(true)
  })

  it('切换到 repo 未选仓库时报错', () => {
    const memory = service.upsertMemory({
      scope: 'user',
      title: '无法裸切',
      content: '内容',
      tags: [],
      pinned: false,
      importance: 0.5,
      source: 'manual'
    })
    expect(() => service.updateMemory(memory.id, { scope: 'repo' })).toThrow(/仓库/)
  })
})

describe('反思分区隔离', () => {
  it('不同仓库同名约定不互并，各自独立晋升', () => {
    const engine = service.getEngine()
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: 'Build command',
      summary: 'npm run build only-for-r1',
      scope: 'repo',
      repositoryId: 'r-1',
      status: 'active'
    })
    service.consolidateMemories([draft('repo', 'Build command', 'cargo check only-for-r2')], ['r-2'], 'task-x')
    const r2Node = engine.memoryNodes.list({ scope: 'repo', repositoryId: 'r-2' })
    expect(r2Node).toHaveLength(1)
    expect(r2Node[0]!.status).toBe('active')
    expect(r2Node[0]!.summary).toBe('cargo check only-for-r2')
    // r-1 的记忆未被污染
    const r1Node = engine.memoryNodes.list({ scope: 'repo', repositoryId: 'r-1' })
    expect(r1Node[0]!.summary).toBe('npm run build only-for-r1')
  })

  it('同仓库近似标题仍然正常合并', () => {
    const engine = service.getEngine()
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '部署流程',
      summary: '先跑 typecheck same-repo-merge-a',
      scope: 'repo',
      repositoryId: 'r-m',
      status: 'active'
    })
    // 同标题草稿会在整理写入侧被查重丢弃（既有契约），合并发生在反思阶段：
    // 这里直接构造同分区 candidate 验证 runReflection 的分区内互并。
    engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '部署流程',
      summary: '再打 tag same-repo-merge-b',
      scope: 'repo',
      repositoryId: 'r-m',
      status: 'candidate'
    })
    service.runReflection()
    const nodes = engine.memoryNodes.list({ scope: 'repo', repositoryId: 'r-m', statuses: ['active'] })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.summary).toContain('same-repo-merge-a')
    expect(nodes[0]!.summary).toContain('same-repo-merge-b')
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

describe('验证分层晋升', () => {
  it('任务实现阶段结论验证前不晋升，verifyTaskMemories 翻转后晋升', () => {
    const engine = service.getEngine()
    const saved = service.consolidateMemories(
      [draft('user', '接口改造结论', '采用批量写入 refactor-bulk-write')],
      [],
      'task:t-1',
      { validation: 'implementation' }
    )
    expect(saved).toBe(1)
    const created = engine.memoryNodes.list({ scope: 'user' })[0]!
    expect(created.status).toBe('candidate')
    expect(created.metadata?.validation).toBe('implementation')
    // 再跑一轮反思：挂起候选仍不得进入 active
    service.runReflection()
    expect(engine.memoryNodes.get(created.id)!.status).toBe('candidate')
    // 任务完成：翻转 + 立即参与晋升
    expect(service.verifyTaskMemories('t-1')).toBe(1)
    const verified = engine.memoryNodes.get(created.id)!
    expect(verified.metadata?.validation).toBe('verified')
    expect(verified.status).toBe('active')
  })

  it('无验证标记的对话草稿照常晋升（不受分层逻辑影响）', () => {
    service.consolidateMemories([draft('user', '普通偏好', '喜欢简洁 plain-pref-marker')], [], 'conv-9')
    const nodes = service.getEngine().memoryNodes.list({ scope: 'user', status: 'active' })
    expect(nodes.some((n) => n.title === '普通偏好')).toBe(true)
  })

  it('verifyTaskMemories 对其他任务不越权翻转', () => {
    const engine = service.getEngine()
    service.consolidateMemories([draft('user', '甲任务数据库结论', '迁移采用 Flyway db-migration-a')], [], 'task:a', {
      validation: 'implementation'
    })
    service.consolidateMemories(
      [draft('repo', '乙任务前端结论', '弹窗改用 Portal 渲染 ui-portal-b')],
      ['r-q'],
      'task:b',
      {
        validation: 'implementation'
      }
    )
    expect(service.verifyTaskMemories('a')).toBe(1)
    const bNode = engine.memoryNodes.list({ scope: 'repo' }).find((n) => n.title === '乙任务前端结论')!
    expect(bNode.status).toBe('candidate')
    expect(bNode.metadata?.validation).toBe('implementation')
  })

  it('recordRetrievalHits 只为实际存在的节点落 retrieval_hit 证据', () => {
    const engine = service.getEngine()
    const node = engine.memoryNodes.create({
      nodeType: 'constraint',
      title: '支付约定',
      summary: '必须使用幂等键 pay-idempotent-marker',
      scope: 'user',
      userId: service.ensureUserId(),
      status: 'active'
    })
    expect(service.recordRetrievalHits([node.id, 'missing-node'], 'conv-r', '支付 幂等 约定')).toBe(1)
    const links = engine.evidence.listByMemoryNode(node.id)
    expect(links.some((l) => l.evidenceType === 'retrieval_hit' && l.sourceId === 'conv-r')).toBe(true)
  })

  it('任务期间检索命中的记忆，验证通过后获得 outcome_verified 正向证据', () => {
    const engine = service.getEngine()
    const node = engine.memoryNodes.create({
      nodeType: 'procedure',
      title: '构建命令约定',
      summary: 'npm run build 一次通过 build-once-marker',
      scope: 'repo',
      repositoryId: 'r-v',
      status: 'active'
    })
    engine.evidence.create({
      memoryNodeId: node.id,
      evidenceType: 'retrieval_hit',
      sourceId: 'task:tv',
      content: '构建命令'
    })
    // 无待翻转草稿，但验证事件仍应关联到命中过的记忆
    expect(service.verifyTaskMemories('tv')).toBe(0)
    const links = engine.evidence.listByMemoryNode(node.id)
    expect(links.filter((l) => l.evidenceType === 'outcome_verified')).toHaveLength(1)
    // 其他任务的检索命中不受波及
    expect(service.verifyTaskMemories('other')).toBe(0)
    expect(engine.evidence.listByMemoryNode(node.id).filter((l) => l.evidenceType === 'outcome_verified')).toHaveLength(
      1
    )
  })
})
