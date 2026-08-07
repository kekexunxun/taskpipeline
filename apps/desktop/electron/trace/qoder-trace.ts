/**
 * Qoder 执行 trace —— 采集与解析。
 *
 * Qoder 任务的完整消息流（thinking / tool_use / tool_result / text / result 汇总）已经通过
 * `emitPi({ type: 'qoder_event', taskId, message })` 全量转发；这里把每条 SDKMessage 追加
 * 落盘为 `dataDir/traces/qoder/<taskId>.jsonl`，供 Trace 页面解析展示 step 级执行过程
 * （pi-trace-extension 只观测 Pi 会话，Qoder 任务需要这一路自建采集）。
 *
 * 文件格式：JSONL，每行 `{ t: ISO, taskId, message }`，message 为 Qoder SDKMessage 原样。
 * 解析端负责把流式 text/thinking 碎片聚合为完整条目。
 */

import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { TraceEntry } from '@coding-agent/core'

export function qoderTraceDir(dataDir: string): string {
  return join(dataDir, 'traces', 'qoder')
}

export function qoderTraceFile(dataDir: string, taskId: string): string {
  return join(qoderTraceDir(dataDir), `${taskId}.jsonl`)
}

/** 落盘 Sink：追加写一行。失败静默（trace 可用性低于主流程）。 */
export class QoderTraceSink {
  constructor(private readonly dataDir: string) {}

  append(taskId: string, message: unknown): void {
    try {
      const file = qoderTraceFile(this.dataDir, taskId)
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), taskId, message })}\n`, 'utf8')
    } catch {
      /* 忽略：trace 写失败不能影响主流程 */
    }
  }
}

/** 列出已有 qoder trace 的任务 id。 */
export function listQoderTraceTasks(dataDir: string): string[] {
  try {
    return readdirSync(qoderTraceDir(dataDir))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.replace(/\.jsonl$/, ''))
  } catch {
    return []
  }
}

// === 解析 ====================================================================

type SdkContentBlock = {
  type?: string
  text?: string
  thinking?: string
  signature?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

type RawSdkMessage = {
  type?: string
  session_id?: string
  subtype?: string
  event?: {
    type?: string
    delta?: { type?: string; text?: string; thinking?: string; signature?: string }
    content_block?: SdkContentBlock
    error?: { message?: string } | string
  }
  message?: { content?: SdkContentBlock[]; usage?: unknown }
  result?:
    | string
    | {
        duration_ms?: number
        num_turns?: number
        total_cost_usd?: number
        usage?: Record<string, unknown>
        modelUsage?: Record<string, unknown>
        errors?: unknown
      }
  error?: string
}

function truncate(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max}]` : s
}

