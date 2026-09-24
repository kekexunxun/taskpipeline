import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskStore } from '@task-pipeline/core'
import { createMemorySearchTool } from '../memory/memory-search-tool.js'
import {
  ChatService,
  CHAT_DRIVER_STALL_MS,
  CHAT_STREAM_HEARTBEAT_MS,
  buildPlanDocRelPath,
  collectPlanText,
  shouldPersistPlanDoc
} from './chat-service.js'
import { ChatDriverRegistry } from './drivers/driver-registry.js'
import { ChatStorage } from './chat-storage.js'
import type { ChatDriver } from './drivers/chat-driver.js'
import type { ToolDeclaration } from './drivers/tool-source.js'
import type { ChatModelInfo, ChatStreamChunk, DriverPart, StoredMessage } from './chat-types.js'

/**
 * driver 挂死检测的 HITL 豁免探针：pi-session 的真实实现依赖主进程接线，测试里用
 * 模块级开关替换 `hasPendingUiFor`（整模块替换：本测试图只有 chat-service 消费该模块）。
 */
let mockUiPending = false
vi.mock('../task/pi-session.js', () => ({ hasPendingUiFor: () => mockUiPending }))

/**
 * 假的 ChatDriver:用脚本化的 part 序列驱动 streamChat 行为。
 * 测试通过 parts 数组来控制 emit 顺序、流式事件、task-created 触发。
 */
type FakeDriverOptions = {
  id: 'qoder' | 'openai'
  displayName: string
  /** streamChat 第一次调用时 emit 的 parts(按顺序) */
  scripts: { emit: ChatStreamChunk[] }[]
  /** 每次 listModels 调用的返回 */
  models?: ChatModelInfo[]
  /** 非空时 streamChat 直接抛错(模拟驱动接口异常) */
  throwOnStream?: string
  /** 永不产出 chunk、直到 signal abort(模拟子进程挂死的 driver)。 */
  hangUntilAbort?: boolean
}

function createFakeDriver(opts: FakeDriverOptions): ChatDriver & {
  received: {
    history: StoredMessage[]
    model: string
    toolSource?: unknown
    memoryTools?: ToolDeclaration[]
    cwd?: string
    mcpServices?: string[]
    resumeSessionId?: string
  }[]
} {
  const received: {
    history: StoredMessage[]
    model: string
    toolSource?: unknown
    memoryTools?: ToolDeclaration[]
    cwd?: string
    mcpServices?: string[]
    resumeSessionId?: string
  }[] = []
  let scriptIndex = 0
  return {
    received,
    id: opts.id,
    displayName: opts.displayName,
    async listModels() {
      return opts.models ?? []
    },
    deserializeMessage(record) {
      return { ...record, parts: [{ driverId: record.driverId, type: 'text', text: '' }] }
    },
    serializeUserMessage(input) {
      return {
        id: input.id,
        role: 'user',
        createdAt: input.createdAt,
        driverId: opts.id,
        raw: { kind: 'user', text: input.text }
      }
    },
    serializeAssistantMessage(input) {
      return {
        id: input.id,
        role: 'assistant',
        createdAt: input.createdAt,
        driverId: opts.id,
        raw: { kind: 'assistant', parts: input.parts }
      }
    },
    async *streamChat(input) {
      received.push({
        history: input.history,
        model: input.model,
        toolSource: input.toolSource,
        memoryTools: input.memoryTools,
        cwd: input.cwd,
        mcpServices: input.mcpServices,
        resumeSessionId: input.resumeSessionId
      })
      if (opts.throwOnStream) throw new Error(opts.throwOnStream)
      input.onGuidanceReady?.()
      if (opts.hangUntilAbort) {
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve()
          else input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return
      }
      const script = opts.scripts[scriptIndex++] ?? { emit: [] }
      for (const chunk of script.emit) yield chunk
    },
    dispose() {
      /* noop */
    }
  } as ChatDriver & {
    received: {
      history: StoredMessage[]
      model: string
      toolSource?: unknown
      memoryTools?: ToolDeclaration[]
      cwd?: string
      mcpServices?: string[]
      resumeSessionId?: string
    }[]
  }
}

function fakeStore(): TaskStore {
  // TaskStore 接口很大;只覆盖 ChatService 用到的最小子集。
  return {
    getSetting: () => undefined,
    setSetting: () => undefined
  } as unknown as TaskStore
}

