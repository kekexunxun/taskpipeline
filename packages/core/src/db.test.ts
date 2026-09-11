import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskStore } from './db.js'
import type { Task } from './types.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('TaskStore', () => {
  it('coordinates leases across two SQLite connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-db-'))
    dirs.push(dir)
    const file = join(dir, 'store.db')
    const first = new TaskStore(file)
    const task = first.createTask({ title: 'Lease', description: 'test' })
    const second = new TaskStore(file)
    expect(first.acquireLease(task.id, 'gui', 60_000)).toBe(true)
    expect(second.acquireLease(task.id, 'cli', 60_000)).toBe(false)
    first.releaseLease(task.id, 'gui')
    expect(second.acquireLease(task.id, 'cli', 60_000)).toBe(true)
    first.close()
    second.close()
  })

  it('upserts Jira tasks and associates multiple repository profiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-db-'))
    dirs.push(dir)
    const store = new TaskStore(join(dir, 'store.db'))
    const first = store.upsertJiraTask({ taskKey: 'ABC-1', title: 'Old', description: 'one' })
    const second = store.upsertJiraTask({ taskKey: 'ABC-1', title: 'New', description: 'two' })
    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({ taskKey: 'ABC-1', source: 'jira' })
    expect(store.listTasks()).toHaveLength(1)
    for (const id of ['repo-a', 'repo-b'])
      store.saveRepositoryProfile({ id, name: id, localPath: join(dir, id), defaultBranch: 'main' })
    store.attachRepository(first.id, 'repo-a')
    store.attachRepository(first.id, 'repo-b')
    store.addEvent({ taskId: first.id, kind: 'status', title: 'Started' })
    store.addApproval({ taskId: first.id, kind: 'review', context: 'Review changes' })
    expect(store.acquireLease(first.id, 'desktop')).toBe(true)
    expect(store.listTaskRepositories(first.id)).toHaveLength(2)
    store.deleteRepositoryProfile('repo-a')
    expect(store.listRepositoryProfiles().map((repo) => repo.id)).toEqual(['repo-b'])
    expect(store.listTaskRepositories(first.id)).toHaveLength(2)
    store.deleteTask(first.id)
    expect(store.getTask(first.id)).toBeUndefined()
    expect(store.listTaskRepositories(first.id)).toHaveLength(0)
    expect(store.listEvents(first.id)).toHaveLength(0)
    expect(store.listApprovals(first.id)).toHaveLength(0)
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM task_leases WHERE task_id = ?').get(first.id)).toEqual({
      count: 0
    })
    store.close()
  })

  it('does not reset workflow state or runtime fields when re-importing an existing Jira task', () => {
    // 回归:之前 upsertJiraTask 在已存在任务上透传整个 patch (含 state: "draft" + reviewStatus: "pending"),
    // 会把已 completed 的任务回退成 draft,commitMessage / qoderModel / piSessionPath / sessionUsage 全部被默认值清空。
    // 这里用模拟"任务已经跑完整条流水线"的 task 重新 upsert 一次,验证工作流和运行期字段全部保留,
    // 同时 title / description 等 Jira 内容字段按新值更新。
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-db-'))
    dirs.push(dir)
    const store = new TaskStore(join(dir, 'store.db'))
    const usage = {
      provider: 'qoder' as const,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      turns: 2
    }
    const original = store.upsertJiraTask({ taskKey: 'ABC-1', title: 'Original', description: 'v1' })
    const finalized = store.updateTask(original.id, {
      state: 'completed',
      reviewStatus: 'passed',
      commitMessage: 'feat: ABC-1',
      qoderModel: 'performance',
      piSessionPath: '/sessions/abc-1.jsonl',
      sessionUsage: usage,
      summary: 'AI 总结'
    })
    expect(finalized.state).toBe('completed')
    // 重新同步 Jira:调用方一般会传 state: "draft" + reviewStatus: "pending" (旧行为),这里要保证不被这些字段污染。
    const reimported = store.upsertJiraTask({
      taskKey: 'ABC-1',
      title: 'Updated title',
      description: 'v2',
      keywords: ['audit'],
      state: 'draft',
      reviewStatus: 'pending'
    })
    expect(reimported.id).toBe(original.id)
    // Jira 内容字段按新值更新
    expect(reimported.title).toBe('Updated title')
    expect(reimported.description).toBe('v2')
    expect(reimported.keywords).toEqual(['audit'])
    // 工作流 / 用户配置 / 运行期字段全部保留
    expect(reimported.state).toBe('completed')
    expect(reimported.reviewStatus).toBe('passed')
    expect(reimported.commitMessage).toBe('feat: ABC-1')
    expect(reimported.qoderModel).toBe('performance')
    expect(reimported.piSessionPath).toBe('/sessions/abc-1.jsonl')
    expect(reimported.sessionUsage).toEqual(usage)
    expect(reimported.summary).toBe('AI 总结')
    store.close()
  })

  it('scopes identical task keys by source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-db-'))
    dirs.push(dir)
    const store = new TaskStore(join(dir, 'store.db'))
    const local = store.createTask({ taskKey: 'ABC-1', title: 'Local', description: 'local' })
    const jira = store.upsertJiraTask({ taskKey: 'ABC-1', title: 'Jira', description: 'jira' })

    expect(local.id).not.toBe(jira.id)
    expect(store.getTaskBySourceKey('local', 'ABC-1')?.id).toBe(local.id)
    expect(store.getTaskBySourceKey('jira', 'ABC-1')?.id).toBe(jira.id)
    expect(store.listTasks()).toHaveLength(2)
    store.close()
  })

  it('migrates legacy Jira keys into generic task source fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-db-'))
    dirs.push(dir)
    const file = join(dir, 'store.db')
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, jira_key TEXT, title TEXT NOT NULL, description TEXT NOT NULL,
        keywords TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, state TEXT NOT NULL,
        summary TEXT, start_mode TEXT, plan_content TEXT, plan_revision INTEGER, failure_stage TEXT,
        review_status TEXT NOT NULL, commit_message TEXT, pi_session_path TEXT, qoder_model TEXT, session_usage TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `)
    legacy
      .prepare(
        `INSERT INTO tasks (id,jira_key,title,description,keywords,acceptance_criteria,state,review_status,created_at,updated_at)
      VALUES ('legacy','OLD-7','Legacy','Imported','[]','[]','draft','pending','2026-01-01','2026-01-01')`
      )
      .run()
    legacy.close()

    const store = new TaskStore(file)
    expect(store.getTask('legacy')).toMatchObject({ taskKey: 'OLD-7', source: 'jira' })
    expect(store.updateTask('legacy', { sourceUrl: 'https://jira.example.com/browse/OLD-7' })).toMatchObject({
      taskKey: 'OLD-7',
      source: 'jira',
      sourceUrl: 'https://jira.example.com/browse/OLD-7'
    })
    store.close()

    const reopened = new TaskStore(file)
    expect(reopened.updateTask('legacy', { source: 'github' }).source).toBe('github')
    reopened.close()
    const migratedAgain = new TaskStore(file)
    expect(migratedAgain.getTask('legacy')?.source).toBe('github')
    migratedAgain.close()
  })

  it('persists a task-specific Qoder model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-db-'))
    dirs.push(dir)
    const store = new TaskStore(join(dir, 'store.db'))
    const task = store.createTask({ title: 'Model', description: 'test', qoderModel: 'performance' })
    expect(store.getTask(task.id)?.qoderModel).toBe('performance')
    expect(store.updateTask(task.id, { qoderModel: 'ultimate' }).qoderModel).toBe('ultimate')
    store.close()
  })

  it('persists plan metadata and repository command snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-db-'))
    dirs.push(dir)
    const store = new TaskStore(join(dir, 'store.db'))
    const repo = {
      id: 'repo',
      name: 'repo',
      localPath: join(dir, 'repo'),
      defaultBranch: 'main',
      setupCommand: 'npm ci',
      lintCommand: 'npm run lint',
      testCommand: 'npm test',
      buildCommand: 'npm run build'
    }
    store.saveRepositoryProfile(repo)
    const task = store.createTask({ title: 'Plan', description: 'test' })
    const attached = store.attachRepository(task.id, repo.id)
    expect(attached.setupCommand).toBe('npm ci')
    store.updateTask(task.id, { state: 'awaiting_plan_approval', planContent: '1. edit', planRevision: 1 })
    expect(store.getTask(task.id)).toMatchObject({
      state: 'awaiting_plan_approval',
      planContent: '1. edit',
      planRevision: 1
    })
    expect(store.listTaskRepositories(task.id)[0]).toMatchObject({
      lintCommand: 'npm run lint',
      testCommand: 'npm test',
      buildCommand: 'npm run build'
    })
    store.close()
  })

  it('persists per-repository agent overrides across reopens and drops empty maps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-db-'))
    dirs.push(dir)
    const file = join(dir, 'store.db')
    const store = new TaskStore(file)
    const task = store.createTask({ title: 'Overrides', description: 'test', repoAgentIds: { repoA: 'agent-1' } })
    expect(store.getTask(task.id)?.repoAgentIds).toEqual({ repoA: 'agent-1' })
    store.close()
    // 回归基线：该字段曾因无 repo_agent_ids 列而在新建连接上读回 undefined。
    const reopened = new TaskStore(file)
    expect(reopened.getTask(task.id)?.repoAgentIds).toEqual({ repoA: 'agent-1' })
    reopened.updateTask(task.id, { repoAgentIds: { repoA: 'agent-2', repoB: 'agent-3' } })
    expect(reopened.getTask(task.id)?.repoAgentIds).toEqual({ repoA: 'agent-2', repoB: 'agent-3' })
    reopened.updateTask(task.id, { repoAgentIds: {} })
    expect(reopened.getTask(task.id)?.repoAgentIds).toBeUndefined()
    reopened.close()
  })

  it('persists mrAutoSubmit and reviewFixCount across reopens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-db-'))
    dirs.push(dir)
    const file = join(dir, 'store.db')
    const store = new TaskStore(file)
    const task = store.createTask({ title: 'Delivery', description: 'test', mrAutoSubmit: 'manual', reviewFixCount: 2 })
    expect(store.getTask(task.id)).toMatchObject({ mrAutoSubmit: 'manual', reviewFixCount: 2 })
    store.close()
    // 回归基线：reviewFixCount 曾因无 review_fix_count 列而在跨连接时丢写，使自动修订轮数上限只能活在内存里。
    const reopened = new TaskStore(file)
    expect(reopened.getTask(task.id)).toMatchObject({ mrAutoSubmit: 'manual', reviewFixCount: 2 })
    reopened.updateTask(task.id, { mrAutoSubmit: 'auto', reviewFixCount: 0 })
    expect(reopened.getTask(task.id)).toMatchObject({ mrAutoSubmit: 'auto', reviewFixCount: 0 })
    reopened.updateTask(task.id, { mrAutoSubmit: undefined })
    expect(reopened.getTask(task.id)?.mrAutoSubmit).toBeUndefined()
    reopened.close()
  })

  it('backfills mr_auto_submit exactly once from the legacy task-level boolean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pipeline-db-'))
    dirs.push(dir)
    const file = join(dir, 'store.db')
    const store = new TaskStore(file)
    store.setSetting('autoCreateMergeRequests', 'true')
    // 旧列已停止写入，只能像真实历史库那样直接改列：列里存的是 '1'/'0'，回填时必须归一为 'auto'/'manual'。
    const seed = (title: string, state: Task['state'], legacy: string | null) => {
      const task = store.createTask({ title, description: 'test' })
      store.updateTask(task.id, { state })
      if (legacy !== null)
        store.db.prepare('UPDATE tasks SET auto_create_merge_requests = ? WHERE id = ?').run(legacy, task.id)
      return task.id
    }
    const explicitOff = seed('Off', 'awaiting_commit', '0')
    const explicitOn = seed('On', 'validating', '1')
    const neverChosen = seed('Inherit', 'implementing', null)
    const done = seed('Done', 'completed', '1')
    store.close()
    // 上面的首次打开已经把回填标记写上了，先清掉它才是「改造前的历史库」。
    const raw = new Database(file)
    raw.prepare("DELETE FROM settings WHERE key = 'legacyMrAutoSubmitBackfilled'").run()
    raw.close()

    const reopened = new TaskStore(file)
    expect(reopened.getSetting('legacyMrAutoSubmitBackfilled')).toBe('1')
    expect(reopened.getTask(explicitOff)?.mrAutoSubmit).toBe('manual')
    expect(reopened.getTask(explicitOn)?.mrAutoSubmit).toBe('auto')
    // 没显式选过任务级布尔的历史任务不被系统设置固化：它的生效值本来就走 resolveMrMode 的第二步。
    expect(reopened.getTask(neverChosen)?.mrAutoSubmit).toBeUndefined()
    // 已完成任务不改写。
    expect(reopened.getTask(done)?.mrAutoSubmit).toBeUndefined()
    // 回填只跑一次：「恢复跟随」（mrAutoSubmit 置空）不能被下次打开按旧列重新固化。
    reopened.updateTask(explicitOn, { mrAutoSubmit: undefined })
    reopened.close()
    const third = new TaskStore(file)
    expect(third.getTask(explicitOn)?.mrAutoSubmit).toBeUndefined()
    expect(third.getTask(neverChosen)?.mrAutoSubmit).toBeUndefined()
    third.close()
  })
})
