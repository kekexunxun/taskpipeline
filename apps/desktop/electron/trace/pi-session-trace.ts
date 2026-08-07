/**
 * Pi 官方 session（`pi-sessions/*.jsonl`，JSONL v3）→ TraceEntry 解析。
 *
 * 这是"历史兜底"数据源：即便未安装 pi-trace-extension，仍能展示 Pi 会话的
 * 完整对话流（用户消息 / AI 回复 / 工具结果 / 压缩 / 模型切换等）。
 * 执行视角（step 级延迟 / tokens / cost）由 `pi-trace-events.ts` 提供。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseSessionEntries, type FileEntry } from '@earendil-works/pi-coding-agent'
import type { TraceEntry } from '@coding-agent/core'

/** 从 session 文件路径推导 sessionId（文件名去 `.jsonl` 后缀）。 */
export function sessionIdFromFile(filePath: string): string {
  return basename(filePath).replace(/\.jsonl$/i, '')
}

/** 列出 dataDir/pi-sessions 下所有 session 文件 + tasks 表引用的文件（去重）。 */
export function listPiSessionFiles(dataDir: string, referenced: string[]): string[] {
  const files = new Set<string>()
  for (const file of referenced) {
    if (file) files.add(file)
  }
  const dir = join(dataDir, 'pi-sessions')
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.jsonl')) files.add(join(dir, name))
    }
  } catch {
    /* 目录不存在时忽略 */
  }
  return [...files]
}

/** 从 AgentMessage 提取可见文本（content 可能为 string 或 part 数组，防御式处理）。 */
function agentMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .filter((part): part is { text: string } =>
        Boolean(part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string')
      )
      .map((part) => (part as { text: string }).text)
    if (parts.length) return parts.join('\n')
  }
  return undefined
}

/** 解析一个官方 session JSONL 文件 → TraceEntry[]（解析失败返回空数组）。 */
export function parsePiSessionFile(filePath: string): TraceEntry[] {
  const sessionId = sessionIdFromFile(filePath)
  let rawContent = ''
  try {
    rawContent = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  let entries: FileEntry[] = []
  try {
    entries = parseSessionEntries(rawContent)
  } catch {
    return []
  }

  const out: TraceEntry[] = []
  let seq = 0
  for (const raw of entries) {
    const base = raw as { type: string; timestamp?: string }
    const createdAt = base.timestamp ?? new Date().toISOString()

    if (base.type === 'session') {
      const header = raw as { cwd?: string; id?: string }
      out.push({
        id: `pi-${sessionId}-${seq++}`,
        traceId: sessionId,
        kind: 'pi_session',
        type: 'session_start',
        title: 'Pi 会话开始',
        detail: header.cwd ? `cwd: ${header.cwd}` : undefined,
        payload: raw,
        createdAt,
        source: 'pi'
      })
      continue
    }

    if (base.type === 'message') {
      const message = (raw as { message?: unknown }).message
      const role = (message as { role?: string } | undefined)?.role
      const text = agentMessageText(message)
      if (role === 'toolResult' || role === 'tool') {
        out.push({
          id: `pi-${sessionId}-${seq++}`,
          traceId: sessionId,
          kind: 'pi_session',
          type: 'tool_result',
          title: '工具结果',
          detail: text,
          payload: message,
          createdAt,
          source: 'pi'
        })
      } else if (role === 'assistant') {
        out.push({
          id: `pi-${sessionId}-${seq++}`,
          traceId: sessionId,
          kind: 'pi_session',
          type: 'message',
          title: 'AI',
          detail: text,
          payload: message,
          createdAt,
          source: 'pi'
        })
      } else {
        out.push({
          id: `pi-${sessionId}-${seq++}`,
          traceId: sessionId,
          kind: 'pi_session',
          type: 'message',
          title: role === 'user' ? '用户' : '消息',
          detail: text,
          payload: message,
          createdAt,
          source: 'pi'
        })
      }
      continue
    }

    if (base.type === 'compaction') {
      const summary = (raw as { summary?: string }).summary
      out.push({
        id: `pi-${sessionId}-${seq++}`,
        traceId: sessionId,
        kind: 'pi_session',
        type: 'status',
        title: '上下文压缩',
        detail: summary,
        payload: raw,
        createdAt,
        source: 'pi'
      })
      continue
    }

    if (base.type === 'model_change') {
      const model = raw as { provider?: string; modelId?: string }
      out.push({
        id: `pi-${sessionId}-${seq++}`,
        traceId: sessionId,
        kind: 'pi_session',
        type: 'status',
        title: '切换模型',
        detail: [model.provider, model.modelId].filter(Boolean).join(' / '),
        payload: raw,
        createdAt,
        source: 'pi'
      })
      continue
    }

    // custom / branch_summary / label / session_info / thinking_level_change 等：统一 status 兜底。
    out.push({
      id: `pi-${sessionId}-${seq++}`,
      traceId: sessionId,
      kind: 'pi_session',
      type: 'status',
      title: String(base.type),
      payload: raw,
      createdAt,
      source: 'pi'
    })
  }
  return out
}
