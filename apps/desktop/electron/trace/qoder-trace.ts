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
  /** 子任务相关字段（仅 task_started / task_progress / task_notification 携带）。 */
  task_id?: string
  tool_use_id?: string
  description?: string
  task_type?: string
  subagent_type?: string
  workflow_name?: string
  prompt?: string
  last_tool_name?: string
  status?: string
  output_file?: string
  summary?: string
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
  /** Qoder SDK 在每条消息上携带该字段，标识该消息属于哪个父级 tool_use —— 顶层为 null/缺失。 */
  parent_tool_use_id?: string | null
  event?: {
    type?: string
    delta?: { type?: string; text?: string; thinking?: string; signature?: string }
    content_block?: SdkContentBlock
    error?: { message?: string } | string
  }
  message?: { content?: SdkContentBlock[]; usage?: unknown; parent_tool_use_id?: string | null }
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

/**
 * 单条 SDKMessage 解析上下文。
 *
 * - `taskIdByToolUseId`: 运行期维护的 `tool_use_id -> task_id` 映射;
 *   遇到 `task_started` 时写入(其 `tool_use_id` 指向主流程那条 tool_use 的 id),
 *   遇到其它消息时用其 `parent_tool_use_id` 反查以决定是否落入子任务。
 * - 由于 Qoder SDK 保证子任务消息顺序(task_started 永远先到),流式单遍即可。
 */
type ParseContext = {
  taskIdByToolUseId: Map<string, string>
}

/** 从一条原始消息里提取 parent_tool_use_id（SDK 把它放在 message 顶层或 message.message 顶层）。 */
function parentToolUseIdOf(message: RawSdkMessage): string | undefined {
  if (typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id) {
    return message.parent_tool_use_id
  }
  if (message.message && typeof message.message.parent_tool_use_id === 'string' && message.message.parent_tool_use_id) {
    return message.message.parent_tool_use_id
  }
  return undefined
}

/** 根据当前 context 决定 entry 归属哪个子任务 —— 不在子任务内则 undefined（主流程）。 */
function resolveParentTaskId(ctx: ParseContext, message: RawSdkMessage): string | undefined {
  const parent = parentToolUseIdOf(message)
  if (!parent) return undefined
  return ctx.taskIdByToolUseId.get(parent)
}