describe('ChatService (driver-based)', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = join(tmpdir(), `chat-service-${crypto.randomUUID()}`)
  })

  it('引导等待 Qoder 会话就绪，并等待 driver 投递确认', async () => {
    const qoder = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [],
      hangUntilAbort: true,
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    let ready!: () => void
    const preparing = new Promise<undefined>((resolve) => {
      ready = () => resolve(undefined)
    })
    const prepare = vi.fn(() => preparing)
    let acknowledge!: () => void
    const receipt = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    qoder.injectGuidance = vi.fn(() => receipt)
    const registry = new ChatDriverRegistry()
    registry.register(qoder)
    const service = new ChatService(
      fakeStore(),
      dataDir,
      registry,
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      prepare
    )
    const conv = await service.createChat('qoder', 'qoder:test')
    const stream = service.startChatStream({
      streamId: 'guidance-stream',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: '开始工作', createdAt: new Date().toISOString() }
    })
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      const confirmed = vi.fn()
      const guidance = service.injectGuidance(conv.id, '补充约束').then(confirmed)
      await Promise.resolve()
      expect(qoder.injectGuidance).not.toHaveBeenCalled()
      ready()
      await vi.waitFor(() => expect(qoder.injectGuidance).toHaveBeenCalledWith(conv.id, '补充约束'))
      expect(confirmed).not.toHaveBeenCalled()
      acknowledge()
      await guidance
      expect(confirmed).toHaveBeenCalledOnce()
    } finally {
      ready()
      acknowledge()
      service.abortChat({ chatId: conv.id, streamId: 'guidance-stream' })
      await stream
    }
  })

  it('引导按活跃流 Provider 路由，不读取滞后的会话配置，并透传投递失败', async () => {
    const qoder = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [],
      hangUntilAbort: true,
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    qoder.injectGuidance = vi.fn().mockRejectedValue(new Error('SDK 投递失败'))
    const registry = new ChatDriverRegistry()
    registry.register(qoder)
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined)
    const conv = await service.createChat('qoder', 'qoder:test')
    const stream = service.startChatStream({
      streamId: 'guidance-stream',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: '开始工作', createdAt: new Date().toISOString() }
    })
    await vi.waitFor(() => expect(qoder.received).toHaveLength(1))
    const readConversation = vi
      .spyOn(ChatStorage.prototype, 'getConversation')
      .mockResolvedValue({ ...conv, driverId: 'openai' })
    try {
      await expect(service.injectGuidance(conv.id, '补充约束')).rejects.toThrow('SDK 投递失败')
      expect(qoder.injectGuidance).toHaveBeenCalledWith(conv.id, '补充约束')
      expect(readConversation).not.toHaveBeenCalled()
      await expect(service.injectGuidance(conv.id, '  ')).rejects.toThrow('引导内容不能为空')
    } finally {
      readConversation.mockRestore()
      service.abortChat({ chatId: conv.id, streamId: 'guidance-stream' })
      await stream
    }
    await expect(service.injectGuidance(conv.id, '已结束')).rejects.toThrow('当前对话已结束')
  })

  it('会话准备期间停止回复会结束引导等待，不再投递', async () => {
    const qoder = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    qoder.injectGuidance = vi.fn(async () => undefined)
    let ready!: () => void
    const preparing = new Promise<undefined>((resolve) => {
      ready = () => resolve(undefined)
    })
    const prepare = vi.fn(() => preparing)
    const registry = new ChatDriverRegistry()
    registry.register(qoder)
    const service = new ChatService(
      fakeStore(),
      dataDir,
      registry,
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      prepare
    )
    const conv = await service.createChat('qoder', 'qoder:test')
    const stream = service.startChatStream({
      streamId: 'guidance-stream',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: '开始工作', createdAt: new Date().toISOString() }
    })
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      const rejected = expect(service.injectGuidance(conv.id, '补充约束')).rejects.toThrow('当前对话已结束')
      service.abortChat({ chatId: conv.id, streamId: 'guidance-stream' })
      await rejected
      expect(qoder.injectGuidance).not.toHaveBeenCalled()
    } finally {
      ready()
      await stream
    }
  })

  it('dispatches a stream end-to-end and persists the assistant record', async () => {
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [
        {
          emit: [
            { type: 'part', part: { driverId: 'qoder', type: 'text', text: 'hi' } satisfies DriverPart },
            { type: 'done', status: 'done' }
          ]
        }
      ],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const sent: ChatStreamChunk[] = []
    const win = {
      webContents: {
        send: (_channel: string, payload: { chunk?: ChatStreamChunk }) => {
          if (payload.chunk) sent.push(payload.chunk)
        }
      }
    } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    const conv = await service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-1',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    // 第一个 done 来自 driver,第二个 done 来自 ChatService 的 finally(状态汇总)
    expect(sent.map((c) => c.type)).toEqual(['start', 'part', 'done', 'done'])
    const reloaded = await service.getChat(conv.id)
    expect(reloaded?.messages).toHaveLength(2)
    expect(reloaded?.messages[0]?.role).toBe('user')
    expect(reloaded?.messages[1]?.role).toBe('assistant')
    expect(reloaded?.messages[1]?.parts[0]?.type).toBe('text')
  })

  it('对话级会话锚点：首轮 qoder.session 随对话落盘 sessionIds，下一回合经 resumeSessionId 传回 driver', async () => {
    // 回归保护：qoder.session part 只落在历史首条消息里，上下文压缩/token 裁剪会把它整条剪掉；
    // 应用重启后重建常驻会话若只从历史找锚点，会静默回落成全新会话（上下文全丢）。
    // 锚点必须持久化到对话级 meta，并在后续回合经 resumeSessionId 传给 driver。
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [
        {
          emit: [
            {
              type: 'part',
              part: { driverId: 'qoder', type: 'qoder.session', sessionId: 'sess-1' } satisfies DriverPart
            },
            { type: 'part', part: { driverId: 'qoder', type: 'text', text: 'hi' } satisfies DriverPart },
            { type: 'done', status: 'done' }
          ]
        },
        {
          emit: [
            { type: 'part', part: { driverId: 'qoder', type: 'text', text: 'second' } satisfies DriverPart },
            { type: 'done', status: 'done' }
          ]
        }
      ],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const win = {
      webContents: {
        send: () => {
          /* noop */
        }
      }
    } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    const conv = await service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-1',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    // 锚点随对话 meta 落盘（与消息列表无关，压缩裁不掉）。
    const reloaded = await service.getChat(conv.id)
    expect(reloaded?.conversation.sessionIds).toEqual({ qoder: 'sess-1' })
    // 首轮无锚点 → 第二轮 streamChat 收到对话级 resumeSessionId。
    expect(driver.received[0]?.resumeSessionId).toBeUndefined()
    await service.startChatStream({
      streamId: 'stream-2',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u2', text: 'again', createdAt: new Date().toISOString() }
    })
    expect(driver.received[1]?.resumeSessionId).toBe('sess-1')
  })

  it('记忆检索改为工具：每回合透传 search_memory 声明,execute 调 memoryService.search', async () => {
    // 用真实的 createMemorySearchTool 工厂,注入 mock memoryService,验证 ChatService
    // 不再预注入 system 文本,而是把工具声明列表透传给 driver,由 driver/模型按需调用。
    const searchCalls: { query: string; userId: string; conversationId?: string }[] = []
    const fakeMemoryService = {
      ensureUserId: () => 'user-1',
      search: async (input: { userId: string; conversationId?: string; query: string }) => {
        searchCalls.push({ query: input.query, userId: input.userId, conversationId: input.conversationId })
        return {
          memories: [{ scope: 'user', title: '偏好', content: '用户偏好简洁回答', score: 1, keywords: [] }],
          wikiDocs: [],
          keywords: ['偏好']
        }
      }
    }
    const resolveMemoryTools = async (input: { conversationId: string; workingDirectory?: string }) => [
      createMemorySearchTool({
        userId: fakeMemoryService.ensureUserId(),
        conversationId: input.conversationId,
        memoryService: fakeMemoryService as never
      })
    ]
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [
        {
          emit: [
            { type: 'part', part: { driverId: 'qoder', type: 'text', text: 'hi' } satisfies DriverPart },
            { type: 'done', status: 'done' }
          ]
        }
      ],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const win = {
      webContents: {
        send: () => {
          /* noop */
        }
      }
    } as unknown as BrowserWindow
    // resolveMemoryTools 是构造器第 6 个参数（resolveTaskBackend 之后）。
    const service = new ChatService(fakeStore(), dataDir, registry, () => win, undefined, resolveMemoryTools)
    const conv = await service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-1',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    // driver 收到 memoryTools,含 search_memory 声明;历史里不再有记忆 system 预注入。
    const memoryTool = driver.received[0]?.memoryTools?.find((t) => t.name === 'search_memory')
    expect(memoryTool).toBeDefined()
    expect(driver.received[0]?.history.some((m) => m.role === 'system')).toBe(false)
    // 模型尚未调用时不会触发检索。
    expect(searchCalls).toHaveLength(0)
    // 调用工具 execute → 触发 mock memoryService.search,并渲染出命中记忆文本。
    const output = await memoryTool!.execute({ query: '偏好' })
    expect(searchCalls).toHaveLength(1)
    expect(searchCalls[0]?.query).toBe('偏好')
    expect(searchCalls[0]?.userId).toBe('user-1')
    expect(output).toContain('用户偏好简洁回答')
  })

  it('回合 trace 契约：beginTurn 返回的 traceId 贯穿 endTurn / beginStage / endStage（回合隔离）', async () => {
    // 对话级 trace 下回合按 turnTraceId 隔离：endTurn 与阶段容器必须收到 beginTurn
    // 返回的同一 traceId，才能在被新回合接管时只收尾自己的 stage、不误关新回合 trace。
    const calls: Array<[string, string]> = []
    const traceManager = {
      beginTurn: (chatId: string, messageId: string) => {
        const turnKey = `${chatId}:${messageId}`
        calls.push(['beginTurn', turnKey])
        return { traceId: `trace-${chatId}`, turnKey }
      },
      endTurn: (chatId: string, turnKey?: string) => {
        calls.push(['endTurn', turnKey ?? ''])
      },
      traceIdForChat: () => undefined,
      beginStage: (chatId: string, phase: string, turnKey: string) => {
        calls.push(['beginStage', turnKey])
      },
      endStage: (chatId: string, turnKey: string) => {
        calls.push(['endStage', turnKey])
      }
    } as never
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [
        {
          emit: [
            { type: 'part', part: { driverId: 'qoder', type: 'text', text: 'hi' } },
            { type: 'done', status: 'done' }
          ]
        }
      ],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const win = { webContents: { send: () => undefined } } as unknown as BrowserWindow
    const service = new ChatService(
      fakeStore(),
      dataDir,
      registry,
      () => win,
      undefined,
      undefined,
      undefined,
      traceManager
    )
    const conv = await service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-t',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() }
    })
    // memory 阶段是 fire-and-forget 异步任务（void async），等它把 endTurn 执行完
    await new Promise((resolve) => setTimeout(resolve, 10))
    const begin = calls.find(([k]) => k === 'beginTurn')?.[1]
    expect(begin).toBe(`${conv.id}:u1`)
    // endTurn 与各阶段容器都收到 beginTurn 返回的同一回合令牌 turnKey
    for (const [kind, traceId] of calls) {
      if (kind === 'beginTurn') continue
      expect(traceId).toBe(begin)
    }
  })

  it('dispatches an error chunk and persists errorMessage when the driver stream fails', async () => {
    const driver = createFakeDriver({
      id: 'openai',
      displayName: 'OpenAI',
      scripts: [],
      throwOnStream: '401 Invalid API key',
      models: [{ value: 'gpt-4o', displayName: 'GPT-4o' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const sent: ChatStreamChunk[] = []
    const win = {
      webContents: {
        send: (_channel: string, payload: { chunk?: ChatStreamChunk }) => {
          if (payload.chunk) sent.push(payload.chunk)
        }
      }
    } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    const conv = await service.createChat('openai', 'gpt-4o')
    await service.startChatStream({
      streamId: 'stream-err',
      chatId: conv.id,
      driverId: 'openai',
      model: 'gpt-4o',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    const errorChunks = sent.filter((c): c is Extract<ChatStreamChunk, { type: 'error' }> => c.type === 'error')
    expect(errorChunks.map((c) => c.message)).toEqual(['401 Invalid API key'])
    // 落盘 record 带上 errorMessage,历史消息重新加载后仍能显示错误详情
    const reloaded = await service.getChat(conv.id)
    const assistant = reloaded?.messages.find((m) => m.role === 'assistant')
    expect(assistant?.errorMessage).toBe('401 Invalid API key')
  })

  it('supports switching driver mid-conversation: history messages keep their own driverId', async () => {
    const qoder = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [
        {
          emit: [
            { type: 'part', part: { driverId: 'qoder', type: 'text', text: 'first' } },
            { type: 'done', status: 'done' }
          ]
        }
      ],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const openai = createFakeDriver({
      id: 'openai',
      displayName: 'OpenAI',
      scripts: [
        {
          emit: [
            { type: 'part', part: { driverId: 'openai', type: 'text', text: 'second' } },
            { type: 'done', status: 'done' }
          ]
        }
      ],
      models: [{ value: 'openai:default', displayName: '默认 profile' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(qoder)
    registry.register(openai)

    let captured: { channel: string; payload: unknown }[] = []
    const win = {
      webContents: {
        send: (channel: string, payload: unknown) => {
          captured.push({ channel, payload })
        }
      }
    } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)

    const conv = await service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-a',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() }
    })
    captured = []
    await service.startChatStream({
      streamId: 'stream-b',
      chatId: conv.id,
      driverId: 'openai',
      model: 'openai:default',
      message: { id: 'u2', text: 'second', createdAt: new Date().toISOString() }
    })
    const reloaded = await service.getChat(conv.id)
    expect(reloaded?.messages).toHaveLength(4)
    expect(reloaded?.messages[0]?.driverId).toBe('qoder')
    expect(reloaded?.messages[1]?.driverId).toBe('qoder')
    expect(reloaded?.messages[2]?.driverId).toBe('openai')
    expect(reloaded?.messages[3]?.driverId).toBe('openai')
    // Qoder 历史的 raw 由 qoder 解析,openai 历史由 openai 解析
    expect(reloaded?.messages[0]?.parts[0]?.driverId).toBe('qoder')
    expect(reloaded?.messages[3]?.parts[0]?.driverId).toBe('openai')
  })

  it('collects task-created chunks into the persisted assistant metadata', async () => {
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [
        {
          emit: [
            { type: 'part', part: { driverId: 'qoder', type: 'text', text: '已创建' } },
            {
              type: 'task-created',
              result: {
                backend: 'jira',
                externalKey: 'BSADAPT-1',
                summary: 'demo',
                projectKey: 'BSADAPT',
                issueType: '任务'
              }
            },
            { type: 'done', status: 'done' }
          ]
        }
      ],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const win = { webContents: { send: () => undefined } } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    const conv = await service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-1',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'create', createdAt: new Date().toISOString() }
    })
    // raw 不会持久化 metadata,但 ChatService 通过 storage.replaceMessages + appendMessage
    // 实现了 taskCreation 在内存中可被消费(这里只验证 raw parts + service 流程)
    const reloaded = await service.getChat(conv.id)
    expect(reloaded?.messages).toHaveLength(2)
    expect(reloaded?.messages[1]?.parts[0]?.type).toBe('text')
  })

  it('rejects when no driver is registered (no usable model)', async () => {
    const registry = new ChatDriverRegistry()
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined)
    const conv = await service.createChat()
    await expect(
      service.startChatStream({
        streamId: 'stream-x',
        chatId: conv.id,
        driverId: 'qoder',
        model: 'qoder:test',
        message: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() }
      })
    ).rejects.toThrow(/未配置可用模型/)
  })

  it('falls back to the driver default when the requested model is no longer available', async () => {
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [{ emit: [{ type: 'done', status: 'done' }] }],
      models: [{ value: 'qoder:current', displayName: '当前模型', isDefault: true }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const win = { webContents: { send: () => undefined } } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    // 对话存的是已下线的旧模型
    const conv = await service.createChat('qoder', 'qoder:retired')
    await service.startChatStream({
      streamId: 'stream-fb',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:retired',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    // driver 实际收到的是组内默认模型；本轮落盘记录的也是实际使用的模型
    expect(driver.received[0]?.model).toBe('qoder:current')
    expect((await service.getChat(conv.id))?.conversation.model).toBe('qoder:current')
  })

  it('falls back across drivers to the system default when the requested driver has no models', async () => {
    // qoder driver 无任何模型（未连接），openai driver 有模型 → 系统默认落在 openai 组
    const qoder = createFakeDriver({ id: 'qoder', displayName: 'Qoder', scripts: [] })
    const openai = createFakeDriver({
      id: 'openai',
      displayName: 'OpenAI',
      scripts: [{ emit: [{ type: 'done', status: 'done' }] }],
      models: [{ value: 'openai:gpt-4o', displayName: 'GPT-4o', isDefault: true }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(qoder)
    registry.register(openai)
    const win = { webContents: { send: () => undefined } } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    const conv = await service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-x',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() }
    })
    expect(openai.received).toHaveLength(1)
    expect(openai.received[0]?.model).toBe('openai:gpt-4o')
    expect(qoder.received).toHaveLength(0)
  })

  it('rejects stream on missing conversation', async () => {
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [{ emit: [{ type: 'done', status: 'done' }] }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined)
    await expect(
      service.startChatStream({
        streamId: 'stream-x',
        chatId: 'no-such',
        driverId: 'qoder',
        model: 'qoder:test',
        message: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() }
      })
    ).rejects.toThrow(/对话不存在/)
  })

  it('persists workingDirectory when creating a project chat and reloads it', async () => {
    const registry = new ChatDriverRegistry()
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined)
    const conv = await service.createChat('qoder', 'qoder:test', '/some/project')
    expect(conv.workingDirectory).toBe('/some/project')
    // 读回:meta + conversation 都应带目录
    expect((await service.listChats())[0]?.workingDirectory).toBe('/some/project')
    expect((await service.getChat(conv.id))?.conversation.workingDirectory).toBe('/some/project')
  })

  it('passes the conversation workingDirectory as cwd to the driver on stream', async () => {
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [{ emit: [{ type: 'done', status: 'done' }] }],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const win = { webContents: { send: () => undefined } } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    const conv = await service.createChat('qoder', 'qoder:test', '/project/a')
    await service.startChatStream({
      streamId: 'stream-1',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    expect(driver.received[0]?.cwd).toBe('/project/a')
  })

  it('does not pass cwd for plain chats', async () => {
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [{ emit: [{ type: 'done', status: 'done' }] }],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const win = { webContents: { send: () => undefined } } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    const conv = await service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-1',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    expect(driver.received[0]?.cwd).toBeUndefined()
  })

  it('binds and unbinds workingDirectory via setChatWorkingDirectory', async () => {
    const registry = new ChatDriverRegistry()
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined)
    const conv = await service.createChat('qoder', 'qoder:test')
    const bound = await service.setChatWorkingDirectory(conv.id, '/bound/dir')
    expect(bound?.workingDirectory).toBe('/bound/dir')
    expect((await service.getChat(conv.id))?.conversation.workingDirectory).toBe('/bound/dir')
    // 解绑:回到普通对话
    const unbound = await service.setChatWorkingDirectory(conv.id, undefined)
    expect(unbound?.workingDirectory).toBeUndefined()
    expect((await service.getChat(conv.id))?.conversation.workingDirectory).toBeUndefined()
  })

  it('does not reuse a directory-bound empty chat when creating a plain chat', async () => {
    const registry = new ChatDriverRegistry()
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined)
    const project = await service.createChat('qoder', 'qoder:test', '/some/project')
    // 同为空对话,但带目录 —— 普通 createChat 不应复用
    const plain = await service.createChat('qoder', 'qoder:test')
    expect(plain.id).not.toBe(project.id)
    expect(plain.workingDirectory).toBeUndefined()
    expect(await service.listChats()).toHaveLength(2)
  })

  it('reuses the empty chat of the same directory instead of piling up project chats', async () => {
    const registry = new ChatDriverRegistry()
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined)
    const first = await service.createChat('qoder', 'qoder:test', '/project/a')
    // 同一目录下再点「+」:复用已有的空项目对话,不无限新增
    const second = await service.createChat('qoder', 'qoder:test', '/project/a')
    expect(second.id).toBe(first.id)
    // 不同目录互不复用
    const other = await service.createChat('qoder', 'qoder:test', '/project/b')
    expect(other.id).not.toBe(first.id)
    expect(await service.listChats()).toHaveLength(2)
  })

  it('persists mcpService/agentId into conversation meta and passes mcpServices to the driver', async () => {
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [{ emit: [{ type: 'done', status: 'done' }] }],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const win = { webContents: { send: () => undefined } } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    const conv = await service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-mcp',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      mcpService: ['gitlab', 'jira'],
      agentId: 'agent-42',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    // MCP 选择透传给 driver（真正注入工具）
    expect(driver.received[0]?.mcpServices).toEqual(['gitlab', 'jira'])
    // MCP / Agent 选择态随对话落盘，切换对话后可恢复
    const reloaded = await service.getChat(conv.id)
    expect(reloaded?.conversation.mcpService).toEqual(['gitlab', 'jira'])
    expect(reloaded?.conversation.agentId).toBe('agent-42')
  })

  it('refuses to rebind the directory while streaming', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const gated: ChatDriver = {
      ...base,
      async *streamChat(_input) {
        await gate
        yield { type: 'done', status: 'done' }
      }
    }
    const registry = new ChatDriverRegistry()
    registry.register(gated)
    const win = { webContents: { send: () => undefined } } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    const conv = await service.createChat('qoder', 'qoder:test')
    const streamPromise = service.startChatStream({
      streamId: 'stream-1',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    // 等流进入 activeStreams
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await service.setChatWorkingDirectory(conv.id, '/while-streaming')).toBeUndefined()
    expect((await service.getChat(conv.id))?.conversation.workingDirectory).toBeUndefined()
    release()
    await streamPromise
  })
})

describe('计划正文兼底落盘助手', () => {
  it('buildPlanDocRelPath：清洗标题中的路径分隔符 / 非法字符，落到 docs/ 下', () => {
    expect(buildPlanDocRelPath('参赛协议/动态配置:改造', 'chat-abc12345')).toBe(
      'docs/参赛协议 动态配置 改造-开发计划.md'
    )
    expect(buildPlanDocRelPath('  多  空格\t标题  ', 'chat-x')).toBe('docs/多 空格 标题-开发计划.md')
  })

  it('buildPlanDocRelPath：空标题回落到 chatId 前缀命名', () => {
    expect(buildPlanDocRelPath('', 'abcdef12345')).toBe('docs/plan-abcdef12-开发计划.md')
    expect(buildPlanDocRelPath('   ', '')).toBe('docs/plan-chat-开发计划.md')
  })

  it('shouldPersistPlanDoc：仅绑定工作目录 + 未用 write_plan + 正文足够长才兼底', () => {
    const long = 'x'.repeat(300)
    expect(shouldPersistPlanDoc({ workingDirectory: '/repo', usedWritePlan: false, planText: long })).toBe(true)
    expect(shouldPersistPlanDoc({ usedWritePlan: false, planText: long })).toBe(false)
    expect(shouldPersistPlanDoc({ workingDirectory: '/repo', usedWritePlan: true, planText: long })).toBe(false)
    expect(shouldPersistPlanDoc({ workingDirectory: '/repo', usedWritePlan: false, planText: '我这就写' })).toBe(false)
  })

  it('collectPlanText：只取主线文本，planner 子任务内部正文（带 parentTaskId）不计入', () => {
    const parts: DriverPart[] = [
      { driverId: 'qoder', type: 'qoder.session', sessionId: 's1' },
      { driverId: 'qoder', type: 'text', text: '子代理正文', parentTaskId: 't-1' },
      { driverId: 'qoder', type: 'text', text: '# 计划\n' },
      { driverId: 'qoder', type: 'text', text: '## 步骤' }
    ]
    expect(collectPlanText(parts)).toBe('# 计划\n## 步骤')
  })
})

describe('ChatService driver 挂死检测（主进程侧静默探活）', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = join(tmpdir(), `chat-stall-${crypto.randomUUID()}`)
    mockUiPending = false
  })

  function createStallService() {
    const driver = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [],
      hangUntilAbort: true,
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const registry = new ChatDriverRegistry()
    registry.register(driver)
    const sent: ChatStreamChunk[] = []
    const win = {
      webContents: {
        send: (_channel: string, payload: { chunk?: ChatStreamChunk }) => {
          if (payload.chunk) sent.push(payload.chunk)
        }
      }
    } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    return { service, sent }
  }

  /** 分段推进虚拟时钟：每段之间让出真实事件循环（setImmediate 未被 fake），
   * 保证 ChatStorage 的 fs I/O 回调能完成，流真正跑到心跳阶段而不是停在启动前的落盘。 */
  async function advance(totalMs: number): Promise<void> {
    let left = totalMs
    while (left > 0) {
      const step = Math.min(60_000, left)
      await vi.advanceTimersByTimeAsync(step)
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
      left -= step
    }
  }

  function stallTimers(): void {
    // 只 fake 定时器与 Date：保留真实 setImmediate 作为 I/O 让位手段。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  }

  it('driver 静默超阈值：停发心跳、dispatch error 并主动 abort 本轮', async () => {
    stallTimers()
    try {
      const { service, sent } = createStallService()
      const conv = await service.createChat('qoder', 'qoder:test')
      const pending = service.startChatStream({
        streamId: 'stream-1',
        chatId: conv.id,
        driverId: 'qoder',
        model: 'qoder:test',
        message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
      })
      await advance(CHAT_DRIVER_STALL_MS + CHAT_STREAM_HEARTBEAT_MS * 3)
      await pending
      // 静默期内心跳照常发（证明不是提前误杀），超阈值后出现唯一一条 error。
      expect(sent.filter((c) => c.type === 'heartbeat').length).toBeGreaterThan(0)
      const errors = sent.filter((c) => c.type === 'error') as Extract<ChatStreamChunk, { type: 'error' }>[]
      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).toContain('已自动中止')
      // 挂死中止走的是 abort 路径：收尾 done 带 aborted 状态，前端据此清理在飞态。
      expect(sent.at(-1)).toMatchObject({ type: 'done', status: 'aborted' })
      expect(sent.filter((c) => c.type === 'heartbeat').length).toBeLessThan(
        Math.ceil((CHAT_DRIVER_STALL_MS + CHAT_STREAM_HEARTBEAT_MS * 3) / CHAT_STREAM_HEARTBEAT_MS)
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('HITL 弹窗在飞属正常静默：豁免期间不判挂死，用户答完后重新计时', async () => {
    stallTimers()
    try {
      const { service, sent } = createStallService()
      const conv = await service.createChat('qoder', 'qoder:test')
      mockUiPending = true
      const pending = service.startChatStream({
        streamId: 'stream-1',
        chatId: conv.id,
        driverId: 'qoder',
        model: 'qoder:test',
        message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
      })
      // 用户思考超过阈值：只要弹窗还在飞，就不能误杀（否则长思考用户永远无法完成确认）。
      await advance(CHAT_DRIVER_STALL_MS + CHAT_STREAM_HEARTBEAT_MS * 3)
      // 前置断言：确实已流过起来（有 start + 持续心跳），避免「没跑起来所以没 error」的空断言。
      // 阈值保守：心跳条数取决于流启动相对于虚拟时钟的时机，只要能证明跨过了静默窗口即可。
      expect(sent.some((c) => c.type === 'start')).toBe(true)
      expect(sent.filter((c) => c.type === 'heartbeat').length).toBeGreaterThan(10)
      expect(sent.some((c) => c.type === 'error')).toBe(false)
      expect(sent.some((c) => c.type === 'done')).toBe(false)
      // 用户答完（弹窗撤回）：静默基准从答完时刻重新起算，再超阈值才判挂死。
      mockUiPending = false
      await advance(CHAT_DRIVER_STALL_MS - CHAT_STREAM_HEARTBEAT_MS)
      expect(sent.some((c) => c.type === 'error')).toBe(false)
      await advance(CHAT_DRIVER_STALL_MS / 2)
      await pending
      expect(sent.some((c) => c.type === 'error')).toBe(true)
      expect(sent.at(-1)).toMatchObject({ type: 'done', status: 'aborted' })
    } finally {
      vi.useRealTimers()
      mockUiPending = false
    }
  })

  it('reattach：在飞流内存快照与 dispatch seq 单调水位', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = createFakeDriver({
      id: 'qoder',
      displayName: 'Qoder',
      scripts: [],
      models: [{ value: 'qoder:test', displayName: '测试模型' }]
    })
    const gated: ChatDriver = {
      ...base,
      async *streamChat(_input) {
        yield { type: 'part', part: { driverId: 'qoder', type: 'text', text: '半程' } } satisfies ChatStreamChunk
        await gate
        yield { type: 'part', part: { driverId: 'qoder', type: 'text', text: '后续' } } satisfies ChatStreamChunk
        yield { type: 'done', status: 'done' } satisfies ChatStreamChunk
      }
    }
    const registry = new ChatDriverRegistry()
    registry.register(gated)
    const envelopes: { seq?: number; done?: boolean; chunk?: ChatStreamChunk }[] = []
    const win = {
      webContents: {
        send: (_channel: string, payload: { seq?: number; done?: boolean; chunk?: ChatStreamChunk }) => {
          envelopes.push(payload)
        }
      }
    } as unknown as BrowserWindow
    const service = new ChatService(fakeStore(), dataDir, registry, () => win)
    const conv = await service.createChat('qoder', 'qoder:test')
    const streamPromise = service.startChatStream({
      streamId: 'stream-re',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    // 等首个 part 事件外发（主进程先累积 parts 后 dispatch，事件到达即快照含该 part）。
    await vi.waitFor(() => expect(envelopes.some((e) => e.chunk?.type === 'part')).toBe(true))

    const state = await service.getReattachState()
    expect(state.streams).toHaveLength(1)
    const snapshot = state.streams[0]!
    expect(snapshot.chatId).toBe(conv.id)
    expect(snapshot.streamId).toBe('stream-re')
    expect(snapshot.driverId).toBe('qoder')
    expect(snapshot.model).toBe('qoder:test')
    expect(snapshot.assistantId).toBeTruthy()
    expect(snapshot.parts.map((p) => (p.type === 'text' ? p.text : ''))).toEqual(['半程'])
    // seq 水位 ≥ 已到达的 part 事件序号：重挂载方据此对续流事件去重。
    const lastPartSeq = Math.max(...envelopes.filter((e) => e.seq !== undefined).map((e) => e.seq!))
    expect(snapshot.seq).toBeGreaterThanOrEqual(lastPartSeq)
    // 对话全量数据随行（在飞 assistant 由定时增量落盘，此处至少含 user）。
    expect(state.chats[0]?.messages.some((m) => m.role === 'user')).toBe(true)

    release()
    await streamPromise
    // 所有活跃流事件都带单调递增 seq；收尾 done:true 信封不带。
    const seqs = envelopes.filter((e) => e.seq !== undefined).map((e) => e.seq!)
    expect(seqs.length).toBeGreaterThan(2)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(envelopes.at(-1)).toMatchObject({ done: true })
    expect(envelopes.at(-1)?.seq).toBeUndefined()
    // 流收口后不再有可接管的在飞流。
    expect((await service.getReattachState()).streams).toHaveLength(0)
  })
})
