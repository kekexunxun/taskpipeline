/**
 * pi-trace-extension（`~/.pi/agent/traces/<session-id>/events.jsonl`）→ TraceEntry 解析。
 *
 * 这是"执行视角"的主数据源：events.jsonl 由社区扩展 pi-trace-extension 在运行期
 * 增量写入，记录了 step 级 LLM 调用、工具执行、延迟、tokens/cost、子代理嵌套等，
 * 信息粒度高于官方 session 文件。
 *
 * 兼容性约定（与插件自身 PR bar 一致）：事件类型只增不改，未知类型一律跳过，
 * 插件版本升级不影响解析器。
 */

import { closeSync, createReadStream, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { TraceEntry } from '@task-pipeline/core'

/** pi-trace-extension 的 traces 根目录（`<agentDir>/traces`）。 */
export function piTraceRoot(agentDir: string): string {
  return join(agentDir, 'traces')
}

/** 单个 pi-trace 会话的目录级信息（列表页用，不读完整文件）。 */
export type PiTraceSessionInfo = {
  sessionId: string
  eventsFile: string
  traceHtmlPath?: string
  mtimeMs: number
  sizeBytes: number
  /** 首行 `session_start.ts` 转 ISO，缺失时回退 mtime。 */
  startedAt?: string
  firstLine?: Record<string, unknown>
}

/** 扫描 traces 根目录下所有含 events.jsonl 的会话目录，按 mtime 倒序。 */
export function listPiTraceSessions(agentDir: string): PiTraceSessionInfo[] {
  const root = piTraceRoot(agentDir)
  let names: string[] = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return [] // 目录不存在 → 未启用 pi-trace-extension
  }
  const out: PiTraceSessionInfo[] = []
  for (const name of names) {
    const dir = join(root, name)
    const eventsFile = join(dir, 'events.jsonl')
    if (!existsSync(eventsFile)) continue
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(eventsFile)
    } catch {
      continue
    }
    const traceHtmlPath = existsSync(join(dir, 'trace.html')) ? join(dir, 'trace.html') : undefined
    const info: PiTraceSessionInfo = {
      sessionId: name,
      eventsFile,
      traceHtmlPath,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size
    }
    const firstLine = readFirstLine(eventsFile)
    if (firstLine) {
      try {
        const parsed = JSON.parse(firstLine) as Record<string, unknown>
        info.firstLine = parsed
        if (typeof parsed.ts === 'number') info.startedAt = new Date(parsed.ts).toISOString()
      } catch {
        /* 首行解析失败不影响扫描 */
      }
    }
    out.push(info)
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** pi-trace 会话的执行统计（列表页用，流式聚合 turn_summary，不整读大文件）。 */
export type PiTraceStats = {
  turns?: number
  tokens?: { input: number; output: number; total: number }
  costUsd?: number
  durationMs?: number
  model?: string
}

/**
 * 流式扫描 events.jsonl，聚合执行统计：
 * - turns：turn_summary 数量；
 * - tokens / costUsd：各 turn_summary 的 usage 累加；
 * - model：最后一条 turn_summary 的 model；
 * - durationMs：session_start → session_shutdown 的间隔。
 */
export async function summarizePiTrace(eventsFile: string): Promise<PiTraceStats> {
  const stats: PiTraceStats = {}
  let startTs: number | undefined
  let endTs: number | undefined
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(eventsFile, { encoding: 'utf8' })
  } catch {
    return stats
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.type === 'session_start' && typeof event.ts === 'number') startTs = event.ts
    else if (event.type === 'session_shutdown' && typeof event.ts === 'number') endTs = event.ts
    else if (event.type === 'turn_summary') {
      stats.turns = (stats.turns ?? 0) + 1
      if (typeof event.model === 'string') stats.model = event.model
      const usage = event.usage as { input?: number; output?: number; cost?: number } | undefined
      if (usage) {
        const input = typeof usage.input === 'number' ? usage.input : 0
        const output = typeof usage.output === 'number' ? usage.output : 0
        const tokens = stats.tokens ?? (stats.tokens = { input: 0, output: 0, total: 0 })
        tokens.input += input
        tokens.output += output
        tokens.total += input + output
        if (typeof usage.cost === 'number') stats.costUsd = (stats.costUsd ?? 0) + usage.cost
      }
    }
  }
  if (startTs !== undefined && endTs !== undefined) stats.durationMs = Math.max(0, endTs - startTs)
  return stats
}

