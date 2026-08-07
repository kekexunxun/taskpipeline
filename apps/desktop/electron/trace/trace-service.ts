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

import type { AgentEvent, TaskStore, TraceEntry, TraceKind, TraceSummary } from '@coding-agent/core'
import type { ChatService } from '../chat/chat-service.js'
import type { StoredMessage } from '../chat/chat-types.js'
import { listPiSessionFiles, parsePiSessionFile, sessionIdFromFile } from './pi-session-trace.js'
import { listPiTraceSessions, parsePiTraceEvents } from './pi-trace-events.js'

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
  listSummaries(): TraceSummary[] {
    const summaries: TraceSummary[] = []
    const tasks = this.store.listTasks()

    // ① 任务（events 表）
    for (const task of tasks) {
      const events = this.store.listEvents(task.id)
      summaries.push({
        traceId: task.id,
        kind: 'task',
        title: task.title,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        entryCount: events.length,
        state: task.state,
        lastEntry: lastOf(events, (event) => ({
          type: mapEventKind(event.kind),
          title: event.title,
          createdAt: event.createdAt
        }))
      })
    }

    // ② 对话（chats-v3）
    for (const chat of this.chatService.listChats()) {
      summaries.push({
        traceId: chat.id,
        kind: 'chat',
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        entryCount: chat.messageCount
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

    // ④ pi-trace sessions（执行视角，主）
    for (const info of listPiTraceSessions(this.resolveAgentDir())) {
      const startedAt = info.startedAt ?? new Date(info.mtimeMs).toISOString()
      summaries.push({
        traceId: info.sessionId,
        kind: 'pi_session',
        title: `执行 Trace ${info.sessionId.slice(0, 12)}`,
        createdAt: startedAt,
        updatedAt: new Date(info.mtimeMs).toISOString(),
        entryCount: Math.max(1, Math.round(info.sizeBytes / AVG_EVENT_BYTES)),
        state: info.firstLine?.type === 'session_start' ? (info.traceHtmlPath ? 'ended' : 'running') : 'running',
        lastEntry: info.firstLine ? { type: 'session_start', title: '执行会话开始', createdAt: startedAt } : undefined,
        traceHtmlPath: info.traceHtmlPath,
        linkedTaskId: this.linkedTaskFor(info.sessionId) ?? this.linkedByTimeWindow(new Date(startedAt).getTime())
      })
    }

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 单条 trace 的完整轨迹。pi_session 优先 ④ 执行视图，缺省回退 ③ 官方会话。 */
  async getTrace(traceId: string, kind: TraceKind): Promise<TraceEntry[]> {
    if (kind === 'task') return this.store.listEvents(traceId).map(eventToTraceEntry)
    if (kind === 'chat') return chatEntries(traceId, this.chatService.getChat(traceId)?.messages ?? [])

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

function eventToTraceEntry(event: AgentEvent): TraceEntry {
  return {
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
}

/** 对话消息（StoredMessage，含 parts）→ TraceEntry[]。 */
function chatEntries(chatId: string, messages: StoredMessage[]): TraceEntry[] {
  const out: TraceEntry[] = []
  let seq = 0
  for (const message of messages) {
    const roleTitle = message.role === 'user' ? '用户' : message.role === 'system' ? '系统' : 'AI'
    const parts = message.parts
    if (parts.length === 0) {
      // 未注册 driver / 兜底：直接按 role 输出文本
      out.push({
        id: `chat-${chatId}-${seq++}`,
        traceId: chatId,
        kind: 'chat',
        type: 'message',
        title: roleTitle,
        detail: rawText(message),
        payload: message.raw,
        createdAt: message.createdAt,
        source: 'chat'
      })
      continue
    }
    for (const part of parts) {
      const base = { traceId: chatId, kind: 'chat' as const, createdAt: message.createdAt, source: 'chat' as const }
      if (part.type === 'text') {
        out.push({ ...base, id: `chat-${chatId}-${seq++}`, type: 'message', title: roleTitle, detail: part.text })
      } else if (part.type === 'qoder.thinking') {
        out.push({
          ...base,
          id: `chat-${chatId}-${seq++}`,
          type: 'thinking',
          title: '思考',
          detail: truncate(part.text, 4000),
          payload: { signature: part.signature }
        })
      } else if (part.type === 'qoder.session') {
        out.push({ ...base, id: `chat-${chatId}-${seq++}`, type: 'status', title: `Qoder 会话 ${part.sessionId}` })
      } else if (part.type === 'qoder.tool-use' || part.type === 'openai.tool-call') {
        out.push({
          ...base,
          id: `chat-${chatId}-${seq++}`,
          type: 'tool_call',
          title: `工具 ${part.name}`,
          detail: truncate(part.input, 2000),
          payload: { toolCallId: part.toolCallId }
        })
      } else if (part.type === 'qoder.tool-result' || part.type === 'openai.tool-result') {
        out.push({
          ...base,
          id: `chat-${chatId}-${seq++}`,
          type: 'tool_result',
          title: '工具结果',
          detail: truncate(part.output, 3000),
          payload: { toolCallId: part.toolCallId, isError: 'isError' in part ? part.isError : undefined }
        })
      }
    }
  }
  return out
}

/** 从无 parts 的 record 中尽力提取文本（与 api.ts demo 的 messageText 语义一致）。 */
function rawText(message: StoredMessage): string | undefined {
  const raw = message.raw
  if (raw && typeof raw === 'object') {
    const candidate = raw as { text?: string; kind?: string; content?: string }
    if (typeof candidate.text === 'string') return truncate(candidate.text, 4000)
    if (typeof candidate.content === 'string') return truncate(candidate.content, 4000)
  }
  return undefined
}

function truncate(value: unknown, max: number): string {
  if (value === undefined || value === null) return ''
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max}]` : s
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
