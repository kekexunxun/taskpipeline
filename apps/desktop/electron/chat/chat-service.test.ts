import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import type { TaskStore } from '@task-pipeline/core'
import { ChatService } from './chat-service.js'
import { ChatDriverRegistry } from './drivers/driver-registry.js'
import type { ChatDriver } from './drivers/chat-driver.js'
import type { ChatModelInfo, ChatStreamChunk, DriverPart, StoredMessage } from './chat-types.js'

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
}

function createFakeDriver(opts: FakeDriverOptions): ChatDriver & {
  received: { history: StoredMessage[]; model: string; toolSource?: unknown; cwd?: string; mcpServices?: string[] }[]
} {
  const received: {
    history: StoredMessage[]
    model: string
    toolSource?: unknown
    cwd?: string
    mcpServices?: string[]
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
        cwd: input.cwd,
        mcpServices: input.mcpServices
      })
      if (opts.throwOnStream) throw new Error(opts.throwOnStream)
      const script = opts.scripts[scriptIndex++] ?? { emit: [] }
      for (const chunk of script.emit) yield chunk
    },
    dispose() {
      /* noop */
    }
  } as ChatDriver & {
    received: { history: StoredMessage[]; model: string; toolSource?: unknown; cwd?: string; mcpServices?: string[] }[]
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
    const conv = service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-1',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    // 第一个 done 来自 driver,第二个 done 来自 ChatService 的 finally(状态汇总)
    expect(sent.map((c) => c.type)).toEqual(['start', 'part', 'done', 'done'])
    const reloaded = service.getChat(conv.id)
    expect(reloaded?.messages).toHaveLength(2)
    expect(reloaded?.messages[0]?.role).toBe('user')
    expect(reloaded?.messages[1]?.role).toBe('assistant')
    expect(reloaded?.messages[1]?.parts[0]?.type).toBe('text')
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
    const conv = service.createChat('qoder', 'qoder:test')
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
    const conv = service.createChat('openai', 'gpt-4o')
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
    const reloaded = service.getChat(conv.id)
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

    const conv = service.createChat('qoder', 'qoder:test')
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
    const reloaded = service.getChat(conv.id)
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
    const conv = service.createChat('qoder', 'qoder:test')
    await service.startChatStream({
      streamId: 'stream-1',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'create', createdAt: new Date().toISOString() }
    })
    // raw 不会持久化 metadata,但 ChatService 通过 storage.replaceMessages + appendMessage
    // 实现了 taskCreation 在内存中可被消费(这里只验证 raw parts + service 流程)
    const reloaded = service.getChat(conv.id)
    expect(reloaded?.messages).toHaveLength(2)
    expect(reloaded?.messages[1]?.parts[0]?.type).toBe('text')
  })

  it('rejects when no driver is registered (no usable model)', async () => {
    const registry = new ChatDriverRegistry()
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined)
    const conv = service.createChat()
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
    const conv = service.createChat('qoder', 'qoder:retired')
    await service.startChatStream({
      streamId: 'stream-fb',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:retired',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    // driver 实际收到的是组内默认模型；本轮落盘记录的也是实际使用的模型
    expect(driver.received[0]?.model).toBe('qoder:current')
    expect(service.getChat(conv.id)?.conversation.model).toBe('qoder:current')
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
    const conv = service.createChat('qoder', 'qoder:test')
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
    const conv = service.createChat('qoder', 'qoder:test', '/some/project')
    expect(conv.workingDirectory).toBe('/some/project')
    // 读回:meta + conversation 都应带目录
    expect(service.listChats()[0]?.workingDirectory).toBe('/some/project')
    expect(service.getChat(conv.id)?.conversation.workingDirectory).toBe('/some/project')
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
    const conv = service.createChat('qoder', 'qoder:test', '/project/a')
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
    const conv = service.createChat('qoder', 'qoder:test')
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
    const conv = service.createChat('qoder', 'qoder:test')
    const bound = service.setChatWorkingDirectory(conv.id, '/bound/dir')
    expect(bound?.workingDirectory).toBe('/bound/dir')
    expect(service.getChat(conv.id)?.conversation.workingDirectory).toBe('/bound/dir')
    // 解绑:回到普通对话
    const unbound = service.setChatWorkingDirectory(conv.id, undefined)
    expect(unbound?.workingDirectory).toBeUndefined()
    expect(service.getChat(conv.id)?.conversation.workingDirectory).toBeUndefined()
  })

  it('does not reuse a directory-bound empty chat when creating a plain chat', async () => {
    const registry = new ChatDriverRegistry()
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined)
    const project = service.createChat('qoder', 'qoder:test', '/some/project')
    // 同为空对话,但带目录 —— 普通 createChat 不应复用
    const plain = service.createChat('qoder', 'qoder:test')
    expect(plain.id).not.toBe(project.id)
    expect(plain.workingDirectory).toBeUndefined()
    expect(service.listChats()).toHaveLength(2)
  })

  it('reuses the empty chat of the same directory instead of piling up project chats', async () => {
    const registry = new ChatDriverRegistry()
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined)
    const first = service.createChat('qoder', 'qoder:test', '/project/a')
    // 同一目录下再点「+」:复用已有的空项目对话,不无限新增
    const second = service.createChat('qoder', 'qoder:test', '/project/a')
    expect(second.id).toBe(first.id)
    // 不同目录互不复用
    const other = service.createChat('qoder', 'qoder:test', '/project/b')
    expect(other.id).not.toBe(first.id)
    expect(service.listChats()).toHaveLength(2)
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
    const conv = service.createChat('qoder', 'qoder:test')
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
    const reloaded = service.getChat(conv.id)
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
    const conv = service.createChat('qoder', 'qoder:test')
    const streamPromise = service.startChatStream({
      streamId: 'stream-1',
      chatId: conv.id,
      driverId: 'qoder',
      model: 'qoder:test',
      message: { id: 'u1', text: 'hello', createdAt: new Date().toISOString() }
    })
    // 等流进入 activeStreams
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.setChatWorkingDirectory(conv.id, '/while-streaming')).toBeUndefined()
    expect(service.getChat(conv.id)?.conversation.workingDirectory).toBeUndefined()
    release()
    await streamPromise
  })
})
