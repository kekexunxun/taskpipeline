import { describe, expect, it } from 'vitest'
import { AGENT_TASK_DISABLED, type RepoWikiDoc, type Task, type TaskRepository } from '@task-pipeline/core'
import { AgentService, createAgentDraft, generalAgent } from './agent-service.js'

/** 内存版 settings 存取，模拟 TaskStore.getSetting/setSetting。 */
function makeService(
  initial: Array<Record<string, unknown>> = [],
  listWikiDocs?: (repositoryId: string) => RepoWikiDoc[],
  resolveSystemModel?: () => { provider: 'qoder' | 'openai'; model: string } | undefined,
  isModelAvailable?: (model: string) => boolean
) {
  let raw = initial.length ? JSON.stringify(initial) : undefined
  return new AgentService(
    (key) => (key === 'agentProfiles' ? raw : undefined),
    (key, value) => {
      if (key === 'agentProfiles') raw = value
    },
    listWikiDocs,
    resolveSystemModel,
    isModelAvailable
  )
}

const repo: TaskRepository = {
  id: 'tr-1',
  taskId: 'task-1',
  repositoryId: 'r1',
  name: 'payment-service',
  localPath: '/workspaces/task-1/payment-service',
  baseBranch: 'main',
  deliveryStatus: 'pending'
}

function task(qoderModel?: string): Task {
  return {
    id: 'task-1',
    source: 'local',
    title: 'Test',
    description: 'Description',
    keywords: [],
    acceptanceCriteria: ['AC1'],
    state: 'draft',
    reviewStatus: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(qoderModel ? { qoderModel } : {})
  }
}

describe('AgentService CRUD', () => {
  it('lists 3 role agents by default and persists via save', () => {
    const service = makeService()
    const list = service.list()
    expect(list).toHaveLength(3)
    expect(list.map((a) => a.id).sort()).toEqual(
      ['builtin-reviewer', 'builtin-test-writer', 'builtin-mr-writer'].sort()
    )
    const agent = createAgentDraft('Java')
    service.save(agent)
    expect(service.list()).toHaveLength(4)
    expect(service.list().find((a) => a.id === agent.id)?.name).toBe('Java')
  })

  it('save with the same id updates in place', () => {
    const service = makeService()
    const agent = createAgentDraft('Java')
    service.save(agent)
    service.save({ ...agent, name: 'Java 服务端' })
    const list = service.list()
    expect(list.filter((a) => !a.builtin)).toHaveLength(1)
    expect(list.find((a) => a.id === agent.id)!.name).toBe('Java 服务端')
  })

  it('delete removes the agent without affecting others and tolerates missing ids', () => {
    const service = makeService()
    const a = createAgentDraft('A')
    const b = createAgentDraft('B')
    service.save(a)
    service.save(b)
    service.delete(a.id)
    expect(
      service
        .list()
        .filter((item) => !item.builtin)
        .map((item) => item.id)
    ).toEqual([b.id])
    service.delete('missing-id')
    expect(service.list().filter((item) => !item.builtin)).toHaveLength(1)
  })

  it('skips malformed entries when listing', () => {
    const service = makeService([{ id: 'broken' }])
    const list = service.list()
    expect(list.filter((a) => !a.builtin)).toEqual([])
    expect(list.filter((a) => a.builtin)).toHaveLength(3)
  })

  it('backfills builtin=true for role agents whose persisted profile is missing the flag', () => {
    // 模拟历史脏数据：settings 中持久化的角色 agent 缺 builtin 字段（前端 AgentDialog
    // 旧版 save() 不回写 builtin）。后端 list() 必须强制补齐，否则前端任务级
    // agent 下拉会把角色 agent 当成可选 Agent 暴露。
    const dirtyProfiles = [
      {
        id: 'builtin-reviewer',
        name: '代码审查员',
        description: '',
        systemPrompt: 'x',
        repositoryIds: [],
        enabled: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      },
      {
        id: 'custom-1',
        name: 'Java',
        description: '',
        systemPrompt: '',
        repositoryIds: [],
        enabled: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      }
    ]
    const service = makeService(dirtyProfiles)
    const list = service.list()
    expect(list.find((a) => a.id === 'builtin-reviewer')?.builtin).toBe(true)
    // 自定义 agent 的 builtin 仍为 undefined，filter 仍能正确识别
    expect(list.find((a) => a.id === 'custom-1')?.builtin).toBeUndefined()
  })
})