/** 单条 SDKMessage → 0..n 条 TraceEntry（流式碎片由 mergeFragments 合并）。 */
function messageToEntries(taskId: string, createdAt: string, message: RawSdkMessage, startSeq: number): TraceEntry[] {
  const out: TraceEntry[] = []
  const seq = () => `qoder-${taskId}-${startSeq + out.length}`
  const base = { traceId: taskId, kind: 'task' as const, createdAt, source: 'qoder' as const }

  if (message.type === 'stream_event') {
    const event = message.event
    const block = event?.content_block
    const delta = event?.delta
    if (event?.type === 'content_block_start' || event?.type === 'content_block_delta') {
      if (delta?.type === 'text_delta' && delta.text) {
        out.push({ ...base, id: seq(), type: 'message', title: 'AI', detail: delta.text, payload: { stream: true } })
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        out.push({
          ...base,
          id: seq(),
          type: 'thinking',
          title: '思考',
          detail: delta.thinking,
          payload: { stream: true }
        })
      } else if (block?.type === 'text' && block.text) {
        out.push({ ...base, id: seq(), type: 'message', title: 'AI', detail: block.text })
      } else if (block?.type === 'thinking' && block.thinking) {
        out.push({
          ...base,
          id: seq(),
          type: 'thinking',
          title: '思考',
          detail: block.thinking,
          payload: block.signature ? { signature: block.signature } : undefined
        })
      } else if (block?.type === 'tool_use' && block.name) {
        out.push({
          ...base,
          id: seq(),
          type: 'tool_call',
          title: `工具 ${block.name}`,
          detail: truncate(block.input, 2000),
          payload: { toolCallId: block.id, toolName: block.name, input: block.input }
        })
      } else if (block?.type === 'tool_result') {
        out.push({
          ...base,
          id: seq(),
          type: 'tool_result',
          title: '工具结果',
          detail: truncate(block.content, 3000),
          payload: { toolCallId: block.tool_use_id, isError: block.is_error === true }
        })
      }
    }
    return out
  }

  if (message.type === 'assistant') {
    const content = message.message?.content
    const usage = message.message?.usage
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          out.push({
            ...base,
            id: seq(),
            type: 'message',
            title: 'AI',
            detail: block.text,
            payload: usage ? { usage } : undefined
          })
        } else if ((block.type === 'thinking' || block.type === 'redacted_thinking') && block.thinking) {
          out.push({
            ...base,
            id: seq(),
            type: 'thinking',
            title: '思考',
            detail: block.thinking,
            payload: block.signature ? { signature: block.signature } : undefined
          })
        } else if (block.type === 'tool_use' && block.name) {
          out.push({
            ...base,
            id: seq(),
            type: 'tool_call',
            title: `工具 ${block.name}`,
            detail: truncate(block.input, 2000),
            payload: { toolCallId: block.id, toolName: block.name, input: block.input }
          })
        } else if (block.type === 'tool_result') {
          out.push({
            ...base,
            id: seq(),
            type: 'tool_result',
            title: '工具结果',
            detail: truncate(block.content, 3000),
            payload: { toolCallId: block.tool_use_id, isError: block.is_error === true }
          })
        }
      }
    }
    if (out.length === 0 && typeof message.error === 'string') {
      out.push({ ...base, id: seq(), type: 'error', title: '执行错误', detail: truncate(message.error, 2000) })
    }
    return out
  }

  if (message.type === 'result') {
    const result = typeof message.result === 'string' ? undefined : message.result
    const usage = result?.usage as
      | {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      | undefined
    const models = Object.values(result?.modelUsage ?? {}) as Array<
      { inputTokens?: number; outputTokens?: number; costUSD?: number } | undefined
    >
    const sum = (key: 'inputTokens' | 'outputTokens' | 'costUSD') =>
      models.reduce((acc, m) => acc + ((m?.[key] as number) ?? 0), 0)
    const input = sum('inputTokens') > 0 ? sum('inputTokens') : (usage?.input_tokens ?? 0)
    const output = sum('outputTokens') > 0 ? sum('outputTokens') : (usage?.output_tokens ?? 0)
    const cost = sum('costUSD') > 0 ? sum('costUSD') : (result?.total_cost_usd ?? 0)
    const payload: Record<string, unknown> = { ...result, usage }
    if (input > 0 || output > 0) payload.tokens = { input, output }
    if (cost > 0) payload.costUsd = cost
    if (typeof result?.num_turns === 'number') payload.turns = result.num_turns
    if (typeof result?.duration_ms === 'number') payload.durationMs = result.duration_ms
    const modelsUsed = Object.keys(result?.modelUsage ?? {}).join(', ')
    out.push({
      ...base,
      id: seq(),
      type: 'status',
      title: 'Qoder 会话结束',
      detail:
        [
          modelsUsed && `模型: ${modelsUsed}`,
          input + output > 0 && `tokens: in ${input} / out ${output}`,
          cost > 0 && `$${cost.toFixed(4)}`,
          typeof result?.duration_ms === 'number' && `${result.duration_ms} ms`,
          typeof result?.num_turns === 'number' && `${result.num_turns} 轮`
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      payload
    })
    return out
  }

  if (message.type === 'system') {
    out.push({
      ...base,
      id: seq(),
      type: 'status',
      title: `Qoder ${message.subtype ?? '状态'}`,
      detail: truncate(message.error ?? undefined, 2000)
    })
    return out
  }

  if (message.type === 'user') {
    const text = truncate((message.message as { content?: unknown } | undefined)?.content, 4000)
    out.push({ ...base, id: seq(), type: 'message', title: '用户', detail: text })
    return out
  }

  // 未知类型：跳过
  return out
}

/** 相邻同类碎片合并（流式 text/thinking delta 逐块产生，合并为完整文本）。 */
function mergeFragments(entries: TraceEntry[]): TraceEntry[] {
  const out: TraceEntry[] = []
  for (const entry of entries) {
    const last = out.at(-1)
    if (
      last &&
      last.type === entry.type &&
      last.title === entry.title &&
      (entry.type === 'message' || entry.type === 'thinking')
    ) {
      const a = last.detail ?? ''
      const b = entry.detail ?? ''
      out[out.length - 1] = { ...last, detail: a.length >= b.length && a.endsWith(b) ? a : `${a}${b}` }
    } else {
      out.push(entry)
    }
  }
  return out
}

/** 解析某任务的 qoder trace JSONL → TraceEntry[]（按写入顺序，碎片已合并）。 */
export async function parseQoderTraceFile(dataDir: string, taskId: string): Promise<TraceEntry[]> {
  const file = qoderTraceFile(dataDir, taskId)
  if (!existsSync(file)) return []
  const out: TraceEntry[] = []
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return []
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let record: { t?: string; message?: RawSdkMessage }
    try {
      record = JSON.parse(line) as typeof record
    } catch {
      continue
    }
    if (!record.message) continue
    out.push(...messageToEntries(taskId, record.t ?? new Date().toISOString(), record.message, out.length))
  }
  return mergeFragments(out)
}
