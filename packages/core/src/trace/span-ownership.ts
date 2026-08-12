/**
 * Span 归属重定向（渲染层共用）—— Waterfall.buildTree 与 trace-service.spansToAgentEvents
 * 两端共用同一份规则，避免双份实现漂移。
 *
 * 背景：Qoder SDK 的 task_started 滞后于子代理内部流，早到的内部 span 的 parentSpanId
 * 只是「当时的锚点」（埋点层不再事后改写已落盘 span）。真实归属由 SDK 原始字段表达：
 *
 *   span.meta.parentToolUseId                本 span 所属子代理的「委派工具 callId」
 *     → 委派工具 span（meta.toolCallId 相同）  子代理在父级流程里的发起调用
 *     → subtask.run（meta.toolUseId 相同）     该委派工具启动的子任务
 *
 * 嵌套子代理沿链逐级：内部 span 的 parentToolUseId 指向最内层委派工具，一步解析到最内层
 * subtask；嵌套委派工具自身的 parentToolUseId 再指向父级子任务的委派工具。
 *
 * 旧数据兼容：埋点层曾把子代理内部 span 的 parentSpanId 直接改写为 subtask.run.spanId，
 * 且委派工具的 parentSpanId 直指 subtask.run —— 保留 parentSpanId 链走查兜底。
 */

import type { AgentSpan } from './types.js'

/** 归属索引：由 span 列表一次性预计算的查找表。 */
export type SpanOwnershipIndex = {
  /** spanId → span。 */
  byId: Map<string, AgentSpan>
  /** 工具 callId（meta.toolCallId）→ 工具 span（委派工具反查）。 */
  toolByCallId: Map<string, AgentSpan>
  /** 委派工具 callId（subtask meta.toolUseId）→ subtask.run span。 */
  subtaskByDelegateCallId: Map<string, AgentSpan>
  /** 旧数据：subtask.run.spanId → parentSpanId 直指它的委派工具 spanId。 */
  legacyDelegateBySubtask: Map<string, string>
}

/**
 * Qoder 委派子 Agent 的工具判定：tool.execute 且工具名是 SDK 委派工具（'Agent'/'task'）、
 * input 带非空 description。Bash 等普通工具也有 description（人类可读说明），
 * 必须用工具名排除，否则会被误判成委派调用。
 */
export function isDelegateToolSpan(span: AgentSpan): boolean {
  if (span.type !== 'tool.execute' || (span.name !== 'Agent' && span.name !== 'task')) return false
  if (span.input === null || typeof span.input !== 'object' || Array.isArray(span.input)) return false
  const desc = (span.input as Record<string, unknown>).description
  return typeof desc === 'string' && desc.length > 0
}

/** 构建归属索引（O(n)）。 */
export function buildSpanOwnershipIndex(spans: AgentSpan[]): SpanOwnershipIndex {
  const byId = new Map<string, AgentSpan>()
  const toolByCallId = new Map<string, AgentSpan>()
  const subtaskByDelegateCallId = new Map<string, AgentSpan>()
  for (const span of spans) {
    byId.set(span.spanId, span)
    const meta = span.meta ?? {}
    if (span.type === 'tool.execute' && typeof meta.toolCallId === 'string' && meta.toolCallId) {
      toolByCallId.set(meta.toolCallId, span)
    }
    if (span.type === 'subtask.run' && typeof meta.toolUseId === 'string' && meta.toolUseId) {
      subtaskByDelegateCallId.set(meta.toolUseId, span)
    }
  }
  const legacyDelegateBySubtask = new Map<string, string>()
  for (const span of spans) {
    if (!isDelegateToolSpan(span) || !span.parentSpanId) continue
    if (byId.get(span.parentSpanId)?.type === 'subtask.run') {
      legacyDelegateBySubtask.set(span.parentSpanId, span.spanId)
    }
  }
  return { byId, toolByCallId, subtaskByDelegateCallId, legacyDelegateBySubtask }
}

/**
 * span 的归属 subtask.run：
 * 1. 新数据：meta.parentToolUseId → subtaskByDelegateCallId（一步到最内层子任务）；
 * 2. 旧数据：parentSpanId 链走查（内部 span 的 parentSpanId 曾被改写为 subtask.run）。
 * 主流程 span 返回 undefined。
 */
export function ownerSubtaskOf(span: AgentSpan, index: SpanOwnershipIndex): AgentSpan | undefined {
  const parentToolUseId = typeof span.meta?.parentToolUseId === 'string' ? span.meta.parentToolUseId : undefined
  if (parentToolUseId) {
    const owner = index.subtaskByDelegateCallId.get(parentToolUseId)
    if (owner && owner.spanId !== span.spanId) return owner
  }
  let cur = span.parentSpanId
  let guard = 0
  while (cur && guard++ < 64) {
    const parent = index.byId.get(cur)
    if (!parent) break
    if (parent.type === 'subtask.run' && parent.spanId !== span.spanId) return parent
    cur = parent.parentSpanId
  }
  return undefined
}

/**
 * subtask 的委派工具 spanId（瀑布图中子任务内容的可视容器行）：
 * 新数据按 meta.toolUseId 反查；旧数据用 legacy 映射（parentSpanId 直指 subtask 的委派工具）。
 */
export function delegateToolIdOf(subtask: AgentSpan, index: SpanOwnershipIndex): string | undefined {
  const toolUseId = typeof subtask.meta?.toolUseId === 'string' ? subtask.meta.toolUseId : undefined
  if (toolUseId) {
    const tool = index.toolByCallId.get(toolUseId)
    if (tool) return tool.spanId
  }
  return index.legacyDelegateBySubtask.get(subtask.spanId)
}
