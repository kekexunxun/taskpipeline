import type * as FsModule from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession, CreateAgentSessionOptions, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Task, TaskRepository, TaskStore } from '@task-pipeline/core'
import { createPiMemorySearchTool, type MemorySearchTarget } from '../memory/memory-search-tool.js'

const sdk = vi.hoisted(() => {
  const files = new Set<string>()
  let sequence = 0
  const manager = (file: string) => ({ getSessionFile: () => file })
  const createAgentSession = vi.fn(async (options: CreateAgentSessionOptions) => {
    const file = options.sessionManager!.getSessionFile()!
    files.add(file)
    return {
      session: {
        sessionId: `session-${sequence}`,
        sessionFile: file,
        isIdle: true,
        bindExtensions: vi.fn(async (_options: Parameters<AgentSession['bindExtensions']>[0]) => undefined),
        subscribe: vi.fn(() => vi.fn()),
        dispose: vi.fn(),
        abort: vi.fn(async () => undefined)
      },
      extensionsResult: { errors: [] }
    }
  })
  return {
    files,
    createAgentSession,
    create: vi.fn(() => manager(`/data/pi-sessions/new-${++sequence}.jsonl`)),
    open: vi.fn((file: string) => manager(file)),
    forkFrom: vi.fn(() => {
      const file = `/data/pi-sessions/fork-${++sequence}.jsonl`
      files.add(file)
      return manager(file)
    })
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  const existsSync = (path: string) => sdk.files.has(path)
  return { ...actual, existsSync, default: { ...actual, existsSync } }
})
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: sdk.createAgentSession,
  SessionManager: { create: sdk.create, open: sdk.open, forkFrom: sdk.forkFrom },
  SettingsManager: { create: () => ({}) },
  ModelRuntime: { create: async () => ({}) },
  DefaultResourceLoader: class {
    async reload() {}
  },
  getAgentDir: () => '/data/pi-agent',
  hasTrustRequiringProjectResources: () => false
}))

const { initPiSession, ensurePiSession, releasePiSession, releaseAllPiSessions, forkPiStage } = await import(
  './pi-session.js'
)

const tasks = new Map<string, Task>()
const repos = new Map<string, TaskRepository[]>()
const search = vi.fn<MemorySearchTarget['search']>()
const resolveMemoryTools = vi.fn((task: Task, repositories: TaskRepository[]) => [
  createPiMemorySearchTool({
    userId: 'user-1',
    repositoryIds: repositories.map((repo) => repo.repositoryId),
    conversationId: `task:${task.id}`,
    memoryService: { search }
  })
])

function addTask(id: string, repositoryIds: string[]) {
  tasks.set(id, { id, title: id } as Task)
  repos.set(
    id,
    repositoryIds.map((repositoryId) => ({
      repositoryId,
      localPath: `/repos/${repositoryId}`,
      worktreePath: `/worktrees/${id}/${repositoryId}`
    })) as TaskRepository[]
  )
}

async function searchFromSession(index: number, query: string) {
  const tool = sdk.createAgentSession.mock.calls[index]![0].customTools!.find((item) => item.name === 'search_memory')!
  return tool.execute(`call-${index}`, { query }, undefined, undefined, {} as ExtensionContext)
}

beforeEach(() => {
  vi.clearAllMocks()
  sdk.files.clear()
  tasks.clear()
  repos.clear()
  search.mockResolvedValue({ memories: [], wikiDocs: [], keywords: [] })
  addTask('task-1', ['repo-1', 'repo-2'])
  initPiSession({
    store: {
      getTask: (id: string) => tasks.get(id),
      listTaskRepositories: (id: string) => repos.get(id) ?? [],
      getSetting: () => undefined,
      updateTask: (id: string, patch: Partial<Task>) => {
        Object.assign(tasks.get(id)!, patch)
      }
    } as unknown as TaskStore,
    dataDir: '/data',
    tracePipeline: {} as Parameters<typeof initPiSession>[0]['tracePipeline'],
    protectedValue: () => undefined,
    readOpenAIProfiles: () => [],
    defaultOpenAIProfile: () => undefined,
    openAIApiKeyFor: () => undefined,
    resolveMemoryTools,
    providerForTask: () => 'openai',
    updatePiUsage: vi.fn(),
    emitTaskChanged: vi.fn(),
    sendTaskEvent: vi.fn(),
    piTraceBuilders: new Map(),
    getMainWindow: () => undefined
  })
})

