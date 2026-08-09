import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskStore, type TraceEntry } from '@coding-agent/core'
import type { ChatService } from '../chat/chat-service.js'
import type { StoredMessage } from '../chat/chat-types.js'
import { parsePiSessionFile, sessionIdFromFile } from './pi-session-trace.js'
import { listPiTraceSessions, parsePiTraceEvents } from './pi-trace-events.js'
import { QoderTraceSink } from './qoder-trace.js'
import { TraceService, eventToTraceEntry } from './trace-service.js'

const roots: string[] = []
function temporaryRoot(name: string) {
  const root = join(tmpdir(), `coding-agent-trace-${name}-${crypto.randomUUID()}`)
  roots.push(root)
  mkdirSync(root, { recursive: true })
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// === fixture：pi-trace-extension events.jsonl =================================

const PI_TRACE_EVENTS = [
  { ts: 1750000000000, sessionId: 'sess-pi', type: 'session_start' },
  {
    ts: 1750000001000,
    sessionId: 'sess-pi',
    type: 'interaction_start',
    interactionId: 1,
    prompt: '修复登录 bug',
    slashCommand: null
  },
  { ts: 1750000002000, sessionId: 'sess-pi', turnIndex: 0, type: 'turn_start', interactionId: 1 },
  { ts: 1750000003000, sessionId: 'sess-pi', turnIndex: 0, stepIndex: 1, type: 'step_start' },
  {
    ts: 1750000003500,
    sessionId: 'sess-pi',
    turnIndex: 0,
    stepIndex: 1,
    type: 'llm_request',
    input: { model: 'gpt-5', tools: [{ name: 'read' }, { name: 'edit' }] }
  },
  {
    ts: 1750000008000,
    sessionId: 'sess-pi',
    turnIndex: 0,
    stepIndex: 1,
    type: 'step_end',
    text: '我来分析这个问题',
    thinking: '需要先定位代码',
    toolCalls: [{ id: 'tc1', name: 'grep', args: { query: 'login' } }],
    usage: { input: 100, output: 50, cost: 0.001 }
  },
  {
    ts: 1750000009000,
    sessionId: 'sess-pi',
    turnIndex: 0,
    stepIndex: 1,
    type: 'tool_start',
    toolCallId: 'tc1',
    toolName: 'grep',
    args: { query: 'login' }
  },
  {
    ts: 1750000010000,
    sessionId: 'sess-pi',
    turnIndex: 0,
    stepIndex: 1,
    type: 'tool_end',
    toolCallId: 'tc1',
    toolName: 'grep',
    durationMs: 1000,
    isError: false,
    resultPreview: 'file.ts:10: function login'
  },
  {
    ts: 1750000011000,
    sessionId: 'sess-pi',
    turnIndex: 0,
    stepIndex: 1,
    type: 'file_change',
    path: 'src/login.ts',
    op: 'edit',
    toolName: 'edit'
  },
  {
    ts: 1750000012000,
    sessionId: 'sess-pi',
    turnIndex: 0,
    type: 'turn_summary',
    stepCount: 1,
    durationMs: 10000,
    filesChanged: [{ path: 'src/login.ts', op: 'edit', count: 1 }],
    toolsUsed: [{ name: 'grep', count: 1, errors: 0, totalMs: 1000 }],
    usage: { input: 100, output: 50, cost: 0.001 },
    finalText: '修复完成'
  },
  { ts: 1750000013000, sessionId: 'sess-pi', turnIndex: 0, type: 'turn_end', durationMs: 11000 },
  { type: 'future_event', sessionId: 'sess-pi', ts: 1750000013500 }, // 未知类型：应跳过
  { ts: 1750000014000, sessionId: 'sess-pi', type: 'session_shutdown', reason: 'quit' }
]

function writePiTraceSession(agentDir: string, sessionId: string, events: unknown[]) {
  const dir = join(agentDir, 'traces', sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'), 'utf8')
  return dir
}

// === fixture：官方 session JSONL ==============================================

const OFFICIAL_SESSION = [
  { type: 'session', version: 3, id: 'sess-official', timestamp: '2025-01-01T00:00:00.000Z', cwd: '/tmp/repo' },
  {
    type: 'message',
    id: 'm1',
    parentId: null,
    timestamp: '2025-01-01T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text: '你好' }] }
  },
  {
    type: 'message',
    id: 'm2',
    parentId: 'm1',
    timestamp: '2025-01-01T00:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: '你好！有什么可以帮你' }] }
  },
  {
    type: 'message',
    id: 'm3',
    parentId: 'm2',
    timestamp: '2025-01-01T00:00:03.000Z',
    message: { role: 'toolResult', content: '[ok]', toolCallId: 't1', toolName: 'bash' }
  },
  {
    type: 'model_change',
    id: 'm4',
    parentId: 'm3',
    timestamp: '2025-01-01T00:00:04.000Z',
    provider: 'openai',
    modelId: 'gpt-5'
  },
  {
    type: 'compaction',
    id: 'm5',
    parentId: 'm4',
    timestamp: '2025-01-01T00:00:05.000Z',
    summary: '前面的对话已压缩',
    firstKeptEntryId: 'm3',
    tokensBefore: 1000
  }
]

// === 假 ChatService ===========================================================

function fakeChatService(): ChatService {
  const now = new Date().toISOString()
  const message: StoredMessage = {
    id: 'message-1',
    role: 'user',
    createdAt: now,
    driverId: 'openai',
    raw: { kind: 'text', text: '帮我看看' },
    parts: [
      { driverId: 'openai', type: 'text', text: '帮我看看' },
      { driverId: 'openai', type: 'openai.tool-call', toolCallId: 'tc-1', name: 'read', input: { path: 'a.ts' } },
      { driverId: 'openai', type: 'openai.tool-result', toolCallId: 'tc-1', output: '内容' }
    ]
  }
  return {
    listChats: () => [
      { id: 'chat-1', title: '测试对话', createdAt: now, updatedAt: now, messageCount: 1, model: 'openai:default' }
    ],
    getChat: (id: string) =>
      id === 'chat-1'
        ? {
            conversation: {
              id: 'chat-1',
              title: '测试对话',
              createdAt: now,
              updatedAt: now,
              messageCount: 1,
              messages: []
            },
            messages: [message]
          }
        : undefined
  } as unknown as ChatService
}

describe('pi-trace-events', () => {
  it('扫描 traces 目录并解析 events.jsonl 事件映射', async () => {
    const agentDir = temporaryRoot('pi')
    writePiTraceSession(agentDir, 'sess-pi', PI_TRACE_EVENTS)

    const sessions = listPiTraceSessions(agentDir)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.sessionId).toBe('sess-pi')
    expect(sessions[0]!.startedAt).toBe(new Date(1750000000000).toISOString())
    expect(sessions[0]!.traceHtmlPath).toBeUndefined()

    const entries = await parsePiTraceEvents(sessions[0]!.eventsFile)
    const summary = entries.map((e) => `${e.type}:${e.title}`)
    expect(summary[0]).toBe('session_start:执行会话开始')
    expect(summary).toContain('message:用户输入')
    expect(summary).toContain('status:轮次 0 开始')
    expect(summary).toContain('thinking:LLM 调用（step 1 · turn 0）')
    expect(summary).toContain('thinking:LLM 请求（step 1 · turn 0）')
    expect(summary).toContain('message:AI')
    expect(summary).toContain('thinking:思考（step 1 · turn 0）')
    expect(summary).toContain('tool_call:工具 grep')
    expect(summary).toContain('tool_result:工具结果 grep')
    expect(summary).toContain('diff:edit src/login.ts')
    expect(summary).toContain('status:轮次 0 汇总')
    expect(summary).toContain('session_end:执行会话结束')
    // 未知事件类型被跳过
    expect(summary.some((s) => s.includes('future_event'))).toBe(false)
    // 摘要信息（tokens / 工具统计）
    const turnSummary = entries.find((e) => e.type === 'status' && e.title.includes('汇总'))
    expect(turnSummary?.detail).toContain('tokens: in 100 / out 50')
    expect(turnSummary?.detail).toContain('grep×1')
  })

  it('目录不存在时返回空列表', () => {
    expect(listPiTraceSessions(temporaryRoot('empty'))).toEqual([])
  })

  it('损坏行不中断整体解析', async () => {
    const agentDir = temporaryRoot('bad')
    const dir = writePiTraceSession(agentDir, 'sess-bad', [
      PI_TRACE_EVENTS[0],
      'not-json{{',
      PI_TRACE_EVENTS[PI_TRACE_EVENTS.length - 1]!
    ])
    const entries = await parsePiTraceEvents(join(dir, 'events.jsonl'))
    expect(entries).toHaveLength(2)
  })
})

describe('pi-session-trace', () => {
  it('解析官方 session JSONL 为 TraceEntry', () => {
    const root = temporaryRoot('official')
    const file = join(root, 'pi-sessions', 'sess-official.jsonl')
    mkdirSync(join(root, 'pi-sessions'), { recursive: true })
    writeFileSync(file, OFFICIAL_SESSION.map((e) => JSON.stringify(e)).join('\n'), 'utf8')

    expect(sessionIdFromFile(file)).toBe('sess-official')
    const entries = parsePiSessionFile(file)
    const types = entries.map((e) => `${e.type}:${e.title}`)
    expect(types[0]).toBe('session_start:Pi 会话开始')
    expect(types).toContain('message:用户')
    expect(types).toContain('message:AI')
    expect(types).toContain('tool_result:工具结果')
    expect(types).toContain('status:切换模型')
    expect(types).toContain('status:上下文压缩')
    expect(entries.find((e) => e.title === 'AI')?.detail).toBe('你好！有什么可以帮你')
  })

  it('文件缺失返回空数组', () => {
    expect(parsePiSessionFile('/nonexistent/sess.jsonl')).toEqual([])
  })
})

describe('TraceService', () => {
  it('聚合 task / chat / pi_session 三类 summary，并按更新时间排序', async () => {
    const dataDir = temporaryRoot('svc')
    const agentDir = temporaryRoot('svc-agent')
    const store = new TaskStore(':memory:')
    const task = store.createTask({ title: '示例任务', description: 'desc' })
    store.addEvent({ taskId: task.id, kind: 'status', title: '开始执行' })
    // 任务 sessionUsage → stats（Token / 成本 / 时长 / 模型）
    store.updateTask(task.id, {
      sessionUsage: {
        provider: 'qoder',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        costUsd: 0.01,
        durationMs: 30000,
        turns: 2
      },
      qoderModel: 'qoder:claude-sonnet-4.5'
    })

    // ③ 官方 session
    mkdirSync(join(dataDir, 'pi-sessions'), { recursive: true })
    writeFileSync(
      join(dataDir, 'pi-sessions', 'sess-official.jsonl'),
      OFFICIAL_SESSION.map((e) => JSON.stringify(e)).join('\n'),
      'utf8'
    )
    // ④ pi-trace session
    writePiTraceSession(agentDir, 'sess-pi', PI_TRACE_EVENTS)

    const service = new TraceService(store, fakeChatService(), dataDir, agentDir)
    const summaries = await service.listSummaries()
    const kinds = summaries.map((s) => s.kind)
    expect(kinds).toContain('task')
    expect(kinds).toContain('chat')
    expect(kinds).toContain('pi_session')
    // 倒序：最新的在前面
    for (let i = 1; i < summaries.length; i += 1) {
      expect(summaries[i - 1]!.updatedAt >= summaries[i]!.updatedAt).toBe(true)
    }
    const taskSummary = summaries.find((s) => s.kind === 'task')
    expect(taskSummary?.entryCount).toBe(1)
    expect(taskSummary?.state).toBe('draft')
    // 任务 stats 来自 sessionUsage
    expect(taskSummary?.stats).toMatchObject({
      turns: 2,
      tokens: { input: 100, output: 50, total: 150 },
      costUsd: 0.01,
      durationMs: 30000,
      model: 'qoder:claude-sonnet-4.5'
    })
    // pi-trace stats 流式聚合 turn_summary（fixture 里 usage input=100 / output=50 / cost=0.001）
    const piTraceSummary = summaries.find((s) => s.kind === 'pi_session' && s.traceId === 'sess-pi')
    expect(piTraceSummary?.stats).toMatchObject({
      turns: 1,
      tokens: { input: 100, output: 50, total: 150 },
      costUsd: 0.001
    })
    // 对话 stats 只带模型
    expect(summaries.find((s) => s.kind === 'chat')?.stats?.model).toBe('openai:default')
  })

  it('getTrace task 合并 Qoder 执行 trace 补充事件', async () => {
    const dataDir = temporaryRoot('gq')
    const store = new TaskStore(':memory:')
    const task = store.createTask({ title: '任务', description: 'd' })
    store.addEvent({ taskId: task.id, kind: 'status', title: '开始执行' })
    // Qoder trace：thinking / tool_call（events 表里没有的 step 级细节）
    const sink = new QoderTraceSink(dataDir)
    sink.append(task.id, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '分析中' } }
    })
    sink.append(task.id, {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tc1', name: 'read', input: { path: 'x.ts' } }
      }
    })

    const service = new TraceService(store, fakeChatService(), dataDir, temporaryRoot('gqa'))
    const entries = await service.getTrace(task.id, 'task')
    const types = entries.map((e) => e.type)
    expect(types).toContain('status') // events 原有
    expect(types).toContain('thinking') // qoder 补充
    expect(types).toContain('tool_call') // qoder 补充
    expect(entries.find((e) => e.type === 'tool_call')?.detail).toContain('x.ts')
    // 合并后按时间排序
    for (let i = 1; i < entries.length; i += 1) {
      expect(Date.parse(entries[i - 1]!.createdAt) <= Date.parse(entries[i]!.createdAt)).toBe(true)
    }
  })

  it('getTrace 按 kind 返回：task 来自 events 表', async () => {
    const store = new TaskStore(':memory:')
    const task = store.createTask({ title: '任务', description: 'd' })
    store.addEvent({ taskId: task.id, kind: 'error', title: '出错了', detail: 'boom' })
    const service = new TraceService(store, fakeChatService(), temporaryRoot('g1'), temporaryRoot('g1a'))
    const entries = await service.getTrace(task.id, 'task')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe('error')
    expect(entries[0]!.detail).toBe('boom')
  })

  it('getTrace chat 来自对话 parts', async () => {
    const service = new TraceService(
      new TaskStore(':memory:'),
      fakeChatService(),
      temporaryRoot('g2'),
      temporaryRoot('g2a')
    )
    const entries = await service.getTrace('chat-1', 'chat')
    expect(entries.map((e) => e.type)).toEqual(['message', 'tool_call', 'tool_result'])
    expect(entries[1]!.title).toBe('工具 read')
  })

  it('getTrace pi_session 优先 pi-trace 执行视图，缺省回退官方 session', async () => {
    const dataDir = temporaryRoot('g3')
    const agentDir = temporaryRoot('g3a')
    const store = new TaskStore(':memory:')
    const task = store.createTask({ title: '任务', description: 'd' })
    store.updateTask(task.id, { piSessionPath: join(dataDir, 'pi-sessions', 'sess-official.jsonl') })

    // 两个数据源都有
    mkdirSync(join(dataDir, 'pi-sessions'), { recursive: true })
    writeFileSync(
      join(dataDir, 'pi-sessions', 'sess-official.jsonl'),
      OFFICIAL_SESSION.map((e) => JSON.stringify(e)).join('\n'),
      'utf8'
    )
    writePiTraceSession(agentDir, 'sess-official', PI_TRACE_EVENTS)

    const service = new TraceService(store, fakeChatService(), dataDir, agentDir)
    const viaPiTrace = await service.getTrace('sess-official', 'pi_session')
    // ④ 优先：执行视图（含 session_start 执行会话开始）
    expect(viaPiTrace[0]!.source).toBe('pi_trace')
    expect(viaPiTrace[0]!.title).toBe('执行会话开始')
  })

  it('D6：pi_session_path 文件名匹配关联任务', async () => {
    const dataDir = temporaryRoot('d6')
    const agentDir = temporaryRoot('d6a')
    const store = new TaskStore(':memory:')
    const task = store.createTask({ title: '任务', description: 'd' })
    store.updateTask(task.id, { piSessionPath: join(dataDir, 'pi-sessions', 'sess-pi.jsonl') })
    writePiTraceSession(agentDir, 'sess-pi', PI_TRACE_EVENTS)

    const service = new TraceService(store, fakeChatService(), dataDir, agentDir)
    const summary = (await service.listSummaries()).find((s) => s.kind === 'pi_session' && s.traceId === 'sess-pi')
    expect(summary?.linkedTaskId).toBe(task.id)
  })

  it('未知 trace 返回空数组', async () => {
    const service = new TraceService(
      new TaskStore(':memory:'),
      fakeChatService(),
      temporaryRoot('g4'),
      temporaryRoot('g4a')
    )
    expect(await service.getTrace('nope', 'pi_session')).toEqual([])
    expect(await service.getTrace('nope', 'task')).toEqual([])
  })

  it('「其它」业务事件：listSummaries 包含 kind=other 条目，getTrace 返回单条 entry', async () => {
    const store = new TaskStore(':memory:')
    const event = store.addTraceEvent({
      category: 'other',
      subType: 'agent_template_generation',
      title: 'AI 生成 Agent 模板',
      detail: '描述：为支付服务补充幂等性指引\n参考仓库：payment-service',
      payload: { model: 'qoder:claude-sonnet-4.5', repositoryIds: ['r1'] }
    })

    const service = new TraceService(store, fakeChatService(), temporaryRoot('g5'), temporaryRoot('g5a'))
    const summaries = await service.listSummaries()
    const otherSummary = summaries.find((s) => s.kind === 'other' && s.traceId === event.id)
    expect(otherSummary).toBeDefined()
    expect(otherSummary?.title).toBe('AI 生成 Agent 模板')
    expect(otherSummary?.entryCount).toBe(1)
    expect(otherSummary?.state).toBe('ended')

    const entries = await service.getTrace(event.id, 'other')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('other')
    expect(entries[0]!.title).toBe('AI 生成 Agent 模板')
    expect(entries[0]!.detail).toContain('支付服务')
    expect(entries[0]!.payload).toMatchObject({
      category: 'other',
      subType: 'agent_template_generation',
      model: 'qoder:claude-sonnet-4.5'
    })
  })

  it('「其它」详情不存在时返回空数组', async () => {
    const service = new TraceService(
      new TaskStore(':memory:'),
      fakeChatService(),
      temporaryRoot('g6'),
      temporaryRoot('g6a')
    )
    expect(await service.getTrace('does-not-exist', 'other')).toEqual([])
  })
})

