import { describe, expect, it, vi } from 'vitest'
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ModelRuntime,
  type ResourceLoader,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import { evaluateExecutionPermission } from '@task-pipeline/core'
import { createMemorySearchTool, createPiMemorySearchTool, type MemorySearchTarget } from './memory-search-tool.js'
import type { MemorySearchResult } from './memory-service.js'

const emptyResult = (): MemorySearchResult => ({ memories: [], wikiDocs: [], keywords: [] })

function setup() {
  const search = vi.fn<MemorySearchTarget['search']>().mockResolvedValue(emptyResult())
  const deps = {
    userId: 'user-1',
    repositoryIds: ['repo-1', 'repo-2'],
    conversationId: 'task:task-1',
    memoryService: { search }
  }
  return { deps, search, tool: createPiMemorySearchTool(deps) }
}

function execute(tool: ToolDefinition, input: unknown, signal?: AbortSignal) {
  return tool.execute('call-1', input, signal, undefined, {} as ExtensionContext)
}

describe('Pi 记忆检索工具', () => {
  it('仅向模型暴露 query，复用共享描述并提供使用指引', () => {
    const { deps, tool } = setup()
    const shared = createMemorySearchTool(deps)
    expect(tool.name).toBe('search_memory')
    expect(tool.description).toBe(shared.description)
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { query: { type: 'string', description: shared.schema.query?.description } },
      required: ['query'],
      additionalProperties: false
    })
    expect(tool.promptGuidelines?.join('\n')).toContain('先调用 search_memory')
    expect(tool.promptGuidelines?.join('\n')).toContain('以用户指令为准')
  })

  it('透传完整任务范围，无命中返回明确文本', async () => {
    const { tool, search } = setup()
    const result = await execute(tool, { query: '编码约定' })
    expect(search).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      repositoryIds: ['repo-1', 'repo-2'],
      conversationId: 'task:task-1',
      query: '编码约定'
    })
    expect(result.content).toEqual([{ type: 'text', text: '未检索到相关记忆或仓库文档。' }])
  })

  it('检索结果与共享工具一致，不额外添加 JSON 引号', async () => {
    const { deps, tool, search } = setup()
    search.mockResolvedValue({
      ...emptyResult(),
      memories: [
        { scope: 'repo', title: '提交规范', content: '使用中文提交信息' } as MemorySearchResult['memories'][number]
      ]
    })
    const expected = await createMemorySearchTool(deps).execute({ query: '提交规范' })
    expect((await execute(tool, { query: '提交规范' })).content).toEqual([{ type: 'text', text: expected }])
  })

  it.each([{}, { query: 42 }, { query: '约定', repositoryIds: ['other-repo'] }])(
    '拒绝非法参数或模型传入的范围字段：%j',
    async (input) => {
      const { tool, search } = setup()
      await expect(execute(tool, input)).rejects.toThrow()
      expect(search).not.toHaveBeenCalled()
    }
  )

  it('两个工具实例保持各自范围，不依赖当前活动任务', async () => {
    const { deps, tool, search } = setup()
    const other = createPiMemorySearchTool({ ...deps, repositoryIds: ['repo-3'], conversationId: 'task:task-2' })
    await Promise.all([execute(other, { query: 'B' }), execute(tool, { query: 'A' })])
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'A', conversationId: 'task:task-1' }))
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'B', repositoryIds: ['repo-3'], conversationId: 'task:task-2' })
    )
  })

  it('检索错误向 SDK 抛出，不伪装成无命中', async () => {
    const { tool, search } = setup()
    search.mockRejectedValue(new Error('检索失败'))
    await expect(execute(tool, { query: '约定' })).rejects.toThrow('检索失败')
  })

  it('已取消的调用不执行查询，查询期间取消后不返回结果', async () => {
    const { tool, search } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(execute(tool, { query: '约定' }, controller.signal)).rejects.toThrow()
    expect(search).not.toHaveBeenCalled()

    const running = new AbortController()
    search.mockImplementation(async () => {
      running.abort()
      return emptyResult()
    })
    await expect(execute(tool, { query: '约定' }, running.signal)).rejects.toThrow()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it.each(['planning', 'implementation', 'test'] as const)('在 %s 阶段保持只读可用', (phase) => {
    expect(
      evaluateExecutionPermission('search_memory', { query: '项目约定' }, { phase, roots: ['/repo'], cwd: '/repo' })
    ).toEqual({ action: 'allow' })
  })

  it('真实 Pi SDK 默认激活工具，reload 后仍保留工具及提示词', async () => {
    const { tool, search } = setup()
    // 只替换宿主资源与模型目录；使用真实 SDK，不读取用户配置、不请求模型。
    const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() }
    const loader: ResourceLoader = {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => undefined,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => undefined,
      reload: async () => undefined
    }
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRuntime: { getAvailableSnapshot: () => [] } as unknown as ModelRuntime,
      customTools: [tool]
    })
    try {
      for (let pass = 0; pass < 2; pass++) {
        expect(session.getActiveToolNames()).toContain('search_memory')
        expect(session.getActiveToolNames()).toContain('read')
        expect(session.systemPrompt).toContain(tool.promptGuidelines![0])
        const registered = session.agent.state.tools.find((entry) => entry.name === 'search_memory')!
        const result = await registered.execute('sdk-call', { query: 'SDK 查询' })
        expect(result.content).toEqual([{ type: 'text', text: '未检索到相关记忆或仓库文档。' }])
        if (pass === 0) await session.reload()
      }
      expect(search).toHaveBeenCalledTimes(2)
    } finally {
      session.dispose()
    }
  })
})
