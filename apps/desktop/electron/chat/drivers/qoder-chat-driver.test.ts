import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredMessage } from '../chat-types.js'

/**
 * 假 SDK:用 `vi.mock` 替换 `@qoder-ai/qoder-agent-sdk`,把 `query()` 接到一个可脚本化的
 * AsyncIterable,让测试可以精确驱动 SDKMessage 流。
 */
type SdkMessage = Record<string, unknown> & {
  type?: string
  session_id?: string
  subtype?: string
  /** 子任务关联字段(仅 task_started / task_progress / task_notification 携带)。 */
  task_id?: string
  tool_use_id?: string
  description?: string
  task_type?: string
  last_tool_name?: string
  status?: string
  summary?: string
  output_file?: string
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
  /** SDK 在每条消息上携带该字段,标识该消息属于哪个父级 tool_use —— 顶层为 null/缺失。 */
  parent_tool_use_id?: string | null
  event?: {
    type?: string
    delta?: { type?: string; text?: string; thinking?: string; signature?: string }
    content_block?: {
      type?: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }
    index?: number
  }
  message?: {
    content?: Array<{
      type: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }>
    usage?: unknown
    parent_tool_use_id?: string | null
  }
  result?: string
  error?: string
}

function asyncIterFromArray<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          if (index < items.length) return { value: items[index++] as T, done: false }
          return { value: undefined as unknown as T, done: true }
        },
        async return() {
          return { value: undefined as unknown as T, done: true }
        },
        async throw(error: unknown) {
          throw error
        }
      }
    }
  }
}

function textDelta(text: string, sessionId: string): SdkMessage {
  return {
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
  }
}

function thinkingDelta(text: string, sessionId: string): SdkMessage {
  return {
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: text } }
  }
}

function assistantMessageWithToolUse(name: string, input: unknown, toolId: string, sessionId: string): SdkMessage {
  return {
    type: 'stream_event',
    session_id: sessionId,
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: toolId, name, input }
    }
  }
}

function assistantMessageWithToolResult(toolUseId: string, content: unknown, isError = false): SdkMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }]
    }
  }
}

function resultMessage(result: string, sessionId: string): SdkMessage {
  return { type: 'result', session_id: sessionId, result }
}

/** 构造 task_started / task_progress / task_notification 三类子任务系统消息。 */
function systemSubtype(
  subtype: 'task_started' | 'task_progress' | 'task_notification',
  fields: {
    task_id: string
    tool_use_id?: string
    task_type?: string
    description?: string
    last_tool_name?: string
    status?: string
    summary?: string
    parent_tool_use_id?: string | null
  }
): SdkMessage {
  return {
    type: 'system',
    subtype,
    task_id: fields.task_id,
    ...(fields.tool_use_id ? { tool_use_id: fields.tool_use_id } : {}),
    ...(fields.task_type ? { task_type: fields.task_type } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields.last_tool_name ? { last_tool_name: fields.last_tool_name } : {}),
    ...(fields.status ? { status: fields.status } : {}),
    ...(fields.summary ? { summary: fields.summary } : {}),
    ...(fields.parent_tool_use_id !== undefined ? { parent_tool_use_id: fields.parent_tool_use_id } : {})
  } as SdkMessage
}

vi.mock('@qoder-ai/qoder-agent-sdk', () => {
  // 把脚本化的 SDKMessage 数组喂给 driver
  const scripts: { messages: SdkMessage[] }[] = []
  const captured: Array<{ options: Record<string, unknown> }> = []
  return {
    accessToken: (token: string) => ({ token }),
    query: (args: { prompt?: string; options?: Record<string, unknown> }) => {
      const script = scripts.shift() ?? { messages: [] }
      captured.push({ options: args.options ?? {} })
      return {
        [Symbol.asyncIterator]() {
          const iter = asyncIterFromArray(script.messages)[Symbol.asyncIterator]()
          return {
            async next() {
              return iter.next()
            },
            async return() {
              return iter.return ? iter.return() : { value: undefined, done: true }
            },
            async throw(error: unknown) {
              return iter.throw ? iter.throw(error) : Promise.reject(error)
            }
          }
        },
        async close() {
          /* noop */
        },
        async interrupt() {
          /* noop */
        }
      }
    },
    tool: (name: string, _description: string, _schema: unknown, execute: (input: unknown) => unknown) => ({
      name,
      execute
    }),
    createSdkMcpServer: (config: { name: string; tools: unknown[] }) => ({ name: config.name, tools: config.tools }),
    // 暴露给测试用
    __pushScript: (script: { messages: SdkMessage[] }) => scripts.push(script),
    __getLastQueryOptions: () => captured[captured.length - 1]?.options,
    __resetCaptured: () => {
      captured.length = 0
    }
  }
})

