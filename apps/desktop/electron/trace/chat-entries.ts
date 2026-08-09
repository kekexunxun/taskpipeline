/**
 * chatEntries — 对话消息（StoredMessage，含 parts）→ TraceEntry[]。
 *
 * 从 trace-service.ts 抽取成独立纯模块（不依赖 store / better-sqlite3，方便单测），
 * 并补全子任务结构，让对话类 trace 也能走与任务 trace 一致的子任务折叠：
 * - `qoder.subtask-start/progress/end` → task_started / task_progress / task_notification entry；
 * - text / thinking / tool-use / tool-result part 传播 `parentTaskId`；
 * - tool-use payload 增加 toolName / input，tool-result payload 增加 output（供 ToolCallRow 展示）。
 */

import type { TraceEntry } from '@coding-agent/core'
import type { StoredMessage } from '../chat/chat-types.js'

/** 对话消息（StoredMessage，含 parts）→ TraceEntry[]。 */
export function chatEntries(chatId: string, messages: StoredMessage[]): TraceEntry[] {
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
      // 子任务归属:text / thinking / tool part 都可能有 parentTaskId,传播到 entry 让
      // TraceDetail 的 interleaveTimeline 能把它们收进对应子任务折叠卡。
      const parentTaskId =
        'parentTaskId' in part && typeof part.parentTaskId === 'string' ? part.parentTaskId : undefined
      if (part.type === 'text') {
        out.push({
          ...base,
          id: `chat-${chatId}-${seq++}`,
          type: 'message',
          title: roleTitle,
          detail: part.text,
          parentTaskId
        })
      } else if (part.type === 'qoder.thinking') {
        out.push({
          ...base,
          id: `chat-${chatId}-${seq++}`,
          type: 'thinking',
          title: '思考',
          detail: truncate(part.text, 4000),
          payload: { signature: part.signature },
          parentTaskId
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
          payload: { toolCallId: part.toolCallId, toolName: part.name, input: part.input },
          parentTaskId
        })
      } else if (part.type === 'qoder.tool-result' || part.type === 'openai.tool-result') {
        out.push({
          ...base,
          id: `chat-${chatId}-${seq++}`,
          type: 'tool_result',
          title: '工具结果',
          detail: truncate(part.output, 3000),
          payload: {
            toolCallId: part.toolCallId,
            output: part.output,
            isError: 'isError' in part ? part.isError : undefined
          },
          parentTaskId
        })
      } else if (part.type === 'qoder.subtask-start') {
        // 子任务起点 → 折叠卡 header。parentTaskId 自指(taskId === parent),
        // interleaveTimeline 据此把它识别为 group header;toolUseId 指向主流程发起调用。
        out.push({
          ...base,
          id: `chat-${chatId}-${seq++}`,
          type: 'status',
          title: '子任务启动',
          taskId: part.taskId,
          parentTaskId: part.parentTaskId,
          sdkSubtype: 'task_started',
          payload: {
            taskId: part.taskId,
            taskType: part.taskType,
            subagentType: part.subagentType,
            toolUseId: part.toolUseId,
            description: part.description
          }
        })
      } else if (part.type === 'qoder.subtask-progress') {
        out.push({
          ...base,
          id: `chat-${chatId}-${seq++}`,
          type: 'status',
          title: '子任务进度',
          taskId: part.taskId,
          parentTaskId: part.parentTaskId,
          sdkSubtype: 'task_progress',
          payload: {
            taskId: part.taskId,
            lastToolName: part.lastToolName,
            description: part.description,
            usage: part.usage
          }
        })
      } else if (part.type === 'qoder.subtask-end') {
        out.push({
          ...base,
          id: `chat-${chatId}-${seq++}`,
          type: 'status',
          title: '子任务收尾',
          taskId: part.taskId,
          parentTaskId: part.parentTaskId,
          sdkSubtype: 'task_notification',
          payload: { taskId: part.taskId, status: part.status, summary: part.summary, usage: part.usage }
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
