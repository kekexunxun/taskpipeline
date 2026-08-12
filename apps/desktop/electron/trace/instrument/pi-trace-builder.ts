/**
 * OpenAI/Pi 埋点适配器 —— Pi Agent 事件流 → AgentSpan。
 *
 * 供任务路径使用（main.ts emitPi 的 Pi 会话事件）：
 * - agent_start / agent_end → agent.run span（任务 Trace 根 task.run 之下）；
 * - message_start / message_update / message_end → llm.generate span（text 累积，end 落 usage/error）；
 * - tool_execution_start / tool_execution_end → tool.execute span（挂当前 llm）。
 */

import type { AgentSpan, SpanSource, TraceKind } from '@task-pipeline/core'
import type { TracePipeline } from '../bus/trace-pipeline.js'

type PiUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export class PiTraceBuilder {
  private llmSpan: AgentSpan | undefined
  private textBuf: string[] = []
  private readonly tools = new Map<string, AgentSpan>()
  private agentSpan: AgentSpan | undefined

  constructor(
    private readonly pipeline: TracePipeline,
    private readonly traceId: string,
    private readonly kind: TraceKind = 'task',
    private readonly source: SpanSource = 'pi'
  ) {}

  onEvent(record: Record<string, unknown>): void {
    switch (record.type) {
      case 'agent_start':
        this.ensureAgent(record)
        break
      case 'agent_end':
        this.endAgent()
        break
      case 'message_start':
        this.startLlm(record)
        break
      case 'message_update':
        this.updateLlm(record)
        break
      case 'message_end':
        this.endLlm(record)
        break
      case 'tool_execution_start':
        this.startTool(record)
        break
      case 'tool_execution_end':
        this.endTool(record)
        break
      default:
        break
    }
  }

  private ensureAgent(record: Record<string, unknown>): void {
    if (this.agentSpan) return
    const phase = typeof record.phase === 'string' ? record.phase : undefined
    this.agentSpan = this.pipeline.startSpan(this.traceId, {
      type: 'agent.run',
      name: phase ? `Agent ${phase}` : 'Agent',
      meta: { source: this.source, ...(phase ? { phase } : {}) }
    })
  }

  private endAgent(): void {
    if (!this.agentSpan) return
    this.pipeline.endSpan(this.traceId, this.agentSpan)
    this.agentSpan = undefined
  }

  private startLlm(record: Record<string, unknown>): void {
    if (this.llmSpan) return
    const message = record.message as { model?: string } | undefined
    const model = typeof message?.model === 'string' ? message.model : undefined
    this.llmSpan = this.pipeline.startSpan(this.traceId, {
      type: 'llm.generate',
      name: model ?? 'LLM',
      model,
      meta: { source: this.source }
    })
  }

  private updateLlm(record: Record<string, unknown>): void {
    const update = record.assistantMessageEvent as { type?: string; delta?: string } | undefined
    if (update?.type === 'text_delta' && update.delta) this.textBuf.push(update.delta)
  }

  private endLlm(record: Record<string, unknown>): void {
    if (!this.llmSpan) return
    const span = this.llmSpan
    const message = record.message as
      | { role?: string; stopReason?: string; errorMessage?: string; usage?: PiUsage }
      | undefined
    const text = messageText(message)
    const usage = usageToSpanUsage(message?.usage)
    const isError = message?.stopReason === 'error' || Boolean(message?.errorMessage)
    this.pipeline.endSpan(this.traceId, span, {
      ...(text || this.textBuf.length > 0 ? { output: text || this.textBuf.join('') } : {}),
      usage,
      status: isError ? 'error' : 'completed',
      ...(isError ? { error: { message: message?.errorMessage ?? '模型流式输出异常结束' } } : {})
    })
    this.llmSpan = undefined
    this.textBuf = []
  }

  private startTool(record: Record<string, unknown>): void {
    const tool = record as { toolCallId?: string; toolName?: string; args?: unknown }
    if (!tool.toolCallId) return
    const span = this.pipeline.startSpan(this.traceId, {
      type: 'tool.execute',
      name: tool.toolName ?? '工具',
      input: tool.args,
      // 显式父级：挂当前 llm（缺省挂 agent.run），不挂栈顶——
      // 挂栈顶会让同批并发工具逐个嵌套（后发的工具挂到前一个未收尾的工具下）。
      parentSpanId: this.llmSpan?.spanId ?? this.agentSpan?.spanId,
      meta: { source: this.source, toolCallId: tool.toolCallId }
    })
    this.tools.set(tool.toolCallId, span)
  }

  private endTool(record: Record<string, unknown>): void {
    const tool = record as { toolCallId?: string; result?: unknown; isError?: boolean }
    const span = tool.toolCallId ? this.tools.get(tool.toolCallId) : undefined
    if (!span) return
    if (tool.toolCallId) this.tools.delete(tool.toolCallId)
    this.pipeline.endSpan(this.traceId, span, {
      output: tool.result,
      status: tool.isError ? 'error' : 'completed'
    })
  }
}

function messageText(message: { content?: unknown } | Record<string, unknown> | undefined): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .filter((part): part is { text: string } =>
        Boolean(part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string')
      )
      .map((part) => part.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return undefined
}

function usageToSpanUsage(usage: PiUsage | undefined): AgentSpan['usage'] | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const input = usage.inputTokens ?? usage.input_tokens ?? 0
  const output = usage.outputTokens ?? usage.output_tokens ?? 0
  const total = usage.totalTokens ?? usage.total_tokens ?? input + output
  if (input + output + total === 0) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(usage.cacheReadTokens ? { cacheRead: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens ? { cacheWrite: usage.cacheWriteTokens } : {})
  }
}