// 必须在 vi.mock 之后 import driver
const { QoderChatDriver } = await import('./qoder-chat-driver.js')
const sdkMock = (await import('@qoder-ai/qoder-agent-sdk')) as unknown as {
  __pushScript: (script: { messages: SdkMessage[] }) => void
  __getLastQueryOptions: () => Record<string, unknown> | undefined
  __resetCaptured: () => void
}

function driver() {
  return new QoderChatDriver(
    () => 'test-token',
    async () => ({
      enabled: true,
      connected: true,
      running: false,
      models: [
        { value: 'claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5', isDefault: true },
        { value: 'gpt-5', displayName: 'GPT-5' }
      ]
    })
  )
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of gen) out.push(x)
  return out
}

describe('QoderChatDriver', () => {
  it('emits text parts in order and session part on first message', async () => {
    sdkMock.__pushScript({
      messages: [textDelta('Hello', 'sess-1'), textDelta(' world', 'sess-1'), resultMessage('Hello world', 'sess-1')]
    })
    const events = await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const parts = events.flatMap((e) => (e.type === 'part' ? [e.part] : []))
    expect(parts.map((p) => p.type)).toEqual(['qoder.session', 'text', 'text'])
    expect(parts[0]?.type === 'qoder.session' && parts[0].sessionId).toBe('sess-1')
  })

  it('emits thinking parts as qoder.thinking', async () => {
    sdkMock.__pushScript({
      messages: [thinkingDelta('思考中', 'sess-2'), textDelta('结论', 'sess-2'), resultMessage('结论', 'sess-2')]
    })
    const events = await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const parts = events.flatMap((e) => (e.type === 'part' ? [e.part] : []))
    expect(parts.some((p) => p.type === 'qoder.thinking' && p.text === '思考中')).toBe(true)
  })

  it('emits tool-use and tool-result parts and a task-created chunk when tool source describes a result', async () => {
    sdkMock.__pushScript({
      messages: [
        assistantMessageWithToolUse('createJiraIssue', { projectKey: 'BSADAPT' }, 'tc-1', 'sess-3'),
        assistantMessageWithToolResult('tc-1', { ok: true, key: 'BSADAPT-42' }, false),
        resultMessage('已创建任务 BSADAPT-42', 'sess-3')
      ]
    })
    const events = await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'create', createdAt: new Date().toISOString() },
        signal: new AbortController().signal,
        toolSource: {
          id: 'jira',
          displayName: 'Jira',
          systemPrompt: () => '',
          tools: () => [],
          describeResult: (output: unknown) => {
            if (output && typeof output === 'object' && 'key' in (output as Record<string, unknown>)) {
              const o = output as { key: string }
              return {
                backend: 'jira',
                externalKey: o.key,
                summary: 'from tool',
                projectKey: 'BSADAPT',
                issueType: '任务'
              }
            }
            return undefined
          },
          close: () => undefined
        }
      })
    )
    const partTypes = events.flatMap((e) => (e.type === 'part' ? [e.part.type] : []))
    expect(partTypes).toContain('qoder.tool-use')
    expect(partTypes).toContain('qoder.tool-result')
    const taskCreated = events.find((e) => e.type === 'task-created')
    expect(taskCreated?.type).toBe('task-created')
    if (taskCreated?.type === 'task-created') {
      expect(taskCreated.result.externalKey).toBe('BSADAPT-42')
    }
  })

  it('returns no models when Qoder is not enabled/connected', async () => {
    const offline = new QoderChatDriver(
      () => 'token',
      async () => ({ enabled: false, connected: false, running: false, models: [] })
    )
    expect(await offline.listModels()).toEqual([])
  })

  it('prepends qoder: prefix to model values', async () => {
    const models = await driver().listModels()
    expect(models.every((m) => m.value.startsWith('qoder:'))).toBe(true)
  })

  it('throws when no token is configured', async () => {
    const noToken = new QoderChatDriver(
      () => undefined,
      async () => ({ enabled: true, connected: true, running: false, models: [] })
    )
    await expect(async () => {
      for await (const _ of noToken.streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })) {
        void _
      }
    }).rejects.toThrow(/Qoder Token/)
  })
})

