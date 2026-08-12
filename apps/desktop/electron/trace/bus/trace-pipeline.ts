/**
 * Trace 管线 —— 埋点层与 Bus/Processor 的枢纽（参考 Mastra 的 trace 处理器）。
 *
 * 职责：
 * 1. Trace 生命周期：beginTrace（一次用户提问 / 一次任务执行）→ span 流 → endTrace（finalize 摘要）；
 * 2. 执行树关联：span 栈自动挂父（parentSpanId = 当前栈顶），适配器可显式覆盖；
 * 3. 数据脱敏：所有 span 的 input/output/meta/error 在落盘前统一 redactSpan；
 * 4. 指标预计算：durationMs / usage.costUsd（provider 值优先，单价表兜底）；
 * 5. 持久化：TraceStorage.appendSpan / finalize；
 * 6. live 推送：每条 span 写入后 emitLive（前端瀑布图/列表实时更新）。
 */

import type { AgentSpan, SpanOp, SpanSource, SpanType, TraceKind, TraceSummary } from '@task-pipeline/core'
import { finalizeSpanDuration, redactSpan, applySpanCost, summarizeTrace } from '@task-pipeline/core'

export type TraceContext = {
  traceId: string
  kind: TraceKind
  title: string
  agentName?: string
  model?: string
  source: SpanSource
}

export type SpanInit = {
  type: SpanType
  name: string
  /** 显式父 span；缺省挂当前栈顶（undefined = 根）。 */
  parentSpanId?: string
  input?: unknown
  model?: string
  meta?: Record<string, unknown>
}

export type SpanEndPatch = {
  output?: unknown
  usage?: AgentSpan['usage']
  status?: 'completed' | 'error' | 'cancelled'
  error?: { message: string; stack?: string }
  meta?: Record<string, unknown>
  /**
   * 覆盖 endedAt（默认 Date.now()）：SDK 消息流中断后兜底收尾悬挂 span 时，
   * 用最后一条消息到达时间收尾，避免「悬到 finish() 才关」产生的假时长。
   */
  endedAt?: number
}

type ActiveTrace = {
  ctx: TraceContext
  seq: number
  stack: Array<{ spanId: string; type: SpanType }>
  spans: AgentSpan[]
  /** 重开（恢复/重启）时从存储读到的历史根 span（task.run/session.start），ensureRootSpan 复用。 */
  historicalRoots: AgentSpan[]
}

/** 实时事件负载（sendTaskEvent 通道）。 */
export type TraceLiveEvent = {
  type: 'trace_span'
  traceId: string
  op: SpanOp
  span: AgentSpan
}

export class TracePipeline {
  private readonly active = new Map<string, ActiveTrace>()

  constructor(
    private readonly storage: {
      appendSpan(traceId: string, op: SpanOp, span: AgentSpan): void
      finalize(traceId: string, summary: TraceSummary): void
      /** 同步读全量 span 快照（重开/收尾聚合完整历史用；测试替身可省略）。 */
      loadSpans?(traceId: string): AgentSpan[] | undefined
      /** 读已 finalize 的摘要（重开时刷新 running 用；测试替身可省略）。 */
      readSummary?(traceId: string): TraceSummary | undefined
    },
    private readonly emitLive?: (event: TraceLiveEvent) => void
  ) {}

  /**
   * 开启一次 trace（幂等：同 traceId 重复 begin 仅更新 ctx）。
   *
   * 重开（任务恢复/续接、应用重启后继续）：存储中已有该 traceId 的历史时——
   * 1. seq 水位同步到历史最大 sequence，避免新 span 的 spanId（evt-<traceId>-<seq>）撞号覆盖历史快照；
   * 2. 历史根 span 记入 historicalRoots，供 ensureRootSpan 复用（不重复建根）；
   * 3. 已有 info 摘要的状态刷新为 running（恢复执行期间列表页显示"进行中"，指标保留历史累计）。
   */
  beginTrace(ctx: TraceContext): void {
    const existing = this.active.get(ctx.traceId)
    if (existing) {
      existing.ctx = { ...existing.ctx, ...ctx }
      return
    }
    const at: ActiveTrace = { ctx, seq: 0, stack: [], spans: [], historicalRoots: [] }
    this.active.set(ctx.traceId, at)
    const history = this.storage.loadSpans?.(ctx.traceId)
    if (history?.length) {
      for (const span of history) {
        if (span.sequence > at.seq) at.seq = span.sequence
        if (span.type === 'task.run' || span.type === 'session.start') at.historicalRoots.push(span)
      }
    }
    const priorSummary = this.storage.readSummary?.(ctx.traceId)
    if (priorSummary && priorSummary.status !== 'running') {
      this.storage.finalize(ctx.traceId, { ...priorSummary, status: 'running', updatedAt: new Date().toISOString() })
    }
  }

  /**
   * 确保根 span 存在（恢复安全）：存储中已有同类根（task.run/session.start）时不重复创建，
   * 改为把历史根挂回栈底——恢复后的新 span 仍挂在原根下，执行树跨回合不断裂。
   * 无历史时等同 startSpan（首次执行）。返回根 span。
   */
  ensureRootSpan(traceId: string, init: SpanInit): AgentSpan {
    const at = this.requireTrace(traceId)
    const historical = at.historicalRoots.find((span) => span.type === init.type)
    if (historical) {
      if (!at.stack.some((item) => item.spanId === historical.spanId)) {
        at.stack.unshift({ spanId: historical.spanId, type: historical.type })
      }
      return historical
    }
    return this.startSpan(traceId, init)
  }