describe('AgentService resolveAgentFor', () => {
  it('matches enabled agents by repository whitelist, newest update wins', () => {
    const service = makeService()
    service.save({ ...createAgentDraft('旧'), repositoryIds: ['r1'], updatedAt: '2026-01-01T00:00:00.000Z' })
    service.save({ ...createAgentDraft('新'), repositoryIds: ['r1'], updatedAt: '2026-02-01T00:00:00.000Z' })
    service.save({
      ...createAgentDraft('禁用'),
      repositoryIds: ['r1'],
      enabled: false,
      updatedAt: '2026-03-01T00:00:00.000Z'
    })
    service.save({ ...createAgentDraft('无关'), repositoryIds: ['r2'] })
    expect(service.resolveAgentFor('r1')?.name).toBe('新')
    expect(service.resolveAgentFor('r2')?.name).toBe('无关')
    expect(service.resolveAgentFor('missing')).toBeUndefined()
  })

  it('honors an explicitly assigned agent id regardless of the whitelist', () => {
    const service = makeService()
    const agent = createAgentDraft('A', ['r1'])
    service.save(agent)
    expect(service.resolveAgentFor('r9', undefined)).toBeUndefined()
    expect(service.resolveAgentFor('r9', agent.id)?.name).toBe('A')
  })

  it('AGENT_TASK_DISABLED disables agent resolution', () => {
    const service = makeService()
    service.save({ ...createAgentDraft('A'), repositoryIds: ['r1'] })
    expect(service.resolveAgentFor('r1', AGENT_TASK_DISABLED)).toBeUndefined()
  })
})

