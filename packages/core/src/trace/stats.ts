/**
 * 指标预计算 —— span 级 + trace 级聚合（避免展示层重复计算）。
 *
 * - span 级：durationMs = endedAt - startedAt；costUsd 优先 provider 显式返回，
 *   缺失时按模型单价表估算（见 cost-table.ts）。
 * - trace 级：finalize 时聚合全部 span → TraceSummary（总耗时 / 总 Token / 总成本 / 工具统计 / 错误数）。
 */

import { estimateCostUsd } from './cost-table.js'
import type { AgentSpan, AgentSpanUsage, TraceKind, TraceSummary } from './types.js'

/** 计算 span 的 usage.costUsd（provider 值优先，缺失则估算；返回新 usage 或 undefined）。 */
export function applySpanCost(span: Pick<AgentSpan, 'usage' | 'model' | 'name'>): AgentSpanUsage | undefined {
  const usage = span.usage
  if (!usage) return undefined
  const out: AgentSpanUsage = { ...usage }
  if (out.costUsd === undefined || out.costUsd === 0) {
    const estimated = estimateCostUsd(span.model ?? span.name, out.inputTokens, out.outputTokens)
    if (estimated !== undefined) out.costUsd = estimated
  }
  return out
}

/** span 完成时补全 durationMs（原地修改并返回）。 */
export function finalizeSpanDuration(span: AgentSpan): AgentSpan {
  if (span.endedAt !== undefined && span.durationMs === undefined) {
    span.durationMs = Math.max(0, span.endedAt - span.startedAt)
  }
  return span
}

/**
 * 聚合 span 列表 → TraceSummary（trace_end 时调用，落 info/）。
 *
 * @param opts 执行上下文显式声明的模型 / Agent（beginTrace 时传入）：
 *   任务路径是 task.qoderModel（任务真实模型），对话路径是 driver 实际使用的模型。
 *   优先于 span 推断 —— 避免 trace 内混入的辅助 LLM 调用（记忆检索关键词提取等）
 *   用系统模型覆盖任务模型，也避免 Qoder span 写死占位名。
 */
export function summarizeTrace(
  traceId: string,
  kind: TraceKind,
  title: string,
  spans: AgentSpan[],
  now = new Date().toISOString(),
  opts?: { model?: string; agentName?: string }
): TraceSummary {
  const tokenAcc = { input: 0, output: 0, total: 0 }
  let costUsd = 0
  let model: string | undefined
  let agentName: string | undefined
  let firstTs: number | undefined
  let lastTs: number | undefined
  const toolIndex = new Map<string, { count: number; errors: number }>()
  let errorCount = 0

  for (const span of spans) {
    if (firstTs === undefined || span.startedAt < firstTs) firstTs = span.startedAt
    const ended = span.endedAt ?? span.startedAt
    if (lastTs === undefined || ended > lastTs) lastTs = ended
    if (span.type === 'llm.generate' || span.type === 'agent.run') {
      const usage = span.usage
      if (usage) {
        tokenAcc.input += usage.inputTokens ?? 0
        tokenAcc.output += usage.outputTokens ?? 0
        tokenAcc.total += usage.totalTokens ?? 0
        costUsd += usage.costUsd ?? 0
      }
      if (span.model) model = span.model
    }
    const meta = span.meta ?? {}
    if (typeof meta.agentName === 'string' && !agentName) agentName = meta.agentName
    if (span.status === 'error') errorCount += 1
    if (span.type === 'tool.execute') {
      const name = span.name || '工具'
      const hit = toolIndex.get(name) ?? { count: 0, errors: 0 }
      hit.count += 1
      if (span.status === 'error') hit.errors += 1
      toolIndex.set(name, hit)
    }
  }

  const summary: TraceSummary = {
    traceId,
    kind,
    title,
    // ctx 显式声明优先（任务真实模型 / driver 实际模型），spans 推断兜底
    ...(opts?.model || model ? { model: opts?.model || model } : {}),
    ...(opts?.agentName || agentName ? { agentName: opts?.agentName || agentName } : {}),
    // 两态模型：finalize 只在记录停止写入时调用，恒为 'ended'。
    // 不把任何 span 级 error 聚合为 trace 状态（Agent 探索中工具失败是常态）；
    // 错误量由 errorCount 独立承载，展示层以"N 个错误步骤"标记呈现。
    status: 'ended',
    startedAt: firstTs !== undefined ? new Date(firstTs).toISOString() : now,
    ...(lastTs !== undefined ? { endedAt: new Date(lastTs).toISOString() } : {}),
    ...(firstTs !== undefined && lastTs !== undefined ? { durationMs: Math.max(0, lastTs - firstTs) } : {}),
    ...(tokenAcc.total > 0
      ? { tokens: { input: tokenAcc.input, output: tokenAcc.output, total: tokenAcc.total } }
      : {}),
    ...(costUsd > 0 ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
    spanCount: spans.length,
    errorCount,
    ...(toolIndex.size > 0
      ? {
          toolStats: [...toolIndex.entries()]
            .map(([name, { count, errors }]) => ({ name, count, errors }))
            .sort((a, b) => b.count - a.count)
        }
      : {}),
    updatedAt: now
  }
  return summary
}
