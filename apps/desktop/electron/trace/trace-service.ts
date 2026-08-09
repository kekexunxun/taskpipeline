/**
 * TraceService — 聚合四路数据源为统一的 TraceEntry[] / TraceSummary[]。
 *
 * 数据源：
 *   ① tasks + events 表（SQLite）
 *   ② chats-v3（对话 JSON）
 *   ③ pi-sessions/*.jsonl（Pi 官方 session，历史兜底）
 *   ④ pi-trace-extension events.jsonl（执行视角，主）
 *
 * 纯读取、不写库；列表只读轻量信息，详情按需全量解析。
 * 任务 ↔ Pi 会话关联（D6）：`pi_session_path` 文件名匹配优先，时间窗兜底。
 */

import type { AgentEvent, TaskStore, TraceEntry, TraceEvent, TraceKind, TraceSummary } from '@coding-agent/core'
import type { ChatService } from '../chat/chat-service.js'
import { chatEntries } from './chat-entries.js'
import { parseQoderTraceFile } from './qoder-trace.js'
import { listPiSessionFiles, parsePiSessionFile, sessionIdFromFile } from './pi-session-trace.js'
import { listPiTraceSessions, parsePiTraceEvents, summarizePiTrace } from './pi-trace-events.js'

/** D6 时间窗兜底：±5 分钟内任务有事件即视为关联候选。 */
const TRACE_WINDOW_MS = 5 * 60 * 1000
/** pi-trace events.jsonl 平均每事件字节数（估算 entryCount 用，避免整读大文件）。 */
const AVG_EVENT_BYTES = 600

export class TraceService {
  constructor(
    private readonly store: TaskStore,
    private readonly chatService: ChatService,
    private readonly dataDir: string,
    /** fallback agentDir；优先读取 settings 里的 `piAgentDir`（运行时可能被设置覆盖）。 */
    private readonly defaultAgentDir: string
  ) {}

  /** 解析当前生效的 Pi agent 目录（settings 优先，fallback 构造参数）。 */
  private resolveAgentDir(): string {
    return this.store.getSetting('piAgentDir') ?? this.defaultAgentDir
  }