// 避免未使用告警：TraceEntry 类型引用保留
export type { TraceEntry }

describe('eventToTraceEntry', () => {
  /**
   * 旧数据兜底:老版本 log.ts 只在 payload 里写 subtaskId / sdkSubtype,不写 parentTaskId;
   * eventToTraceEntry 现在从 payload 把这些字段提到 entry 顶层(否则 groupByParentTask
   * 在 entry 顶层看不到,旧数据全部进 main 流)。回归测试保护这条数据通路。
   */
  it('旧数据: payload 只有 subtaskId / sdkSubtype → entry 顶层有 taskId + parentTaskId(自指) + sdkSubtype', () => {
    const entry = eventToTraceEntry({
      id: 'ev-1',
      taskId: 'task-1',
      kind: 'status',
      title: 'Qoder 子任务启动',
      detail: '{"type":"system",...}',
      payload: {
        subtaskId: 'sub-old',
        sdkSubtype: 'task_started',
        taskType: 'Explore',
        description: '在仓库里搜代码'
      },
      createdAt: '2026-08-08T00:00:00.000Z'
    })
    expect(entry.taskId).toBe('sub-old')
    expect(entry.parentTaskId).toBe('sub-old')
    expect(entry.sdkSubtype).toBe('task_started')
  })

  it('新数据: payload 同时有 subtaskId + parentTaskId → 优先用 subtaskId 自指(与 log.ts 写入路径一致)', () => {
    const entry = eventToTraceEntry({
      id: 'ev-2',
      taskId: 'task-2',
      kind: 'status',
      title: 'Qoder 子任务进度',
      detail: '{}',
      payload: {
        parentTaskId: 'sub-new',
        subtaskId: 'sub-new',
        sdkSubtype: 'task_progress'
      },
      createdAt: '2026-08-08T00:00:00.000Z'
    })
    expect(entry.parentTaskId).toBe('sub-new')
    expect(entry.taskId).toBe('sub-new')
    expect(entry.sdkSubtype).toBe('task_progress')
  })

  it('主流程 entry: payload 不含 subtaskId / parentTaskId → entry 顶层不挂子任务字段', () => {
    const entry = eventToTraceEntry({
      id: 'ev-3',
      taskId: 'task-3',
      kind: 'message',
      title: 'Qoder Agent',
      detail: '主流程回复',
      payload: { usage: { total_tokens: 100 } },
      createdAt: '2026-08-08T00:00:00.000Z'
    })
    expect(entry.parentTaskId).toBeUndefined()
    expect(entry.taskId).toBeUndefined()
    expect(entry.sdkSubtype).toBeUndefined()
    // payload 原样保留
    expect(entry.payload).toEqual({ usage: { total_tokens: 100 } })
  })
})