describe('AgentService resolveRuntime', () => {
  it('prefers task.qoderModel over agent preference', () => {
    const service = makeService()
    service.save({
      ...createAgentDraft('A'),
      repositoryIds: ['r1'],
      preferredProvider: 'openai',
      preferredModel: 'gpt-5'
    })
    expect(service.resolveRuntime(task('qoder:claude-sonnet-4.5'), [repo])).toMatchObject({
      provider: 'qoder',
      model: 'qoder:claude-sonnet-4.5'
    })
  })

  it('routes `openai:` prefixed task model to the openai path', () => {
    const service = makeService()
    // Task 页面模型选择器保存的 value 是 `openai:<model>`（如 openai:DeepSeek-V4-Flash），
    // 必须按前缀识别 provider —— 否则会把 openai 模型当 Qoder 模型传给 qodercli。
    expect(service.resolveRuntime(task('openai:DeepSeek-V4-Flash'), [repo])).toEqual({
      provider: 'openai',
      model: 'openai:DeepSeek-V4-Flash'
    })
    // 历史占位值 `openai:default` 同样走 openai 路径
    expect(service.resolveRuntime(task('openai:default'), [repo]).provider).toBe('openai')
    expect(service.resolveModelForTask(task('openai:DeepSeek-V4-Flash'), [repo])).toBe('openai:DeepSeek-V4-Flash')
  })

  it('treats a legacy prefix-less task model as qoder', () => {
    const service = makeService()
    expect(service.resolveRuntime(task('claude-sonnet-4.5'), [repo]).provider).toBe('qoder')
  })

  it('routes through the agent preferred provider when paired', () => {
    const service = makeService()
    service.save({
      ...createAgentDraft('A'),
      repositoryIds: ['r1'],
      preferredProvider: 'qoder',
      preferredModel: 'qoder:gpt-5'
    })
    expect(service.resolveRuntime(task(), [repo]).provider).toBe('qoder')
    expect(service.resolveRuntime(task(), [repo]).model).toBe('qoder:gpt-5')
    service.save({
      ...createAgentDraft('B'),
      repositoryIds: ['r1'],
      preferredProvider: 'openai',
      preferredModel: 'gpt-5',
      // 显式更晚的 updatedAt：createAgentDraft 同毫秒创建时排序不稳定
      updatedAt: new Date(Date.now() + 1_000).toISOString()
    })
    expect(service.resolveRuntime(task(), [repo]).provider).toBe('openai')
  })

  it('falls back to system when the agent preference is not paired', () => {
    const service = makeService()
    service.save({ ...createAgentDraft('A'), repositoryIds: ['r1'], preferredProvider: 'qoder' })
    const runtime = service.resolveRuntime(task(), [repo])
    expect(runtime.provider).toBeUndefined()
    expect(runtime.agent?.name).toBe('A')
  })

  it('falls back when the task has no repositories', () => {
    const service = makeService()
    expect(service.resolveRuntime(task(), []).provider).toBeUndefined()
  })

  it('resolveModelForTask honors task model then agent model', () => {
    const service = makeService()
    service.save({
      ...createAgentDraft('A'),
      repositoryIds: ['r1'],
      preferredProvider: 'qoder',
      preferredModel: 'qoder:gpt-5'
    })
    expect(service.resolveModelForTask(task('qoder:claude-sonnet-4.5'), [repo])).toBe('qoder:claude-sonnet-4.5')
    expect(service.resolveModelForTask(task(), [repo])).toBe('qoder:gpt-5')
    expect(service.resolveModelForTask(task(), [])).toBeUndefined()
  })

  it('backfills the injected system default when nothing is explicitly configured', () => {
    const service = makeService([], undefined, () => ({ provider: 'qoder', model: 'qoder:system-default' }))
    expect(service.resolveRuntime(task(), [repo])).toMatchObject({
      provider: 'qoder',
      model: 'qoder:system-default'
    })
    // resolveModelForTask 同样跟随回填
    expect(service.resolveModelForTask(task(), [])).toBe('qoder:system-default')
  })

  it('keeps provider/model undefined when no resolver is injected (legacy compat)', () => {
    const service = makeService()
    const runtime = service.resolveRuntime(task(), [repo])
    expect(runtime.provider).toBeUndefined()
    expect(runtime.model).toBeUndefined()
  })

  it('drops a stale explicit model flagged by isModelAvailable and falls back to system default', () => {
    const service = makeService(
      [],
      undefined,
      () => ({ provider: 'openai', model: 'openai:fallback-model' }),
      (model) => model !== 'qoder:retired'
    )
    expect(service.resolveRuntime(task('qoder:retired'), [repo])).toMatchObject({
      provider: 'openai',
      model: 'openai:fallback-model'
    })
    // Agent 成对配置失效同样回落
    service.save({
      ...createAgentDraft('A'),
      repositoryIds: ['r1'],
      preferredProvider: 'qoder',
      preferredModel: 'qoder:retired'
    })
    expect(service.resolveRuntime(task(), [repo])).toMatchObject({
      provider: 'openai',
      model: 'openai:fallback-model'
    })
  })
})

describe('AgentService resolveAgentContext', () => {
  it('emits one section per repo with agent guidance and repo label', async () => {
    const service = makeService()
    service.save({
      ...createAgentDraft('Java'),
      repositoryIds: ['r1'],
      systemPrompt: '遵循 Result<T> 约定',
      engineeringGuidelines: '先读现有 Service 写法'
    })
    const { sections } = await service.resolveAgentContext(task(), [repo])
    expect(sections).toHaveLength(1)
    expect(sections[0]).toContain('## Agent 指引 — 仓库 payment-service')
    expect(sections[0]).toContain('遵循 Result<T> 约定')
    expect(sections[0]).toContain('先读现有 Service 写法')
  })

  it('returns no sections when no agent or empty guidance', async () => {
    const service = makeService()
    expect((await service.resolveAgentContext(task(), [repo])).sections).toEqual([])
    service.save({ ...createAgentDraft('空'), repositoryIds: ['r1'], systemPrompt: '' })
    expect((await service.resolveAgentContext(task(), [repo])).sections).toEqual([])
  })

  it('supports multiple repos with distinct labels', async () => {
    const service = makeService()
    service.save({ ...createAgentDraft('A'), repositoryIds: ['r1', 'r2'], systemPrompt: 'x' })
    const repo2: TaskRepository = {
      ...repo,
      id: 'tr-2',
      repositoryId: 'r2',
      name: 'order-console',
      localPath: '/workspaces/task-1/order-console'
    }
    const { sections } = await service.resolveAgentContext(task(), [repo, repo2])
    expect(sections).toHaveLength(2)
    expect(sections[0]).toContain('payment-service')
    expect(sections[1]).toContain('order-console')
  })
})

