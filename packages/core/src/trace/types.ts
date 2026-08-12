/**
 * Trace 系统 v2 核心类型 —— 标准化 AgentSpan 与 TraceSummary。
 *
 * 设计要点（参考 Mastra）：
 * - 埋点层（OpenAI/Pi + Qoder 两路适配器）统一产出 AgentSpan，生命周期三态：
 *   `span_start` → `span_update`（流式/状态变更，全量快照覆盖）→ `span_end`；
 * - 一次用户提问 = 一个 Trace（任务路径：一次任务执行 = 一个 Trace）；
 * - 执行树：`traceId` 定位一次会话，`parentSpanId` 挂载父子层级；
 * - 入库前所有 `input / output / meta / error` 必须经过脱敏（见 redact.ts）。
 */

/** Span 类型：对应瀑布图色块语义。 */
export type SpanType =
  | 'session.start' // 一次用户提问 / 一次任务执行 的根
  | 'task.run' // 任务级根（CodingPage 任务执行）
  | 'agent.run' // Agent 阶段（planning / implementing / validating / 子代理）
  | 'llm.generate' // 单次 LLM 调用
  | 'tool.execute' // 单次工具调用
  | 'subtask.run' // 子任务（Qoder 子 Agent / 嵌套子代理）

export type SpanStatus = 'started' | 'running' | 'completed' | 'error' | 'cancelled'

/** 埋点来源：区分 SDK 供应商。 */
export type SpanSource = 'pi' | 'qoder' | 'openai'

/** LLM 用量与成本（Bus 层预计算 costUsd）。 */
export type AgentSpanUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheRead?: number
  cacheWrite?: number
  costUsd?: number
}

/** 标准化执行 span。所有字段在写入存储前已脱敏。 */
export type AgentSpan = {
  /** 全局唯一：`evt-<traceId>-<seq>`（qoder 源可带工具 callId 语义，保持可读）。 */
  spanId: string
  /** 归属 Trace（一次用户提问 / 一次任务执行）。 */
  traceId: string
  /** 执行树父节点；undefined = 根 span（session.start / task.run）。 */
  parentSpanId?: string
  type: SpanType
  /** 展示名：模型名 / 工具名 / Agent 阶段名。 */
  name: string
  status: SpanStatus
  /** epoch ms —— 瀑布图时间轴基准。 */
  startedAt: number
  endedAt?: number
  /** 预计算：endedAt - startedAt。 */
  durationMs?: number
  /** 已脱敏入参：LLM prompt / 工具参数 / user message。 */
  input?: unknown
  /** 已脱敏出参：completions / 工具原始结果。 */
  output?: unknown
  usage?: AgentSpanUsage
  model?: string
  error?: { message: string; stack?: string }
  /**
   * SDK 归属元信息（保留前端折叠分组所需字段）：
   * source / agentName / subtaskId / parentTaskId / sdkSubtype / toolCallId / phase 等。
   */
  meta?: Record<string, unknown>
  /** trace 内写入序号（决定时间线顺序）。 */
  sequence: number
  createdAt: string
}

/** span 生命周期写入操作。 */
export type SpanOp = 'span_start' | 'span_update' | 'span_end'

/** JSONL 单行记录。 */
export type SpanRecord = { op: SpanOp; span: AgentSpan }

/** Trace 归属类型。 */
export type TraceKind = 'chat' | 'task'

/**
 * Trace 状态（列表页状态列）：只有「进行中 / 已结束」两态，无"失败"。
 * trace 是数据记录层，业务成败由任务状态机 / Finish span meta 承载；
 * span 级 error 数据原样保留（见 TraceSummary.errorCount）。
 */
export type TraceState = 'running' | 'ended'

/** Trace 级预计算摘要（trace_end 时 finalize 落盘，展示层不再重复计算）。 */
export type TraceSummary = {
  traceId: string
  kind: TraceKind
  /** 用户提问摘要 / 任务标题。 */
  title: string
  agentName?: string
  model?: string
  status: TraceState
  startedAt: string
  endedAt?: string
  /** 总耗时（ms）。 */
  durationMs?: number
  /** 总 Token。 */
  tokens?: { input: number; output: number; total: number }
  /** 总成本（USD）。 */
  costUsd?: number
  spanCount: number
  errorCount: number
  /** 工具调用统计：工具名 → 次数 / 失败数。 */
  toolStats?: Array<{ name: string; count: number; errors: number }>
  /** 孤儿收口标记：应用崩溃/强杀残留，启动时被自动 finalize 为已结束。 */
  interrupted?: boolean
  updatedAt: string
}

/** 聚合统计（仪表盘顶部卡片：今日总请求数 / 平均耗时 / 总成本）。 */
export type TraceDashboardStats = {
  todayCount: number
  weekCount: number
  avgDurationMs?: number
  totalCostUsd?: number
  errorCount: number
}