describe('QoderChatDriver resume', () => {
  function storedUser(id: string, text: string): StoredMessage {
    return {
      id,
      role: 'user',
      createdAt: new Date().toISOString(),
      driverId: 'qoder',
      raw: { kind: 'user', text },
      parts: [{ driverId: 'qoder', type: 'text', text }]
    }
  }
  function storedAssistantWithSession(id: string, sessionId: string, text: string): StoredMessage {
    return {
      id,
      role: 'assistant',
      createdAt: new Date().toISOString(),
      driverId: 'qoder',
      raw: {
        kind: 'assistant',
        parts: [
          { driverId: 'qoder', type: 'qoder.session', sessionId },
          { driverId: 'qoder', type: 'text', text }
        ],
        sessionId
      },
      parts: [
        { driverId: 'qoder', type: 'qoder.session', sessionId },
        { driverId: 'qoder', type: 'text', text }
      ]
    }
  }

  beforeEach(() => {
    sdkMock.__resetCaptured()
  })

  it('passes resume=sessionId when history ends with qoder.session, and truncates prompt history', async () => {
    sdkMock.__pushScript({
      messages: [textDelta('second reply', 'sess-Y'), resultMessage('second reply', 'sess-Y')]
    })
    const history: StoredMessage[] = [
      storedUser('u1', 'hi'),
      storedAssistantWithSession('a1', 'sess-X', 'first reply'),
      storedUser('u2', 'more'),
      storedAssistantWithSession('a2', 'sess-Y', 'second base'),
      storedUser('u3', 'again')
    ]
    await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history,
        userInput: { id: 'u-new', text: 'yet again', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const options = sdkMock.__getLastQueryOptions()
    expect(options?.resume).toBe('sess-Y')
  })

  it('takes the last qoder.session id when multiple exist', async () => {
    sdkMock.__pushScript({ messages: [textDelta('ok', 'sess-Y'), resultMessage('ok', 'sess-Y')] })
    const history: StoredMessage[] = [
      storedUser('u1', 'first'),
      storedAssistantWithSession('a1', 'sess-X', 'first reply'),
      storedAssistantWithSession('a2', 'sess-Y', 'second reply')
    ]
    await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history,
        userInput: { id: 'u2', text: 'again', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const options = sdkMock.__getLastQueryOptions()
    expect(options?.resume).toBe('sess-Y')
  })

  it('does not pass resume when history has no qoder.session part', async () => {
    sdkMock.__pushScript({ messages: [textDelta('hi', 'sess-1'), resultMessage('hi', 'sess-1')] })
    const history: StoredMessage[] = [storedUser('u1', 'hi')]
    await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history,
        userInput: { id: 'u2', text: 'hi again', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const options = sdkMock.__getLastQueryOptions()
    expect(options?.resume).toBeUndefined()
  })
})

describe('QoderChatDriver sub-task lifecycle', () => {
  it('emits subtask-start/progress/end and tags in-task parts with parentTaskId', async () => {
    sdkMock.__pushScript({
      messages: [
        // 起点:task_started 带 tool_use_id,driver 写入 tool_use_id -> task_id 映射
        systemSubtype('task_started', {
          task_id: 't-1',
          tool_use_id: 'tu-1',
          task_type: 'search',
          description: '查询文档'
        }),
        // 子任务内:assistant message 自带 message.parent_tool_use_id → 反查到 t-1
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '子任务文本' }],
            parent_tool_use_id: 'tu-1'
          }
        },
        // SDK 多次发 task_progress
        systemSubtype('task_progress', {
          task_id: 't-1',
          description: '正在搜索',
          last_tool_name: 'searchDocs'
        }),
        // 收尾
        systemSubtype('task_notification', {
          task_id: 't-1',
          status: 'completed',
          summary: '完成'
        }),
        // 主流程:不带 parent_tool_use_id → 不应挂 parentTaskId
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '主流程文本' }] }
        },
        resultMessage('done', 'sess-1')
      ]
    })
    const events = await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'go', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const parts = events.flatMap((e) => (e.type === 'part' ? [e.part] : []))

    // 1. 三个子任务 part 都 emit 了
    const startPart = parts.find((p) => p.type === 'qoder.subtask-start')
    expect(startPart?.type === 'qoder.subtask-start' && startPart.taskId).toBe('t-1')
    expect(startPart?.type === 'qoder.subtask-start' && startPart.taskType).toBe('search')
    expect(startPart?.type === 'qoder.subtask-start' && startPart.description).toBe('查询文档')
    // subtask-start 自指 parentTaskId(让 groupByParentTask 把它识别为 group header)
    expect(startPart?.type === 'qoder.subtask-start' && startPart.parentTaskId).toBe('t-1')

    const progressPart = parts.find((p) => p.type === 'qoder.subtask-progress')
    expect(progressPart?.type === 'qoder.subtask-progress' && progressPart.taskId).toBe('t-1')
    expect(progressPart?.type === 'qoder.subtask-progress' && progressPart.description).toBe('正在搜索')
    expect(progressPart?.type === 'qoder.subtask-progress' && progressPart.lastToolName).toBe('searchDocs')
    expect(progressPart?.type === 'qoder.subtask-progress' && progressPart.parentTaskId).toBe('t-1')

    const endPart = parts.find((p) => p.type === 'qoder.subtask-end')
    expect(endPart?.type === 'qoder.subtask-end' && endPart.status).toBe('completed')
    expect(endPart?.type === 'qoder.subtask-end' && endPart.summary).toBe('完成')
    expect(endPart?.type === 'qoder.subtask-end' && endPart.parentTaskId).toBe('t-1')

    // 2. 子任务内的 text part 挂上 parentTaskId
    const inTaskText = parts.find((p) => p.type === 'text' && p.text === '子任务文本')
    expect(inTaskText?.type === 'text' && inTaskText.parentTaskId).toBe('t-1')

    // 3. 主流程 text part 不挂 parentTaskId(反查不到)
    const mainText = parts.find((p) => p.type === 'text' && p.text === '主流程文本')
    expect(mainText?.type === 'text' && mainText.parentTaskId).toBeUndefined()
  })

  it('ignores system messages without a recognized task subtype', async () => {
    sdkMock.__pushScript({
      messages: [{ type: 'system', subtype: 'info' }, textDelta('ok', 'sess-noop'), resultMessage('ok', 'sess-noop')]
    })
    const events = await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const parts = events.flatMap((e) => (e.type === 'part' ? [e.part] : []))
    expect(parts.some((p) => p.type === 'qoder.subtask-start')).toBe(false)
    expect(parts.some((p) => p.type === 'qoder.subtask-progress')).toBe(false)
    expect(parts.some((p) => p.type === 'qoder.subtask-end')).toBe(false)
  })

  it('resets tool_use_id -> task_id mapping between streamChat calls', async () => {
    // 第一次流:注册 tool_use_id -> task_id
    sdkMock.__pushScript({
      messages: [
        systemSubtype('task_started', { task_id: 't-x', tool_use_id: 'tu-x' }),
        textDelta('first', 'sess-a'),
        resultMessage('first', 'sess-a')
      ]
    })
    await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'first', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )

    // 第二次流:parent_tool_use_id 复用 tu-x —— driver 在 streamChat 开头已重置 Map,
    // 反查为空 → 不挂 parentTaskId(否则会错误地挂上 t-x)
    sdkMock.__pushScript({
      messages: [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'no parent' }],
            parent_tool_use_id: 'tu-x'
          }
        },
        textDelta('second', 'sess-b'),
        resultMessage('second', 'sess-b')
      ]
    })
    const events = await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u2', text: 'second', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const parts = events.flatMap((e) => (e.type === 'part' ? [e.part] : []))
    const textParts = parts.filter((p) => p.type === 'text')
    expect(textParts.length).toBeGreaterThan(0)
    textParts.forEach((p) => {
      if (p.type === 'text') expect(p.parentTaskId).toBeUndefined()
    })
    // 第二次流不应再 emit 子任务 part
    expect(parts.some((p) => p.type === 'qoder.subtask-start')).toBe(false)
  })
})
