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
  // 把脚本化的 SDKMessage 数组喂给 driver。
  // 输出流是"常驻"的:脚本消息耗尽后挂起等待新脚本(模拟真实 SDK 会话在回合间保持),
  // close() 后才真正结束 —— 这是常驻会话引擎测试的关键。
  const scripts: Array<{ messages: SdkMessage[]; cursor: number }> = []
  const scriptWaiters: Array<() => void> = []
  const captured: Array<{ options: Record<string, unknown>; prompt?: string }> = []
  let closed = false
  let generation = 0
  const wake = () => {
    for (const w of scriptWaiters.splice(0)) w()
  }
  return {
    accessToken: (token: string) => ({ token }),
    query: (args: { prompt?: string; options?: Record<string, unknown> }) => {
      captured.push({ options: args.options ?? {}, prompt: args.prompt })
      return {
        [Symbol.asyncIterator]() {
          const myGen = generation
          return {
            async next() {
              while (true) {
                // 先检查世代:被唤醒的旧会话 consume 直接退出,不能抢新测试的脚本。
                if (myGen !== generation || closed) return { value: undefined, done: true }
                const script = scripts[0]
                if (script && script.cursor < script.messages.length) {
                  return { value: script.messages[script.cursor++] as SdkMessage, done: false }
                }
                // 当前脚本已耗尽:换下一个脚本(如果有);否则挂起等待新脚本 / close。
                if (scripts.length > 1) {
                  scripts.shift()
                  continue
                }
                await new Promise<void>((resolve) => scriptWaiters.push(resolve))
              }
            },
            async return() {
              closed = true
              wake()
              return { value: undefined, done: true }
            },
            async throw(error: unknown) {
              throw error
            }
          }
        },
        async close() {
          closed = true
          wake()
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
    __pushScript: (script: { messages: SdkMessage[] }) => {
      scripts.push({ messages: script.messages, cursor: 0 })
      wake()
    },
    __getLastQueryOptions: () => captured[captured.length - 1]?.options,
    __getLastQueryPrompt: () => captured[captured.length - 1]?.prompt,
    __getQueryCallCount: () => captured.length,
    __resetCaptured: () => {
      captured.length = 0
      scripts.length = 0
      closed = false
      generation++
      wake()
    }
  }
})

// 必须在 vi.mock 之后 import driver
const { QoderChatDriver } = await import('./qoder-chat-driver.js')
const sdkMock = (await import('@qoder-ai/qoder-agent-sdk')) as unknown as {
  __pushScript: (script: { messages: SdkMessage[] }) => void
  __getLastQueryOptions: () => Record<string, unknown> | undefined
  __getLastQueryPrompt: () => string | undefined
  __getQueryCallCount: () => number
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

// mock 的脚本/世代状态在所有 describe 间共享:每个测试前必须重置,
// 否则旧测试残留的 consume(挂起在脚本等待上)会污染后续测试。
beforeEach(() => {
  sdkMock.__resetCaptured()
})

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

  it('emits task-created only once when both tool_result and result describe a task', async () => {
    // tool_result 与 result 都携带可描述的产出(含 key)→ 去重后只发一次 task-created。
    sdkMock.__pushScript({
      messages: [
        assistantMessageWithToolUse('createJiraIssue', {}, 'tc-dup', 'sess-4'),
        assistantMessageWithToolResult('tc-dup', { key: 'BSADAPT-99' }, false),
        { type: 'result', session_id: 'sess-4', result: { key: 'BSADAPT-99' } }
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
              const key = (output as Record<string, { toString(): string }>).key.toString()
              return {
                backend: 'jira',
                externalKey: key,
                summary: 'dup check',
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
    const taskCreated = events.filter((e) => e.type === 'task-created')
    expect(taskCreated.length).toBe(1)
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

describe('QoderChatDriver multi-turn history', () => {
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

  it('resumes from the last qoder.session id in history (会话恢复作为底层能力)', async () => {
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
    // 历史末尾有 qoder.session → 用最后 sessionId resume,上下文由 Qoder 会话端恢复(不拼历史)。
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

  it('reuses the resident session across turns in the same conversation (多轮对话执行引擎)', async () => {
    sdkMock.__pushScript({
      messages: [textDelta('first answer', 'sess-1'), resultMessage('first answer', 'sess-1')]
    })
    const d = driver()
    const common = { model: 'qoder:claude-sonnet-4.5', history: [], signal: new AbortController().signal }
    const first = await collect(
      d.streamChat({ conversationId: 'c', ...common, userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() } })
    )
    // 第二次回合:先发起 streamChat(回合挂起等输出),再注入第二个脚本 —— 模拟真实时序:
    // 用户发消息 → SDK 会话产出该轮输出(不是回合开始前就产出)。
    const secondPromise = (async () =>
      collect(
        d.streamChat({ conversationId: 'c', ...common, userInput: { id: 'u2', text: 'again', createdAt: new Date().toISOString() } })
      ))()
    sdkMock.__pushScript({
      messages: [textDelta('second answer', 'sess-1'), resultMessage('second answer', 'sess-1')]
    })
    const second = await secondPromise
    const firstText = first.filter((e) => e.type === 'part' && e.part.type === 'text').map((e) => (e.type === 'part' ? e.part.text : ''))
    const secondText = second.filter((e) => e.type === 'part' && e.part.type === 'text').map((e) => (e.type === 'part' ? e.part.text : ''))
    expect(firstText.join('')).toContain('first answer')
    expect(secondText.join('')).toContain('second answer')
    // 两次 streamChat 复用同一会话:query 只创建一次(多轮由消息流驱动,不新建会话)。
    expect(sdkMock.__getQueryCallCount()).toBe(1)
  })

  it('abort stops the current turn immediately and keeps the session reusable', async () => {
    // 只给一条 textDelta、不给 result:回合挂起(模拟 SDK 卡住 / 长时间无输出)。
    sdkMock.__pushScript({ messages: [textDelta('partial answer', 's1')] })
    const d = driver()
    const abort = new AbortController()
    const common = { conversationId: 'c', model: 'qoder:claude-sonnet-4.5', history: [], signal: abort.signal }
    const turnPromise = (async () =>
      collect(
        d.streamChat({ ...common, userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() } })
      ))()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // abort 必须唤醒挂起的回合(此前只靠 SDK 继续产出消息才能退出)。
    abort.abort()
    const events = await turnPromise
    const texts = events.filter((e) => e.type === 'part' && e.part.type === 'text')
    expect(texts.length).toBeGreaterThan(0)
    // 会话保留:还能开下一回合。
    sdkMock.__pushScript({ messages: [textDelta('after abort', 's1'), resultMessage('after abort', 's1')] })
    const second = await collect(
      d.streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        signal: new AbortController().signal,
        userInput: { id: 'u2', text: 'again', createdAt: new Date().toISOString() }
      })
    )
    const secondText = second.filter((e) => e.type === 'part' && e.part.type === 'text').map((e) => (e.type === 'part' ? e.part.text : ''))
    expect(secondText.join('')).toContain('after abort')
    // 复用同一会话:query 仍只创建一次。
    expect(sdkMock.__getQueryCallCount()).toBe(1)
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

  it('passes the conversation cwd to the SDK query options', async () => {
    sdkMock.__pushScript({ messages: [textDelta('hi', 'sess-1'), resultMessage('hi', 'sess-1')] })
    await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal,
        cwd: '/project/foo'
      })
    )
    const options = sdkMock.__getLastQueryOptions()
    expect(options?.cwd).toBe('/project/foo')
  })

  it('defaults cwd to process.cwd() for plain chats', async () => {
    sdkMock.__pushScript({ messages: [textDelta('hi', 'sess-1'), resultMessage('hi', 'sess-1')] })
    await collect(
      driver().streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(sdkMock.__getLastQueryOptions()?.cwd).toBe(process.cwd())
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

  it('new session does not leak tool_use_id -> task_id mapping across streamChat calls', async () => {
    // 该映射是会话级(taskIdByToolUseId):新会话(新的 driver 实例 / 新 conversationId)不残留旧映射;
    // 同一会话跨回合保留映射是设计意图 —— 同一 Qoder 会话内 tool_use_id 是 UUID,不会复用撞车。
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
