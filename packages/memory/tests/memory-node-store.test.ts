/**
 * MemoryNodeStore 单元测试。
 *
 * 覆盖：CRUD、状态机转换、FTS5 检索、分支感知、受保护类型。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { ALL_DDL } from '../src/schema.js'
import { MemoryNodeStore } from '../src/memory-node-store.js'

let db: Database.Database
let store: MemoryNodeStore

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const ddl of ALL_DDL) db.exec(ddl)
  store = new MemoryNodeStore(db)
})

afterEach(() => {
  db.close()
})

describe('MemoryNodeStore', () => {
  describe('create', () => {
    it('创建节点并赋默认值', () => {
      const node = store.create({
        nodeType: 'constraint',
        title: 'Terminal states are immutable',
        scope: 'repo',
        repositoryId: 'repo-1'
      })
      expect(node.id).toBeTruthy()
      expect(node.status).toBe('candidate')
      expect(node.confidence).toBe(0.5)
      expect(node.importance).toBe(0.5)
      expect(node.source).toBe('auto')
      expect(node.tags).toEqual([])
      expect(node.parentId).toBeNull()
    })

    it('支持自定义所有字段', () => {
      const node = store.create({
        nodeType: 'decision',
        title: 'Use SQLite over PostgreSQL',
        summary: 'Zero-infra local deployment',
        status: 'active',
        confidence: 0.9,
        importance: 0.8,
        scope: 'repo',
        repositoryId: 'repo-1',
        branchName: 'feature/sqlite',
        tags: ['database', 'architecture'],
        source: 'seed'
      })
      expect(node.status).toBe('active')
      expect(node.confidence).toBe(0.9)
      expect(node.tags).toEqual(['database', 'architecture'])
      expect(node.branchName).toBe('feature/sqlite')
      expect(node.source).toBe('seed')
    })
  })

  describe('get / update / delete', () => {
    it('get 返回已创建的节点', () => {
      const created = store.create({ nodeType: 'incident', title: 'Retry loop bug', scope: 'repo' })
      const fetched = store.get(created.id)
      expect(fetched).toBeDefined()
      expect(fetched!.title).toBe('Retry loop bug')
    })

    it('get 不存在返回 undefined', () => {
      expect(store.get('nonexistent')).toBeUndefined()
    })

    it('update 修改字段', () => {
      const node = store.create({ nodeType: 'procedure', title: 'Deploy steps', scope: 'user', status: 'candidate' })
      const updated = store.update(node.id, { title: 'Updated deploy steps', status: 'active', confidence: 0.8 })
      expect(updated.title).toBe('Updated deploy steps')
      expect(updated.status).toBe('active')
      expect(updated.confidence).toBe(0.8)
    })

    it('delete 删除节点', () => {
      const node = store.create({ nodeType: 'module', title: 'Auth module', scope: 'repo' })
      store.delete(node.id)
      expect(store.get(node.id)).toBeUndefined()
    })
  })

  describe('状态机', () => {
    it('合法转换：candidate → active', () => {
      const node = store.create({ nodeType: 'constraint', title: 'Auth rule', scope: 'user', status: 'candidate' })
      const updated = store.update(node.id, { status: 'active' })
      expect(updated.status).toBe('active')
    })

    it('合法转换：active → stale → archived', () => {
      const node = store.create({ nodeType: 'incident', title: 'Bug', scope: 'repo', status: 'active' })
      store.update(node.id, { status: 'stale' })
      const archived = store.update(node.id, { status: 'archived' })
      expect(archived.status).toBe('archived')
    })

    it('非法转换抛错：candidate → archived', () => {
      const node = store.create({ nodeType: 'decision', title: 'Choice', scope: 'user', status: 'candidate' })
      expect(() => store.update(node.id, { status: 'archived' })).toThrow('Invalid status transition')
    })

    it('非法转换抛错：expired → active', () => {
      const node = store.create({ nodeType: 'procedure', title: 'Step', scope: 'user', status: 'candidate' })
      store.update(node.id, { status: 'expired' })
      expect(() => store.update(node.id, { status: 'active' })).toThrow('Invalid status transition')
    })

    it('promote 快捷方法', () => {
      const node = store.create({ nodeType: 'constraint', title: 'Rule', scope: 'user', status: 'candidate' })
      const promoted = store.promote(node.id, 0.95)
      expect(promoted.status).toBe('active')
      expect(promoted.confidence).toBe(0.95)
    })

    it('promote 非 candidate 抛错', () => {
      const node = store.create({ nodeType: 'constraint', title: 'Rule', scope: 'user', status: 'active' })
      expect(() => store.promote(node.id)).toThrow('Cannot promote non-candidate')
    })
  })

  describe('list', () => {
    it('按 scope 过滤', () => {
      store.create({ nodeType: 'constraint', title: 'User pref', scope: 'user', userId: 'u1' })
      store.create({ nodeType: 'decision', title: 'Repo decision', scope: 'repo', repositoryId: 'r1' })
      const userNodes = store.list({ scope: 'user' })
      expect(userNodes).toHaveLength(1)
      expect(userNodes[0]!.title).toBe('User pref')
    })

    it('按 status 过滤', () => {
      store.create({ nodeType: 'constraint', title: 'Active', scope: 'user', status: 'active' })
      store.create({ nodeType: 'constraint', title: 'Stale', scope: 'user', status: 'stale' })
      const active = store.list({ status: 'active' })
      expect(active).toHaveLength(1)
      expect(active[0]!.title).toBe('Active')
    })

    it('按 nodeType 过滤', () => {
      store.create({ nodeType: 'constraint', title: 'C1', scope: 'user' })
      store.create({ nodeType: 'incident', title: 'I1', scope: 'user' })
      const constraints = store.list({ nodeType: 'constraint' })
      expect(constraints).toHaveLength(1)
    })

    it('按 branchName 过滤', () => {
      store.create({ nodeType: 'decision', title: 'Feature', scope: 'repo', branchName: 'feat/x' })
      store.create({ nodeType: 'decision', title: 'Main', scope: 'repo', branchName: 'main' })
      const featNodes = store.list({ branchName: 'feat/x' })
      expect(featNodes).toHaveLength(1)
      expect(featNodes[0]!.title).toBe('Feature')
    })
  })

  describe('listChildren', () => {
    it('返回子节点', () => {
      const parent = store.create({ nodeType: 'module', title: 'Scheduler', scope: 'repo', status: 'active' })
      store.create({
        nodeType: 'constraint',
        title: 'Terminal states',
        scope: 'repo',
        parentId: parent.id,
        status: 'active'
      })
      store.create({ nodeType: 'incident', title: 'Retry bug', scope: 'repo', parentId: parent.id, status: 'active' })
      const children = store.listChildren(parent.id)
      expect(children).toHaveLength(2)
    })
  })

  describe('searchFts', () => {
    it('按关键词检索活跃节点', () => {
      store.create({
        nodeType: 'constraint',
        title: 'Terminal state immutability',
        summary: 'COMPLETED and FAILED are terminal',
        scope: 'repo',
        status: 'active'
      })
      store.create({
        nodeType: 'incident',
        title: 'Retry loop re-entered terminal task',
        summary: 'Race condition in retry',
        scope: 'repo',
        status: 'active'
      })
      store.create({
        nodeType: 'decision',
        title: 'Use PostgreSQL',
        summary: 'For production data',
        scope: 'repo',
        status: 'candidate'
      })

      const results = store.searchFts({ keywords: ['terminal'], scopes: ['repo'] })
      // candidate 状态不参与检索
      expect(results.every((r) => r.status !== 'candidate')).toBe(true)
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('空关键词返回空', () => {
      const results = store.searchFts({ keywords: [] })
      expect(results).toEqual([])
    })
  })

  describe('受保护类型', () => {
    it('constraint / security_rule / architecture / decision 受保护', () => {
      expect(store.isProtected('constraint')).toBe(true)
      expect(store.isProtected('security_rule')).toBe(true)
      expect(store.isProtected('architecture')).toBe(true)
      expect(store.isProtected('decision')).toBe(true)
    })

    it('incident / procedure / module 不受保护', () => {
      expect(store.isProtected('incident')).toBe(false)
      expect(store.isProtected('procedure')).toBe(false)
      expect(store.isProtected('module')).toBe(false)
    })
  })

  describe('updateAncestorSummaries', () => {
    it('更新父节点摘要为活跃子节点的汇总', () => {
      const parent = store.create({ nodeType: 'module', title: 'Core', scope: 'repo', status: 'active' })
      store.create({
        nodeType: 'constraint',
        title: 'Rule A',
        scope: 'repo',
        parentId: parent.id,
        status: 'active',
        summary: 'Always validate input'
      })
      store.create({
        nodeType: 'constraint',
        title: 'Rule B',
        scope: 'repo',
        parentId: parent.id,
        status: 'stale',
        summary: 'Old rule'
      })
      store.create({
        nodeType: 'decision',
        title: 'Choice C',
        scope: 'repo',
        parentId: parent.id,
        status: 'active',
        summary: 'Use event sourcing'
      })

      store.updateAncestorSummaries(parent.id)
      const updated = store.get(parent.id)!
      expect(updated.summary).toContain('Rule A')
      expect(updated.summary).toContain('Choice C')
      // stale 状态的子节点不参与摘要
      expect(updated.summary).not.toContain('Rule B')
    })
  })

  describe('deleteMany', () => {
    it('按 repositoryId 批量删除', () => {
      store.create({ nodeType: 'constraint', title: 'R1', scope: 'repo', repositoryId: 'repo-1' })
      store.create({ nodeType: 'constraint', title: 'R2', scope: 'repo', repositoryId: 'repo-1' })
      store.create({ nodeType: 'constraint', title: 'R3', scope: 'repo', repositoryId: 'repo-2' })
      const deleted = store.deleteMany({ repositoryId: 'repo-1' })
      expect(deleted).toBe(2)
      expect(store.list()).toHaveLength(1)
    })
  })
})