/** 单条 SDKMessage → 0..n 条 TraceEntry（流式碎片由 mergeFragments 合并）。 */
function messageToEntries(
  taskId: string,
  createdAt: string,
  message: RawSdkMessage,
  startSeq: number,
  ctx: ParseContext
): TraceEntry[] {
  const out: TraceEntry[] = []
  const seq = () => `qoder-${taskId}-${startSeq + out.length}`
  // parentTaskId 为 undefined 表示"主流程";有值表示"嵌套在该子任务内"。
  // 把它铺到 base 上,后续所有 push 自然携带,渲染层按字段一键分组。
  const resolvedParentTaskId = resolveParentTaskId(ctx, message)
  const base = {
    traceId: taskId,
    kind: 'task' as const,
    createdAt,
    source: 'qoder' as const,
    ...(resolvedParentTaskId ? { parentTaskId: resolvedParentTaskId } : {})
  }

  // 子任务入口:在写入任何子任务内消息前,先把 task_started 注册到 map,
  // 让该 task 内的所有后续消息(由 parent_tool_use_id 反查)能落在它里面。
  if (message.type === 'system' && message.subtype === 'task_started' && message.task_id && message.tool_use_id) {
    ctx.taskIdByToolUseId.set(message.tool_use_id, message.task_id)
  }

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
          detail: truncate(toolResultText(block.content), 3000),
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
            detail: truncate(toolResultText(block.content), 3000),
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
    // 子任务三类系统消息独立成支,渲染层据此做折叠卡片:
    //   - task_started: 子任务起点 → 携带 taskId / task_type / description / prompt,
    //     SDK 同步在 main 流程那条 tool_use 上挂上相同的 tool_use_id,后续子任务内的
    //     消息通过 parent_tool_use_id 反查落进该子任务。
    //   - task_progress: 过程态(SDK 会发多次) → 渲染时按用户选择聚合到 header,不强制展示。
    //   - task_notification: 收尾 → status + summary,负责关闭折叠卡。
    // 三个 entry 都自指 `parentTaskId = task_id`:这样 groupByParentTask 依据
    // `item.taskId === parent` 规则把 task_started 识别为 group header,task_progress
    // 与 task_notification 自动落入 children 数组;不再依赖 `parent_tool_use_id` 反查
    // (SDK 在 system 任务消息上不会重复携带该字段,会导致旧数据漏分)。
    // 其它 system subtype(init / hook_* / compact_boundary / status / 等)保持原样。
    if (message.subtype === 'task_started' && message.task_id) {
      out.push({
        ...base,
        id: seq(),
        type: 'status',
        title: '子任务启动',
        detail: truncate(message.description, 1000),
        taskId: message.task_id,
        parentTaskId: message.task_id,
        sdkSubtype: 'task_started',
        payload: {
          taskId: message.task_id,
          taskType: message.task_type,
          subagentType: message.subagent_type,
          toolUseId: message.tool_use_id,
          description: message.description,
          workflowName: message.workflow_name,
          promptPreview: truncate(message.prompt, 2000)
        }
      })
      return out
    }
    if (message.subtype === 'task_progress' && message.task_id) {
      out.push({
        ...base,
        id: seq(),
        type: 'status',
        title: '子任务进度',
        detail: truncate(message.description, 500),
        taskId: message.task_id,
        parentTaskId: message.task_id,
        sdkSubtype: 'task_progress',
        payload: {
          taskId: message.task_id,
          usage: message.usage,
          lastToolName: message.last_tool_name,
          description: message.description,
          summary: message.summary
        }
      })
      return out
    }
    if (message.subtype === 'task_notification' && message.task_id) {
      out.push({
        ...base,
        id: seq(),
        type: 'status',
        title: '子任务收尾',
        detail: truncate(message.summary, 1000),
        taskId: message.task_id,
        parentTaskId: message.task_id,
        sdkSubtype: 'task_notification',
        payload: {
          taskId: message.task_id,
          status: message.status,
          outputFile: message.output_file,
          summary: message.summary,
          usage: message.usage
        }
      })
      return out
    }
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
    // Qoder SDK 的 user 消息有三种形态:
    //  1. content 是 tool_result 数组 —— 工具执行后回传,每个块对应 assistant 的 tool_use;
    //  2. content 是字符串 —— 任务循环里人为补的 user 文本(例如 plan 重试引导);
    //  3. content 是 text 块数组 —— 较少见,和 assistant 的 text 块同构。
    // 原实现把所有情况都序列化成一个“用户”消息,工具结果彻底丢失,调试时
    // 无法看到工具真实返回。这里把 tool_result 块拆成独立的 tool_result 条目,
    // 字符串/text 块按普通用户消息处理,空数组兜底走原字符串化。
    const raw = (message.message as { content?: unknown } | undefined)?.content
    if (Array.isArray(raw)) {
      for (const block of raw as SdkContentBlock[]) {
        if (block.type === 'tool_result') {
          out.push({
            ...base,
            id: seq(),
            type: 'tool_result',
            title: '工具结果',
            detail: truncate(toolResultText(block.content), 3000),
            payload: { toolCallId: block.tool_use_id, isError: block.is_error === true }
          })
        } else if (block.type === 'text' && block.text) {
          out.push({ ...base, id: seq(), type: 'message', title: '用户', detail: block.text })
        }
      }
      if (out.length === 0) {
        out.push({ ...base, id: seq(), type: 'message', title: '用户', detail: truncate(JSON.stringify(raw), 4000) })
      }
      return out
    }
    out.push({ ...base, id: seq(), type: 'message', title: '用户', detail: truncate(raw, 4000) })
    return out
  }

  // 未知类型：跳过
  return out
}

/** 判定工具输入是否为「空占位」:stream_event content_block_start 的 input 恒为 {}。 */
function isEmptyToolInput(input: unknown): boolean {
  if (input === undefined || input === null) return true
  return (
    typeof input === 'object' && !Array.isArray(input) && Object.keys(input as Record<string, unknown>).length === 0
  )
}