/** 递归深度上限：子 agent 最多嵌套 5 层，防循环 / 异常目录结构。 */
const MAX_SUBAGENT_DEPTH = 5

/**
 * 解析上下文（主文件与递归子文件共享 seq 计数器）。
 *
 * 平铺策略（对齐「一条 Trace 按时间顺序展示」）：不再生成 turn / 子 agent 折叠组，
 * 所有条目（含递归子 agent 文件）保持执行顺序平铺为同一条时间线。
 */
type ParseContext = {
  sessionId: string
  /** 全局递增 seq（主文件 + 子文件共享，保证 entry id 唯一）。 */
  seqRef: { current: number }
  /** 主文件才做子 agent 挂载；子文件不再递归。 */
  isRoot: boolean
  /** 主 events.jsonl 所在目录（解析子 agent 相对路径用）。 */
  rootDir: string
  /** 递归深度。 */
  depth: number
}

/** 逐行解析 events.jsonl → TraceEntry[]（流式，可处理大文件）。 */
export async function parsePiTraceEvents(filePath: string): Promise<TraceEntry[]> {
  const sessionId = basenameWithoutExt(filePath)
  const out: TraceEntry[] = []
  const ctx: ParseContext = {
    sessionId,
    seqRef: { current: 0 },
    isRoot: true,
    rootDir: dirnameOf(filePath),
    depth: 0
  }
  await parseEventsWithContext(filePath, ctx, out)
  return out
}

/** 递归解析单文件（主文件 / 子 agent 文件共用）。 */
async function parseEventsWithContext(filePath: string, ctx: ParseContext, out: TraceEntry[]): Promise<void> {
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(filePath, { encoding: 'utf8' })
  } catch {
    return
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // 未知/损坏行跳过，不中断整体解析
    }
    const seq = ctx.seqRef.current
    ctx.seqRef.current += 1
    for (const entry of mapEvent(event, ctx, seq)) {
      out.push(entry)
    }
    // 子 agent 挂载：tool_end 携带 subagent 时递归解析子文件（平铺，无折叠组）。
    if (ctx.isRoot && event.type === 'tool_end' && event.subagent && ctx.depth < MAX_SUBAGENT_DEPTH) {
      await attachSubagent(event, ctx, out)
    }
  }
}

/** 递归解析子 agent 文件并平铺：开始标记 → 子文件事件 → 结束标记（无折叠组）。 */
async function attachSubagent(event: Record<string, unknown>, ctx: ParseContext, out: TraceEntry[]): Promise<void> {
  const subagent = event.subagent as
    | { id?: string; childTraces?: Array<{ id?: string; dir?: string; startTs?: number }> }
    | undefined
  if (!subagent || !Array.isArray(subagent.childTraces) || subagent.childTraces.length === 0) return
  const headerTs = timestampOf(event)
  for (const child of subagent.childTraces) {
    if (!child.id) continue
    // 开始标记：锚定在 spawner 工具（tool_end）之后，作为普通 status 条目平铺。
    out.push({
      id: `pt-${ctx.sessionId}-${ctx.seqRef.current++}`,
      traceId: ctx.sessionId,
      kind: 'pi_session',
      type: 'status',
      title: `Pi Agent ${child.id.slice(0, 8)} 开始`,
      createdAt: headerTs,
      source: 'pi_trace',
      payload: {
        subagentId: child.id,
        toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
        toolName: event.toolName
      }
    })
    // 递归子 agent 执行文件（dir 可能是绝对路径，也可能是相对 traces 根的路径）。
    if (child.dir) {
      const childFile = join(isAbsolutePath(child.dir) ? child.dir : join(ctx.rootDir, child.dir), 'events.jsonl')
      await parseEventsWithContext(childFile, { ...ctx, isRoot: false, depth: ctx.depth + 1 }, out)
    }
    // 结束标记：普通 status 条目。
    out.push({
      id: `pt-${ctx.sessionId}-${ctx.seqRef.current++}`,
      traceId: ctx.sessionId,
      kind: 'pi_session',
      type: 'status',
      title: `Pi Agent ${child.id.slice(0, 8)} 结束`,
      createdAt: headerTs,
      source: 'pi_trace',
      payload: { subagentId: child.id }
    })
  }
}

function dirnameOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  return idx >= 0 ? filePath.slice(0, idx) : '.'
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
}

// === 事件映射 =================================================================

function basenameWithoutExt(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  return name.replace(/\.jsonl$/i, '')
}

function timestampOf(event: Record<string, unknown>): string {
  return typeof event.ts === 'number' ? new Date(event.ts).toISOString() : new Date().toISOString()
}

function truncate(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max}]` : s
}

function asNum(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function mapEvent(event: Record<string, unknown>, ctx: ParseContext, seq: number): TraceEntry[] {
  const type = String(event.type ?? 'unknown')
  const turn = event.turnIndex
  const step = event.stepIndex
  const tag = [step !== undefined ? `step ${step}` : undefined, turn !== undefined ? `turn ${turn}` : undefined]
    .filter(Boolean)
    .join(' · ')
  const id = `pt-${ctx.sessionId}-${seq}`
  // 全部条目平铺为同一条时间线（不做 turn / 子 agent 分组折叠）。
  const base: TraceEntry = {
    id,
    traceId: ctx.sessionId,
    kind: 'pi_session',
    type: 'status',
    title: '',
    createdAt: timestampOf(event),
    source: 'pi_trace',
    payload: event
  }
  const make = (patch: Partial<TraceEntry>): TraceEntry => ({ ...base, ...patch, id })

  switch (type) {
    case 'session_start':
      return [make({ type: 'session_start', title: '执行会话开始' })]
    case 'session_shutdown':
      return [
        make({
          type: 'session_end',
          title: '执行会话结束',
          detail: event.reason ? `原因: ${String(event.reason)}` : undefined
        })
      ]
    case 'interaction_start':
      return [
        make({
          type: 'message',
          title: '用户输入',
          detail: truncate(event.prompt, 4000),
          payload: {
            slashCommand: event.slashCommand,
            skillsLoaded: event.skillsLoaded,
            imagesCount: event.imagesCount
          }
        })
      ]
    case 'turn_start':
      return [make({ type: 'status', title: `轮次 ${turn ?? '?'} 开始` })]
    case 'turn_end': {
      const duration = asNum(event.durationMs)
      return [
        make({
          type: 'status',
          title: `轮次 ${turn ?? '?'} 结束`,
          detail: duration !== undefined ? `${duration} ms` : undefined
        })
      ]
    }
    case 'turn_summary':
      return [turnSummary(make, event, turn)]
    case 'step_start':
      return [make({ type: 'thinking', title: `LLM 调用${tag ? `（${tag}）` : ''}` })]
    case 'llm_request': {
      const input = event.input as { model?: string; tools?: Array<{ name?: string }> } | undefined
      const lines: string[] = []
      if (input?.model) lines.push(`model: ${input.model}`)
      if (Array.isArray(input?.tools))
        lines.push(
          `tools: ${input.tools
            .map((t) => t.name)
            .filter(Boolean)
            .join(', ')}`
        )
      return [
        make({
          type: 'thinking',
          title: `LLM 请求${tag ? `（${tag}）` : ''}`,
          detail: lines.join('\n') || undefined,
          payload: { model: input?.model }
        })
      ]
    }
    case 'llm_response': {
      const parts: string[] = []
      if (typeof event.status === 'number') parts.push(`status: ${event.status}`)
      const duration = asNum(event.durationMs)
      if (duration !== undefined) parts.push(`${duration} ms`)
      if (event.isError === true) parts.push('失败')
      return [
        make({ type: 'status', title: `LLM 响应${tag ? `（${tag}）` : ''}`, detail: parts.join(' · ') || undefined })
      ]
    }
    case 'step_end': {
      const out: TraceEntry[] = []
      const thinking = truncate(event.thinking, 2000)
      if (thinking) {
        out.push(
          make({
            id: `${id}-t`,
            type: 'thinking',
            title: `思考${tag ? `（${tag}）` : ''}`,
            detail: thinking,
            payload: { thinkingRedacted: event.thinkingRedacted }
          })
        )
      }
      const text = truncate(event.text, 4000)
      if (text) {
        out.push(
          make({
            id: `${id}-m`,
            type: 'message',
            title: 'AI',
            detail: text,
            payload: { usage: event.usage, stopReason: event.stopReason, model: event.model }
          })
        )
      }
      if (event.errorMessage) {
        out.push(
          make({
            id: `${id}-e`,
            type: 'error',
            title: '执行错误',
            detail: truncate(event.errorMessage, 2000)
          })
        )
      }
      if (out.length === 0) out.push(make({ type: 'status', title: `步骤完成${tag ? `（${tag}）` : ''}` }))
      return out
    }
    case 'tool_start':
      return [
        make({
          type: 'tool_call',
          title: `工具 ${String(event.toolName ?? '?')}`,
          detail: truncate(event.args, 2000),
          payload: { toolCallId: event.toolCallId, toolName: event.toolName, durationMs: asNum(event.durationMs) }
        })
      ]
    case 'tool_end':
      return [
        make({
          type: 'tool_result',
          title: `工具结果 ${String(event.toolName ?? '?')}`,
          detail: truncate(event.resultPreview, 3000),
          payload: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            durationMs: asNum(event.durationMs),
            isError: event.isError === true,
            subagent: event.subagent,
            resultTotalLength: event.resultTotalLength
          }
        })
      ]
    case 'file_change':
      return [
        make({
          type: 'diff',
          title: `${String(event.op ?? 'edit')} ${String(event.path ?? '')}`,
          detail: truncate(event.path, 500)
        })
      ]
    default:
      return [] // 未知事件类型：优雅跳过（兼容插件版本升级）
  }
}

function turnSummary(
  make: (patch: Partial<TraceEntry>) => TraceEntry,
  event: Record<string, unknown>,
  turn: unknown
): TraceEntry {
  const lines: string[] = []
  const files = Array.isArray(event.filesChanged)
    ? (event.filesChanged as Array<{ path?: string; op?: string; count?: number }>)
    : []
  if (files.length) {
    lines.push(
      `文件变更 ${files.length} 个: ${files
        .slice(0, 5)
        .map((f) => `${f.op} ${f.path}`)
        .join(', ')}${files.length > 5 ? '…' : ''}`
    )
  }
  const tools = Array.isArray(event.toolsUsed)
    ? (event.toolsUsed as Array<{ name?: string; count?: number; errors?: number }>)
    : []
  if (tools.length) {
    lines.push(
      `工具: ${tools.map((t) => `${t.name}×${t.count ?? 1}${t.errors ? `（错${t.errors}）` : ''}`).join(', ')}`
    )
  }
  const usage = event.usage as { input?: number; output?: number; cost?: number } | undefined
  if (usage) {
    lines.push(
      `tokens: in ${usage.input ?? 0} / out ${usage.output ?? 0}${typeof usage.cost === 'number' ? ` · $${usage.cost.toFixed(4)}` : ''}`
    )
  }
  const final = truncate(event.finalText, 1000)
  if (final) lines.push(`最终: ${final}`)
  return make({
    type: 'status',
    title: `轮次 ${turn ?? '?'} 汇总`,
    detail: lines.join('\n') || undefined
  })
}

function readFirstLine(filePath: string): string | undefined {
  try {
    const buffer = new Uint8Array(8192)
    const handle = openSync(filePath, 'r')
    try {
      const bytes = readSync(handle, buffer, 0, buffer.length, 0)
      if (bytes <= 0) return undefined
      const slice = new TextDecoder().decode(buffer.subarray(0, bytes))
      const newline = slice.indexOf('\n')
      return newline >= 0 ? slice.slice(0, newline) : slice
    } finally {
      closeSync(handle)
    }
  } catch {
    return undefined
  }
}
