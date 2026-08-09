import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from './memory.js'

/**
 * 每次测试用临时文件 + 真实 better-sqlite3 连接（与 db.test.ts 保持一致），
 * FTS5 trigram 是 SQLite 编译期选项,必须用真实 db 实例才能触发。
 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-memory-'))
  dirs.push(dir)
  return new MemoryStore(new Database(join(dir, 'memory.db')))
}

function seedMemories(store: MemoryStore) {
  store.createMemory({
    scope: 'user',
    title: '优惠券并发幂等保护',
    content: '结算页多线程同时核销时，需要保证业务幂等键唯一性。',
    tags: ['coupon'],
    pinned: false,
    importance: 0.5,
    source: 'manual'
  })
  store.createMemory({
    scope: 'user',
    title: '事件重试策略',
    content: 'iOS 升级事件失败时，使用指数退避重试。',
    tags: ['retry'],
    pinned: false,
    importance: 0.5,
    source: 'manual'
  })
  store.createMemory({
    scope: 'repo',
    repositoryId: 'repo-1',
    title: 'MySQL 死锁排查',
    content: '高并发下 InnoDB 行锁等待导致事务回滚。',
    tags: ['db'],
    pinned: false,
    importance: 0.5,
    source: 'manual'
  })
}

describe('MemoryStore trigram search', () => {
  it('中文 ≥3 字前缀命中 trigram 索引', () => {
    const store = makeStore()
    seedMemories(store)
    const hits = store.searchMemories({ keywords: ['结算页'] })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.title).toContain('优惠券')
  })

  it('短词（<3 字）单独不命中,靠 OR 里的长词兜底', () => {
    const store = makeStore()
    seedMemories(store)
    // 仅 2 字短词：trigram 索引不到,理论上应该返回空
    const empty = store.searchMemories({ keywords: ['结算'] })
    expect(empty).toEqual([])
    // OR 合并：1 短 + 1 长 → 长词兜住
    const merged = store.searchMemories({ keywords: ['结算', '优惠券'] })
    expect(merged.some((m) => m.title.includes('优惠券'))).toBe(true)
  })

  it('英文 ≥3 字前缀匹配 (MySQL 命中含 MySQL 死锁排查 的记忆)', () => {
    const store = makeStore()
    seedMemories(store)
    const hits = store.searchMemories({ keywords: ['MySQL'] })
    expect(hits.some((m) => m.title.includes('MySQL'))).toBe(true)
  })

  it('多关键词 OR 合并：2 个不同主题都能命中', () => {
    const store = makeStore()
    seedMemories(store)
    const hits = store.searchMemories({ keywords: ['事件重试', '死锁排查'] })
    const titles = hits.map((h) => h.title)
    expect(titles.some((t) => t.includes('重试'))).toBe(true)
    expect(titles.some((t) => t.includes('死锁'))).toBe(true)
  })

  it('scope / repositoryId / limit 过滤仍生效', () => {
    const store = makeStore()
    seedMemories(store)
    const userOnly = store.searchMemories({ keywords: ['事件重试'], scopes: ['user'] })
    expect(userOnly.every((m) => m.scope === 'user')).toBe(true)
    const repoOnly = store.searchMemories({ keywords: ['死锁排查'], scopes: ['repo'], repositoryId: 'repo-1' })
    expect(repoOnly.length).toBe(1)
    expect(repoOnly[0]?.title).toContain('MySQL')
    const limited = store.searchMemories({ keywords: ['事件重试'], limit: 1 })
    expect(limited.length).toBeLessThanOrEqual(1)
  })

  it('空关键词返回空结果,不会给 FTS5 喂空 MATCH', () => {
    const store = makeStore()
    seedMemories(store)
    expect(store.searchMemories({ keywords: [] })).toEqual([])
    expect(store.searchMemories({ keywords: ['', '  '] })).toEqual([])
  })
})

describe('MemoryStore trigram migration', () => {
  it('幂等：第二次构造后 FTS5 schema 不变,数据可继续被检索', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-mig-'))
    dirs.push(dir)
    const file = join(dir, 'memory.db')
    const first = new MemoryStore(new Database(file))
    seedMemories(first)
    const beforeHits = first.searchMemories({ keywords: ['结算页'] })
    expect(beforeHits.length).toBeGreaterThan(0)

    // 第二次打开同一文件,触发 migrateFtsToTrigram；schema 已经是 trigram,应该 no-op
    const second = new MemoryStore(new Database(file))
    const afterHits = second.searchMemories({ keywords: ['结算页'] })
    expect(afterHits.length).toBe(beforeHits.length)
    // 确认 schema 里 tokenize='trigram' 真的存在
    const sql = new Database(file)
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get() as { sql?: string }
    expect(sql.sql).toContain("tokenize='trigram'")
  })

  it('从旧 unicode61 schema 迁移到 trigram + 重新填充', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-mig-old-'))
    dirs.push(dir)
    const file = join(dir, 'memory.db')
    const db = new Database(file)
    // 手工建一份旧 unicode61 schema + 数据,模拟"线上老 db"
    db.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT, repository_id TEXT, conversation_id TEXT,
        title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO memories VALUES ('m1','user',NULL,NULL,NULL,'优惠券并发幂等保护','结算页多线程核销','["a"]',0,0.5,'manual','2026-01-01','2026-01-01');
      CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, tags, content='memories', content_rowid='rowid');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      INSERT INTO memories_fts(rowid, title, content, tags) SELECT rowid, title, content, tags FROM memories;
    `)
    db.close()

    // 重新打开,应该自动迁移
    const store = new MemoryStore(new Database(file))
    const hits = store.searchMemories({ keywords: ['结算页'] })
    expect(hits.some((m) => m.title.includes('优惠券'))).toBe(true)
  })
})

describe('MemoryStore repo wiki docs trigram search', () => {
  it('keywords 数组正确驱动 FTS5 查询', () => {
    const store = makeStore()
    store.upsertRepoWikiDoc({
      repositoryId: 'repo-1',
      path: 'auth/coupon.md',
      title: '优惠券并发幂等',
      content: '结算页多线程核销,业务幂等键唯一性。',
      mtime: '2026-01-01',
      hash: 'h1'
    })
    store.upsertRepoWikiDoc({
      repositoryId: 'repo-1',
      path: 'db/deadlock.md',
      title: 'MySQL 死锁排查',
      content: 'InnoDB 行锁等待,事务回滚。',
      mtime: '2026-01-01',
      hash: 'h2'
    })
    const hits = store.searchRepoWikiDocs({ repositoryId: 'repo-1', keywords: ['结算页'] })
    expect(hits.some((h) => h.path === 'auth/coupon.md')).toBe(true)
  })
})