/** tool_result 的 content 可能是字符串或 content 块数组;数组时提取 text 拼接,避免 trace 展示原始 JSON。 */
function toolResultText(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content
    .map((block) => {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') return text
      }
      return JSON.stringify(block)
    })
    .join('\n')
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

/**
 * 配对同一 toolCallId 的 tool_call / tool_result:结果合到调用的 detail 里,
 * 丢掉独立的 tool_result 条目,trace 时间线只出现“工具 call + 结果”一个事件。
 * Qoder SDK 顺序保证 tool_call 一定在 tool_result 之前(assistant -> user),
 * 所以流式追加在看到 tool_result 时一定能反查。孤儿 tool_result 保留为独立条目,
 * 避免丢数据。
 */
function pairToolCalls(entries: TraceEntry[]): TraceEntry[] {
  const callIndexByCallId = new Map<string, number>()
  const out: TraceEntry[] = []
  for (const entry of entries) {
    const payload = (entry.payload ?? {}) as Record<string, unknown>
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined
    if (entry.type === 'tool_call' && toolCallId) {
      const existingIdx = callIndexByCallId.get(toolCallId)
      if (existingIdx !== undefined) {
        // 同一 tool_use 会出现两次:stream_event 的 content_block_start 先到(input 恒为 {} 占位,
        // 真实 input 由 input_json_delta 流式累积,这里不逐 delta 重组),assistant 完整消息随后
        // 再发一次(input 完整)。合并为一条:完整输入覆盖占位,位置保持先入位,避免渲染层拿到 {}。
        const existing = out[existingIdx]!
        const existingPayload = (existing.payload ?? {}) as Record<string, unknown>
        const existingInputEmpty = isEmptyToolInput(existingPayload.input)
        out[existingIdx] = {
          ...existing,
          detail: existingInputEmpty ? (entry.detail ?? existing.detail) : (existing.detail ?? entry.detail),
          payload: {
            ...existingPayload,
            ...payload,
            input: existingInputEmpty ? payload.input : existingPayload.input
          }
        }
        continue
      }
      callIndexByCallId.set(toolCallId, out.length)
      out.push(entry)
      continue
    }
    if (entry.type === 'tool_result' && toolCallId) {
      const idx = callIndexByCallId.get(toolCallId)
      if (idx !== undefined) {
        const call = out[idx]!
        const isError = payload.isError === true
        const resultDetail = entry.detail ?? ''
        const separator = `\n\n--- 工具结果${isError ? ' (失败)' : ''} ---\n`
        const mergedDetail = call.detail
          ? `${call.detail}${separator}${resultDetail}`
          : `${separator.trimStart()}\n${resultDetail}`
        out[idx] = {
          ...call,
          detail: mergedDetail,
          payload: { ...((call.payload ?? {}) as Record<string, unknown>), result: resultDetail, isError }
        }
        continue
      }
      // 孤儿 tool_result:没找到对应 tool_call(例如流式采集丢包),保留为独立条目。
      out.push(entry)
      continue
    }
    out.push(entry)
  }
  return out
}

/** 解析某任务的 qoder trace JSONL → TraceEntry[]（按写入顺序，碎片已合并）。 */
export async function parseQoderTraceFile(dataDir: string, taskId: string): Promise<TraceEntry[]> {
  const file = qoderTraceFile(dataDir, taskId)
  if (!existsSync(file)) return []
  const out: TraceEntry[] = []
  // 运行期维护的 parent_tool_use_id → task_id 映射;
  // 遇到 task_started 时写入(其 tool_use_id 指向主流程那条 tool_use),后续消息
  // 的 parent_tool_use_id 反查以决定是否落入子任务。
  const ctx: ParseContext = { taskIdByToolUseId: new Map() }
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
    out.push(...messageToEntries(taskId, record.t ?? new Date().toISOString(), record.message, out.length, ctx))
  }
  // 顺序:先 pair 掉 tool_call / tool_result 的散乱分列,再 merge 流式 message/thinking 碎片。
  return mergeFragments(pairToolCalls(out))
}