  /** 确保 trace 活跃（join 语义）：未活跃时用给定 ctx 开启；已活跃保持原 ctx 不变。 */
  ensureActive(ctx: TraceContext): void {
    if (!this.active.has(ctx.traceId)) this.beginTrace(ctx)
  }

  /** trace 是否活跃（已 begin 未 end）：阶段容器/Finish 标记写入前的判活。 */
  isActive(traceId: string): boolean {
    return this.active.has(traceId)
  }

  /** 当前活跃栈顶 spanId（适配器取默认父用）。 */
  currentSpanId(traceId: string): string | undefined {
    const at = this.active.get(traceId)
    return at?.stack.at(-1)?.spanId
  }

  /** 当前活跃栈（自底向上，只读），供适配器计算显式父级（跳过指定类型）。 */
  stack(traceId: string): Array<{ spanId: string; type: SpanType }> {
    return [...(this.active.get(traceId)?.stack ?? [])]
  }

  /** 启动一个 span：生成 id、记录时间、入栈、脱敏、持久化。 */
  startSpan(traceId: string, init: SpanInit): AgentSpan {
    const at = this.requireTrace(traceId)
    const now = Date.now()
    const span: AgentSpan = {
      spanId: `evt-${traceId}-${++at.seq}`,
      traceId,
      parentSpanId: init.parentSpanId ?? at.stack.at(-1)?.spanId,
      type: init.type,
      name: init.name,
      status: 'started',
      startedAt: now,
      sequence: at.seq,
      createdAt: new Date(now).toISOString(),
      ...(init.input !== undefined ? { input: init.input } : {}),
      ...(init.model ? { model: init.model } : {}),
      ...(init.meta ? { meta: init.meta } : {})
    }
    at.spans.push(span)
    at.stack.push({ spanId: span.spanId, type: init.type })
    this.persist(traceId, 'span_start', span)
    return span
  }

  /** 更新 span（流式中间态），返回更新后的 span。 */
  updateSpan(traceId: string, span: AgentSpan, patch?: Partial<AgentSpan>): AgentSpan {
    this.requireTrace(traceId)
    if (patch) Object.assign(span, patch)
    this.persist(traceId, 'span_update', span)
    return span
  }

  /** 结束 span：补 durationMs/cost、出栈、持久化。 */
  endSpan(traceId: string, span: AgentSpan, patch?: SpanEndPatch): AgentSpan {
    const at = this.requireTrace(traceId)
    span.status = patch?.status ?? (span.status === 'error' ? 'error' : 'completed')
    span.endedAt = patch?.endedAt ?? Date.now()
    if (patch?.output !== undefined) span.output = patch.output
    if (patch?.usage !== undefined) span.usage = patch.usage
    if (patch?.error !== undefined) span.error = patch.error
    if (patch?.meta !== undefined) span.meta = patch.meta
    finalizeSpanDuration(span)
    // 弹栈：匹配该 spanId（异常情况不匹配时直接移除栈顶同 type 的条目）
    const idx = at.stack.findIndex((s) => s.spanId === span.spanId)
    if (idx >= 0) at.stack.splice(idx, 1)
    this.persist(traceId, 'span_end', span)
    return span
  }

  /**
   * 结束 trace：兜底关闭未结束 span → 聚合摘要落盘 → 清理活跃态。
   * 摘要基于存储全量快照（含恢复前历史 span），跨恢复/续接累计 token/成本/耗时——
   * 恢复执行后再次 finalize 不会丢失首跑数据。
   */
  endTrace(traceId: string): TraceSummary | undefined {
    const at = this.active.get(traceId)
    if (!at) return undefined
    // 兜底：未显式结束的 span（task.run / 根 span 等）统一收尾，保证摘要指标完整。
    for (const span of at.spans) {
      if (span.status === 'started' || span.status === 'running') {
        span.status = 'completed'
        span.endedAt = Date.now()
        finalizeSpanDuration(span)
        this.persist(traceId, 'span_end', span)
      }
    }
    // 全量快照：本会话 span 均已同步落盘，loadSpans 读到的是含历史的完整集；无存储能力时退化为内存聚合。
    const allSpans = this.storage.loadSpans?.(traceId) ?? at.spans
    const summary = summarizeTrace(traceId, at.ctx.kind, at.ctx.title, allSpans, undefined, {
      model: at.ctx.model,
      agentName: at.ctx.agentName
    })
    this.storage.finalize(traceId, summary)
    this.active.delete(traceId)
    return summary
  }

  private requireTrace(traceId: string): ActiveTrace {
    const at = this.active.get(traceId)
    if (!at) throw new Error(`TracePipeline: 未 beginTrace 的 traceId=${traceId}`)
    return at
  }

  /** 统一出口：脱敏 → 指标 → 持久化 → live 推送。 */
  private persist(traceId: string, op: SpanOp, span: AgentSpan): void {
    const redacted = redactSpan(span)
    if (redacted.input !== undefined) span.input = redacted.input
    if (redacted.output !== undefined) span.output = redacted.output
    if (redacted.meta !== undefined) span.meta = redacted.meta as Record<string, unknown>
    if (redacted.error !== undefined) span.error = redacted.error as { message: string; stack?: string }
    if (span.name) span.name = String(redactSpan({ input: span.name }).input ?? span.name)
    // 指标预计算：cost 缺省时按单价表估算（provider 显式 cost 优先）。
    const usage = applySpanCost(span)
    if (usage) span.usage = usage
    this.storage.appendSpan(traceId, op, span)
    this.emitLive?.({ type: 'trace_span', traceId, op, span })
  }
}