afterEach(async () => {
  await releaseAllPiSessions()
})

describe('Pi Task 记忆工具接线', () => {
  it('首次创建注册工具，同阶段复用会话不重复注册', async () => {
    const session = await ensurePiSession('task-1', { phase: 'planning' })
    expect(await ensurePiSession('task-1', { phase: 'planning' })).toBe(session)
    expect(sdk.createAgentSession).toHaveBeenCalledTimes(1)
    expect(resolveMemoryTools).toHaveBeenCalledExactlyOnceWith(tasks.get('task-1'), repos.get('task-1'))
    expect(sdk.createAgentSession.mock.calls[0]![0].cwd).toBe('/worktrees/task-1/repo-1')
    await searchFromSession(0, '约定')
    expect(search).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      repositoryIds: ['repo-1', 'repo-2'],
      conversationId: 'task:task-1',
      query: '约定'
    })
  })

  it('恢复历史会话及释放后重开时重新绑定记忆工具', async () => {
    const file = '/data/pi-sessions/saved.jsonl'
    tasks.get('task-1')!.piSessionPath = file
    sdk.files.add(file)
    await ensurePiSession('task-1')
    expect(sdk.open).toHaveBeenCalledWith(file, '/data/pi-sessions', '/worktrees/task-1/repo-1')
    await releasePiSession('task-1')
    await ensurePiSession('task-1')
    expect(resolveMemoryTools).toHaveBeenCalledTimes(2)
    await searchFromSession(1, '恢复后查询')
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'task:task-1' }))
  })

  it('阶段 fork 后重新注册工具并保留任务范围', async () => {
    await ensurePiSession('task-1', { phase: 'planning', stageInstanceId: 'task-1:planning:1' })
    const forked = await forkPiStage('task-1')
    expect(forked.file).toBeTruthy()
    await ensurePiSession('task-1', { phase: 'implementation', stageInstanceId: 'task-1:implementation:1' })
    expect(resolveMemoryTools).toHaveBeenCalledTimes(2)
    expect(sdk.createAgentSession.mock.calls[1]![0].sessionManager!.getSessionFile()).toBe(forked.file)
    await searchFromSession(1, '实现约定')
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryIds: ['repo-1', 'repo-2'], conversationId: 'task:task-1' })
    )
  })

  it.each(['newSession', 'fork'] as const)('用户主动 %s 后仍注册记忆工具', async (action) => {
    await ensurePiSession('task-1')
    const { session } = await sdk.createAgentSession.mock.results[0]!.value
    const actions = session.bindExtensions.mock.calls[0]![0].commandContextActions!
    const result = action === 'fork' ? await actions.fork('unused-entry') : await actions.newSession()
    expect(result).toEqual({ cancelled: false })
    expect(resolveMemoryTools).toHaveBeenCalledTimes(2)
    await searchFromSession(1, '切换后查询')
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'task:task-1' }))
  })

  it('并行任务的检索始终使用各自仓库和对话范围', async () => {
    addTask('task-2', ['repo-3'])
    await Promise.all([ensurePiSession('task-1'), ensurePiSession('task-2')])
    for (const [index, [options]] of sdk.createAgentSession.mock.calls.entries()) {
      await searchFromSession(index, options.cwd!)
    }
    expect(search).toHaveBeenCalledWith({
      userId: 'user-1',
      repositoryIds: ['repo-1', 'repo-2'],
      conversationId: 'task:task-1',
      query: '/worktrees/task-1/repo-1'
    })
    expect(search).toHaveBeenCalledWith({
      userId: 'user-1',
      repositoryIds: ['repo-3'],
      conversationId: 'task:task-2',
      query: '/worktrees/task-2/repo-3'
    })
  })
})