describe('AgentService wikiIncludePaths', () => {
  it('injects matched wiki docs verbatim into the agent section', async () => {
    const service = makeService([], (repositoryId) =>
      repositoryId === 'r1'
        ? [
            {
              id: 'w1',
              repositoryId: 'r1',
              path: 'AGENTS.md',
              title: 'Agent Instructions',
              content: '领域规范全文',
              hash: 'h1',
              updatedAt: ''
            }
          ]
        : []
    )
    service.save({
      ...createAgentDraft('Java'),
      repositoryIds: ['r1'],
      systemPrompt: '约定',
      wikiIncludePaths: ['AGENTS.md']
    })
    const { sections } = await service.resolveAgentContext(task(), [repo])
    expect(sections).toHaveLength(1)
    expect(sections[0]).toContain('### 文档 AGENTS.md')
    expect(sections[0]).toContain('领域规范全文')
    expect(sections[0]).toContain('约定')
  })

  it('skips wiki docs not listed in wikiIncludePaths', async () => {
    const service = makeService([], () => [
      {
        id: 'w1',
        repositoryId: 'r1',
        path: 'repowiki/architecture.md',
        title: '架构',
        content: '不应出现',
        hash: 'h1',
        updatedAt: ''
      }
    ])
    service.save({
      ...createAgentDraft('Java'),
      repositoryIds: ['r1'],
      systemPrompt: '约定',
      wikiIncludePaths: ['AGENTS.md']
    })
    const { sections } = await service.resolveAgentContext(task(), [repo])
    expect(sections[0]).toContain('约定')
    expect(sections[0]).not.toContain('不应出现')
  })
})

describe('AgentService helpers', () => {
  it('generalAgent is the builtin fallback with an empty system prompt', () => {
    const g = generalAgent()
    expect(g.id).toBe('builtin-general')
    expect(g.systemPrompt).toBe('')
    expect(g.builtin).toBe(true)
    expect(g.enabled).toBe(true)
  })

  it('createAgentDraft builds a fresh enabled agent with the given repositories', () => {
    const draft = createAgentDraft('Java', ['r1'])
    expect(draft.id).toBeTruthy()
    expect(draft.name).toBe('Java')
    expect(draft.repositoryIds).toEqual(['r1'])
    expect(draft.enabled).toBe(true)
    expect(draft.systemPrompt).toBe('')
  })

  it("detachRepository removes the repository from every agent's whitelist", () => {
    const a1 = createAgentDraft('A', ['r1', 'r2'])
    const a2 = createAgentDraft('B', ['r2'])
    const a3 = createAgentDraft('C', [])
    const service = makeService([
      { ...a1, updatedAt: '2026-01-01T00:00:00.000Z' },
      { ...a2, updatedAt: '2026-01-01T00:00:00.000Z' },
      { ...a3, updatedAt: '2026-01-01T00:00:00.000Z' }
    ])
    expect(service.detachRepository('r2')).toBe(2)
    const list = service.list()
    expect(list.find((item) => item.id === a1.id)?.repositoryIds).toEqual(['r1'])
    expect(list.find((item) => item.id === a2.id)?.repositoryIds).toEqual([])
    expect(list.find((item) => item.id === a3.id)?.repositoryIds).toEqual([])
  })

  it('detachRepository is a no-op when no agent binds the repository', () => {
    const service = makeService([createAgentDraft('A', ['r1'])])
    expect(service.detachRepository('r9')).toBe(0)
    expect(service.list()[0]!.repositoryIds).toEqual(['r1'])
  })
})