  /** 聚合四路数据源为列表 summary，按 updatedAt 倒序。 */
  async listSummaries(): Promise<TraceSummary[]> {
    const summaries: TraceSummary[] = []
    const tasks = this.store.listTasks()

    // ① 任务（events 表）—— stats 来自任务的 sessionUsage（Token / 成本 / 时长 / 模型）。
    for (const task of tasks) {
      const events = this.store.listEvents(task.id)
      const usage = task.sessionUsage
      summaries.push({
        traceId: task.id,
        kind: 'task',
        title: task.title,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        entryCount: events.length,
        state: task.state,
        stats: usage
          ? {
              turns: usage.turns,
              tokens: { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens },
              costUsd: usage.costUsd,
              durationMs: usage.durationMs,
              model: task.qoderModel ?? usage.provider
            }
          : undefined,
        lastEntry: lastOf(events, (event) => ({
          type: mapEventKind(event.kind),
          title: event.title,
          createdAt: event.createdAt
        }))
      })
    }

    // ② 对话（chats-v3）—— stats 只带模型名（消息内未持久化 usage）。
    for (const chat of this.chatService.listChats()) {
      summaries.push({
        traceId: chat.id,
        kind: 'chat',
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        entryCount: chat.messageCount,
        stats: chat.model ? { model: chat.model } : undefined
      })
    }

    // ③ 官方 Pi session（历史兜底）
    const referenced = tasks.map((task) => task.piSessionPath ?? '')
    for (const file of listPiSessionFiles(this.dataDir, referenced)) {
      const sessionId = sessionIdFromFile(file)
      const entries = parsePiSessionFile(file)
      summaries.push({
        traceId: sessionId,
        kind: 'pi_session',
        title: `Pi 会话 ${sessionId.slice(0, 12)}`,
        createdAt: firstCreatedAt(entries) ?? new Date().toISOString(),
        updatedAt: lastCreatedAt(entries) ?? new Date().toISOString(),
        entryCount: entries.length,
        state: entries.at(-1)?.type === 'session_end' ? 'ended' : 'running',
        linkedTaskId: this.linkedTaskFor(sessionId)
      })
    }

    // ④ pi-trace sessions（执行视角，主）—— stats 流式聚合 turn_summary 的 Token / 成本 / 模型 / 时长。
    for (const info of listPiTraceSessions(this.resolveAgentDir())) {
      const startedAt = info.startedAt ?? new Date(info.mtimeMs).toISOString()
      const stats = await summarizePiTrace(info.eventsFile)
      summaries.push({
        traceId: info.sessionId,
        kind: 'pi_session',
        title: `执行 Trace ${info.sessionId.slice(0, 12)}`,
        createdAt: startedAt,
        updatedAt: new Date(info.mtimeMs).toISOString(),
        entryCount: Math.max(1, Math.round(info.sizeBytes / AVG_EVENT_BYTES)),
        state: info.firstLine?.type === 'session_start' ? (info.traceHtmlPath ? 'ended' : 'running') : 'running',
        stats: Object.keys(stats).length > 0 ? stats : undefined,
        lastEntry: info.firstLine ? { type: 'session_start', title: '执行会话开始', createdAt: startedAt } : undefined,
        traceHtmlPath: info.traceHtmlPath,
        linkedTaskId: this.linkedTaskFor(info.sessionId) ?? this.linkedByTimeWindow(new Date(startedAt).getTime())
      })
    }

    // ⑤ 「其它」业务事件（如 AI 生成 Agent 模板）。
    // 不挂载任务，作为独立 trace 出现；详情页走 store.getTraceEvent() 取原始事件。
    for (const event of this.store.listTraceEvents()) {
      summaries.push(traceEventToSummary(event))
    }

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 单条 trace 的完整轨迹。pi_session 优先 ④ 执行视图，缺省回退 ③ 官方会话。 */
  async getTrace(traceId: string, kind: TraceKind): Promise<TraceEntry[]> {
    if (kind === 'task') {
      // events 表 + Qoder 执行 trace（thinking / 工具调用 / 结果等 events 里没有的细节）合并。
      const events = this.store.listEvents(traceId).map(eventToTraceEntry)
      const qoder = await parseQoderTraceFile(this.dataDir, traceId)
      return mergeTaskTrace(events, qoder)
    }
    if (kind === 'chat') return chatEntries(traceId, this.chatService.getChat(traceId)?.messages ?? [])
    if (kind === 'other') {
      const event = this.store.getTraceEvent(traceId)
      return event ? [traceEventToEntry(event)] : []
    }

    const traceInfo = listPiTraceSessions(this.resolveAgentDir()).find((info) => info.sessionId === traceId)
    if (traceInfo) {
      const entries = await parsePiTraceEvents(traceInfo.eventsFile)
      if (entries.length > 0) return entries
    }
    const referenced = this.store.listTasks().map((task) => task.piSessionPath ?? '')
    const file = listPiSessionFiles(this.dataDir, referenced).find((f) => sessionIdFromFile(f) === traceId)
    if (file) return parsePiSessionFile(file)
    return []
  }

  /** D6：按 sessionId（session 文件名）匹配任务 `pi_session_path`。 */
  private linkedTaskFor(sessionId: string): string | undefined {
    for (const task of this.store.listTasks()) {
      if (task.piSessionPath && sessionIdFromFile(task.piSessionPath) === sessionId) return task.id
    }
    return undefined
  }

  /** D6 兜底：session 开始时间 ±5min 内有事件的任务视为关联候选，取最接近者。 */
  private linkedByTimeWindow(sessionStartMs: number): string | undefined {
    let best: { taskId: string; delta: number } | undefined
    for (const task of this.store.listTasks()) {
      const events = this.store.listEvents(task.id)
      if (events.length === 0) continue
      const first = Date.parse(events[0]!.createdAt)
      const last = Date.parse(events[events.length - 1]!.createdAt)
      if (Number.isNaN(first) || Number.isNaN(last)) continue
      const delta = Math.min(Math.abs(sessionStartMs - first), Math.abs(sessionStartMs - last))
      if (delta <= TRACE_WINDOW_MS && (!best || delta < best.delta)) best = { taskId: task.id, delta }
    }
    return best?.taskId
  }
}

// === 归一化辅助 ==============================================================

/** AgentEvent.kind → TraceEntry.type。 */
export function mapEventKind(kind: AgentEvent['kind']): TraceEntry['type'] {
  switch (kind) {
    case 'message':
      return 'message'
    case 'tool':
      return 'tool_call'
    case 'permission':
      return 'status'
    case 'command':
      return 'tool_call'
    case 'diff':
      return 'diff'
    case 'review':
      return 'review'
    case 'error':
      return 'error'
    case 'status':
      return 'status'
  }
}

export function eventToTraceEntry(event: AgentEvent): TraceEntry {
  // events 表不持久化 AgentEvent.parentTaskId / taskId / sdkSubtype,这些字段只存
  // 在 payload(JSON 列)里。这里从 payload 提到 entry 顶层,让 groupByParentTask
  // 能识别子任务边界。
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const out: TraceEntry = {
    id: `ev-${event.id}`,
    traceId: event.taskId,
    kind: 'task',
    type: mapEventKind(event.kind),
    title: event.title,
    detail: event.detail,
    payload: event.payload,
    createdAt: event.createdAt,
    source: 'events'
  }
  // 旧数据兜底:payload 只有 subtaskId / sdkSubtype、没有 parentTaskId 时,这里用
  // subtaskId 自指(写到 taskId 字段,因为 TraceEntry 没有 subtaskId,只有 taskId),
  // groupByParentTask 的 `item.taskId === parent && !group.header` 规则会把它
  // 识别为 group header。行为与 Timeline / qoder-trace / qoder-chat-driver 一致。
  if (typeof payload.subtaskId === 'string') {
    out.taskId = payload.subtaskId
    out.parentTaskId = payload.subtaskId
  } else if (typeof payload.parentTaskId === 'string') {
    out.parentTaskId = payload.parentTaskId
  }
  if (typeof payload.sdkSubtype === 'string') out.sdkSubtype = payload.sdkSubtype
  return out
}

/** 任务详情 = events + Qoder 执行 trace 补充（thinking / 工具调用 / 结果 / 会话结束汇总），按时间排序。 */
function mergeTaskTrace(events: TraceEntry[], qoder: TraceEntry[]): TraceEntry[] {
  if (qoder.length === 0) return events
  const supplement = qoder.filter(
    (entry) =>
      entry.type === 'thinking' ||
      entry.type === 'tool_call' ||
      entry.type === 'tool_result' ||
      (entry.type === 'status' && entry.title === 'Qoder 会话结束')
  )
  if (supplement.length === 0) return events
  return [...events, ...supplement].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

/** trace_events（不挂任务） → TraceSummary，固定走 "other" 分类。 */
function traceEventToSummary(event: TraceEvent): TraceSummary {
  return {
    traceId: event.id,
    kind: 'other',
    title: event.title,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
    entryCount: 1,
    state: 'ended',
    lastEntry: { type: 'status', title: event.title, createdAt: event.createdAt }
  }
}

/** trace_events → TraceEntry，作为详情页唯一一条记录。 */
function traceEventToEntry(event: TraceEvent): TraceEntry {
  return {
    id: `other-${event.id}`,
    traceId: event.id,
    kind: 'other',
    type: 'status',
    title: event.title,
    detail: event.detail,
    payload: {
      ...(event.payload && typeof event.payload === 'object' ? event.payload : {}),
      subType: event.subType,
      category: event.category
    },
    createdAt: event.createdAt,
    source: 'events'
  }
}

function lastOf<T, R>(items: T[], map: (item: T) => R | undefined): R | undefined {
  const last = items.at(-1)
  return last ? map(last) : undefined
}

function firstCreatedAt(entries: TraceEntry[]): string | undefined {
  return entries[0]?.createdAt
}

function lastCreatedAt(entries: TraceEntry[]): string | undefined {
  return entries.at(-1)?.createdAt
}
