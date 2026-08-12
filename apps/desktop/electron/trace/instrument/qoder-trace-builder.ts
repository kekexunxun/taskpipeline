/**
 * Qoder 埋点适配器 —— Qoder SDKMessage 流 → AgentSpan。
 *
 * 供任务路径（qoder-task-agent onMessage）与对话路径（qoder-chat-driver onSdkMessage）共用。
 * 状态机：
 * - assistant / stream_event 流 → 一个 llm.generate span（thinking/text 累积到 output，end 时落盘；
 *   全量 assistant 文本与流式增量去重，避免同一段文本重复落盘）；
 * - tool_use / tool_result（content_block 或 assistant block / user 消息）→ tool.execute span；
 * - system task_started / task_progress / task_notification → subtask.run span；
 * - result → 会话结果（usage / cost 汇总到最近 llm span）；
 * - error → 当前 llm span 标记 error。
 *
 * 父子关系显式化（不依赖“挂栈顶”）：
 * - 工具 span 挂“所属子任务（parent_tool_use_id 反查）或当前 llm”，同轮工具平级，互不嵌套；
 * - llm span 跳过未收尾的工具 span 挂 agent.run / subtask（避免工具未收尾时链式堆叠）；
 * - subtask span 挂“委派它的工具”（task_started.tool_use_id → tool span）。
 *
 * 数据诚实化（原样落库原则）：
 * - SDK 原始 `parent_tool_use_id` 原样写入 span meta（meta.parentToolUseId）；task_started 滞后于
 *   子代理内部流，早到的内部 span parentSpanId 只能是当时的锚点——不再事后改写已落盘 span 的
 *   parentSpanId，归属重定向由渲染层按 meta.parentToolUseId 链解析（旧数据双通路兼容）。
 * - 跟踪 lastMessageAt（每条 SDK 消息到达时间）；finish()/task_notification/result 兜底收尾
 *   悬挂 span 时以 lastMessageAt 作 endedAt，消除「悬到 finish() 才关」的假时长。
 */

import type { AgentSpan, SpanSource, TraceKind } from '@task-pipeline/core'
import type { TracePipeline } from '../bus/trace-pipeline.js'

type QoderUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

type QoderBlock = {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

/** result 消息的 modelUsage 分桶（按模型，camelCase；SDK 真实形状）。 */
type QoderModelUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
}

type QoderMessage = {
  type?: string
  subtype?: string
  task_id?: string
  tool_use_id?: string
  description?: string
  task_type?: string
  subagent_type?: string
  status?: string
  summary?: string
  output_file?: string
  last_tool_name?: string
  parent_tool_use_id?: string | null
  event?: {
    type?: string
    index?: number
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
    content_block?: QoderBlock
    error?: { message?: string } | string
  }
  message?: { content?: QoderBlock[]; usage?: QoderUsage; parent_tool_use_id?: string | null }
  /** result 消息：result 字段是文本结论，usage/total_cost_usd/modelUsage 在消息顶层（SDK 真实形状）。 */
  result?: string
  usage?: QoderUsage
  total_cost_usd?: number
  modelUsage?: Record<string, QoderModelUsage>
  error?: string
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class QoderTraceBuilder {
  private llmSpan: AgentSpan | undefined
  /** 最近一个已结束的 llm span：result 消息的 usage 补录用（llmSpan 在 assistant 时已 end 清空）。 */
  private lastLlmSpan: AgentSpan | undefined
  private textBuf: string[] = []
  private thinkingBuf: string[] = []
  /** 最近一条消息的 parent_tool_use_id（子代理内部流归属判断用）。 */
  private lastParentToolUseId: string | undefined
  /** callId → tool.execute span（tool_result 反查结束用）。 */
  private readonly tools = new Map<string, AgentSpan>()
  /** callId → 创建时的 parent_tool_use_id（subtask 回填归属判断用）。 */
  private readonly toolParents = new Map<string, string>()
  /** callId → input_json_delta 累积（流式工具入参增量）。 */
  private readonly toolInputBuf = new Map<string, string>()
  /** stream block index → callId（input_json_delta 与 content_block_start 配对）。 */
  private readonly toolCallIdByBlockIndex = new Map<number, string>()
  /** 委派工具 callId → tool span（subtask 挂载点反查）。 */
  private readonly toolSpanByToolUseId = new Map<string, AgentSpan>()
  /** 委派工具 callId → task_id（task_started 注册，子代理内部消息反查归属）。 */
  private readonly taskIdByToolUseId = new Map<string, string>()
  /** taskId → subtask.run span。 */
  private readonly subtasks = new Map<string, AgentSpan>()
  /** 最近一条 SDK 消息到达时间：兜底收尾悬挂 span 的 endedAt（消除假时长）。 */
  private lastMessageAt = 0
  /** 最近一条 user 文本消息：作为下一 llm span 的 input（消费一次即清空）。 */
  private pendingUserText: string | undefined
  /** 构建时栈底的根 span（task.run / session.start）：栈空时挂回的兜底，避免出现游离根节点。 */
  private readonly rootSpanId: string | undefined
  /** llm span 展示名/模型名：调用方传入真实模型（task.qoderModel / driver model），缺省兜底 'qoder'。 */
  private readonly modelName: string
  /** llm span 语义名（如「关键词提取」「记忆整理」）：来自 streamChat 的 traceLabel。 */
  private readonly label: string | undefined

  constructor(
    private readonly pipeline: TracePipeline,
    private readonly traceId: string,
    private readonly kind: TraceKind,
    private readonly source: SpanSource = 'qoder',
    modelName = 'qoder',
    label?: string
  ) {
    this.rootSpanId = this.pipeline.stack(this.traceId).at(0)?.spanId
    this.modelName = modelName
    this.label = label
  }

  /** 当前 trace 栈顶 spanId（供外部确认父级）。 */
  currentParent(): string | undefined {
    return this.pipeline.currentSpanId(this.traceId)
  }

  onMessage(message: QoderMessage): void {
    this.lastMessageAt = Date.now()
    this.lastParentToolUseId = this.parentToolUseIdOf(message)
    switch (message.type) {
      case 'system':
        this.onSystem(message)
        break
      case 'stream_event':
        this.onStreamEvent(message)
        break
      case 'assistant':
        this.onAssistant(message)
        break
      case 'user':
        this.onUser(message)
        break
      case 'result':
        this.onResult(message)
        break
      case 'error':
        this.onError(message)
        break
      default:
        break
    }
  }

  /** 外部调用：确保已有一个 llm 会话（首次 assistant/stream 前调用）。 */
  ensureLlmSession(name = this.modelName): void {
    this.ensureLlm(name)
  }

  /** 外部调用：显式提供本回合用户输入（对话主路径 driver 传入），作下一 llm span 的 input。 */
  setTurnInput(text: string): void {
    if (text) this.pendingUserText = text
  }

  /** 会话结束兜底：结束未关闭的 llm/工具/子任务 span（以 lastMessageAt 收尾，避免假时长）。 */
  finish(patch?: { status?: 'completed' | 'error' | 'cancelled'; error?: { message: string; stack?: string } }): void {
    this.endLlm(patch)
    this.sweepTools(() => true)
    for (const [taskId, span] of this.subtasks) {
      this.pipeline.endSpan(this.traceId, span, { status: 'cancelled', endedAt: this.lastMessageAt || undefined })
      this.subtasks.delete(taskId)
    }
  }

  /** 兜底收尾仍在途的工具 span（predicate 圈定范围）；endedAt 取最后消息到达时间。 */
  private sweepTools(predicate: (callId: string, span: AgentSpan) => boolean): void {
    for (const [callId, span] of this.tools) {
      if (!predicate(callId, span)) continue
      this.tools.delete(callId)
      this.pipeline.endSpan(this.traceId, span, { status: 'cancelled', endedAt: this.lastMessageAt || undefined })
    }
  }

  // === 父级计算 =============================================================

  /** 从任意位置读 parent_tool_use_id（SDK 可能挂在顶层或 message 顶层）。 */
  private parentToolUseIdOf(message: QoderMessage): string | undefined {
    return readNonEmptyString(message.parent_tool_use_id) ?? readNonEmptyString(message.message?.parent_tool_use_id)
  }

  /** 栈中自顶向下第一个非 tool.execute 的 span（工具/llm 的默认父，保证平级不嵌套）。 */
  private anchorParent(): string | undefined {
    const stack = this.pipeline.stack(this.traceId)
    for (let i = stack.length - 1; i >= 0; i--) {
      const item = stack[i]
      if (item && item.type !== 'tool.execute') return item.spanId
    }
    // 栈空（如回合间隙 SDK 补发消息）：挂回根，避免 llm/tool 变成游离根节点。
    return this.rootSpanId
  }

  /** parent_tool_use_id → 所属子任务 spanId（主流程消息返回 undefined）。 */
  private subtaskSpanIdFor(parentToolUseId: string | undefined): string | undefined {
    if (!parentToolUseId) return undefined
    const taskId = this.taskIdByToolUseId.get(parentToolUseId)
    return taskId ? this.subtasks.get(taskId)?.spanId : undefined
  }

  // === llm ==================================================================

  private ensureLlm(name: string): AgentSpan {
    if (this.llmSpan && this.llmSpan.status === 'started') return this.llmSpan
    const span = this.pipeline.startSpan(this.traceId, {
      type: 'llm.generate',
      // 语义名（关键词提取/记忆整理等辅助调用）优先；模型名始终在 model 字段。
      name: this.label ?? name,
      model: this.modelName,
      // 显式父：所属子任务（子代理内部文本）或最近的非工具锚点。
      parentSpanId: this.subtaskSpanIdFor(this.lastParentToolUseId) ?? this.anchorParent(),
      // 本回合用户输入作首个 llm span 的 input（消费一次即清空，后续回合不重复记录）。
      ...(this.pendingUserText ? { input: this.pendingUserText } : {}),
      meta: {
        source: this.source,
        ...(this.label ? { traceLabel: this.label } : {}),
        // SDK 原始归属原样落 meta，归属重定向由渲染层按此链解析（不改写已落盘 parentSpanId）。
        ...(this.lastParentToolUseId ? { parentToolUseId: this.lastParentToolUseId } : {})
      }
    })
    this.pendingUserText = undefined
    this.llmSpan = span
    return span
  }

  private endLlm(patch?: {
    usage?: AgentSpan['usage']
    status?: 'completed' | 'error' | 'cancelled'
    error?: { message: string; stack?: string }
  }): void {
    if (!this.llmSpan) return
    const span = this.llmSpan
    const out = [...this.textBuf].join('')
    const thinking = [...this.thinkingBuf].join('')
    this.pipeline.endSpan(this.traceId, span, {
      ...(out ? { output: thinking ? { thinking, text: out } : out } : thinking ? { output: { thinking } } : {}),
      usage: patch?.usage,
      status: patch?.status,
      error: patch?.error
    })
    this.llmSpan = undefined
    this.lastLlmSpan = span
    this.textBuf = []
    this.thinkingBuf = []
  }

  /** 追加文本并去重：assistant 全量消息与流式 delta 相同内容只落一次。 */
  private appendText(text: string): void {
    this.mergeText(this.textBuf, text)
  }

  private appendThinking(text: string): void {
    this.mergeText(this.thinkingBuf, text)
  }

  /**
   * 流式 delta 与全量消息的文本合并：
   * - 全量是已累积内容的子集 → 跳过（去重）；
   * - 全量包含已累积内容 → 整体替换（流式碎片被完整快照覆盖，避免重复拼接）。
   */
  private mergeText(buf: string[], full: string): void {
    if (!full) return
    const joined = buf.join('')
    if (!joined) {
      buf.push(full)
    } else if (joined.includes(full)) {
      /* 全量是子集：已存在，跳过 */
    } else if (full.includes(joined)) {
      buf.length = 0
      buf.push(full)
    } else {
      buf.push(full)
    }
  }

  // === 工具 =================================================================

  private startTool(name: string, input: unknown, callId: string, parentToolUseId?: string): void {
    if (!callId) return
    // 同一 callId 可能先经 content_block_start（input 常为空）创建、再由 assistant 全量快照再次出现：
    // 复用已有 span 并回填 input，绝不重复建 span（重复建会让旧 span 永不收尾、树里出现同 id 两条）。
    const existing = this.tools.get(callId)
    if (existing) {
      if (input !== undefined) {
        existing.name = name
        existing.input = input
        this.pipeline.updateSpan(this.traceId, existing, { name, input })
      }
      if (parentToolUseId) this.toolParents.set(callId, parentToolUseId)
      return
    }
    const span = this.pipeline.startSpan(this.traceId, {
      type: 'tool.execute',
      name,
      // input 透传原值（可能 undefined）：流式入参由 input_json_delta 累积回填，
      // 不要用 {} 占位 —— 占位会让「Glob 无参数」且 endTool 无法再回填。
      ...(input !== undefined ? { input } : {}),
      // 显式父：当前 llm 回合优先（llm → tool 嵌套，含子代理内部回合），
      // 其次所属子任务（纯工具回合无 llm），再回退刚收尾的 llm（step 边界先 endLlm 再
      // startTool 时工具仍挂该 llm），最后锚点（跳过未收尾工具，同轮工具平级）。
      parentSpanId:
        this.llmSpan?.spanId ??
        this.subtaskSpanIdFor(parentToolUseId) ??
        this.lastLlmSpan?.spanId ??
        this.anchorParent(),
      meta: {
        source: this.source,
        toolCallId: callId,
        // SDK 原始归属原样落 meta（渲染层重定向依据），task_started 滞后时 parentSpanId 只是当时锚点。
        ...(parentToolUseId ? { parentToolUseId } : {})
      }
    })
    this.tools.set(callId, span)
    this.toolSpanByToolUseId.set(callId, span)
    if (parentToolUseId) this.toolParents.set(callId, parentToolUseId)
  }

  private endTool(callId: string, output: unknown, isError: boolean): void {
    const span = this.tools.get(callId)
    if (!span) return
    this.tools.delete(callId)
    // 流式入参补全：content_block_start 时 input 常为空/缺失，结束时若有累积则合并。
    const buf = this.toolInputBuf.get(callId)
    const inputEmpty =
      span.input === undefined || (typeof span.input === 'object' && Object.keys(span.input as object).length === 0)
    if (buf && inputEmpty) {
      try {
        const parsed = JSON.parse(buf) as unknown
        if (parsed !== null && typeof parsed === 'object' && Object.keys(parsed as object).length > 0) {
          this.pipeline.updateSpan(this.traceId, span, { input: parsed })
        }
      } catch {
        /* 累积片段不完整时保留原始 input */
      }
    }
    this.toolInputBuf.delete(callId)
    this.pipeline.endSpan(this.traceId, span, {
      output,
      status: isError ? 'error' : 'completed'
    })
  }

  /** 累积流式工具入参（input_json_delta），可解析时实时回写 span.input。 */
  private accumulateToolInput(callId: string, partialJson: string): void {
    const span = this.tools.get(callId)
    if (!span) return
    const buf = (this.toolInputBuf.get(callId) ?? '') + partialJson
    this.toolInputBuf.set(callId, buf)
    try {
      const parsed = JSON.parse(buf) as unknown
      if (parsed !== null && typeof parsed === 'object') {
        this.pipeline.updateSpan(this.traceId, span, { input: parsed })
      }
    } catch {
      /* 片段未闭合，继续累积 */
    }
  }

  // === 子任务 ===============================================================

  private onSystem(message: QoderMessage): void {
    const taskId = message.task_id
    if (!taskId) return
    if (message.subtype === 'task_started') {
      // 任务锚点：委派工具的 tool_use_id → task_id（子代理内部消息 parent_tool_use_id 反查用）。
      const delegateToolUseId = readNonEmptyString(message.tool_use_id)
      if (delegateToolUseId) this.taskIdByToolUseId.set(delegateToolUseId, taskId)
      const span = this.pipeline.startSpan(this.traceId, {
        type: 'subtask.run',
        name: message.description || message.task_type || `子任务 ${taskId.slice(0, 8)}`,
        // 父级优先级：嵌套任务（parent_tool_use_id 反查到已有任务）> 委派工具 span > 当前 llm / 锚点。
        parentSpanId:
          this.subtaskSpanIdFor(this.lastParentToolUseId) ??
          (delegateToolUseId ? this.toolSpanByToolUseId.get(delegateToolUseId)?.spanId : undefined) ??
          this.llmSpan?.spanId ??
          this.anchorParent(),
        meta: {
          source: this.source,
          taskId,
          sdkSubtype: 'task_started',
          ...(message.task_type ? { taskType: message.task_type } : {}),
          ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
          // 委派工具 callId：执行面板据此把发起调用的工具行「吸收」进子任务卡，
          // 避免工具行与子任务卡平级展示（task_started.tool_use_id → 主流程 tool.execute）。
          ...(delegateToolUseId ? { toolUseId: delegateToolUseId } : {}),
          // SDK 原始归属原样落 meta（嵌套子代理时指向父级子代理内的委派工具）。
          ...(this.lastParentToolUseId ? { parentToolUseId: this.lastParentToolUseId } : {})
        }
      })
      this.subtasks.set(taskId, span)
      // 注意：task_started 滞后于子代理内部流，早到的内部 span parentSpanId 只是当时锚点；
      // 不再事后改写已落盘 span，渲染层按 meta.parentToolUseId 链重定向归属（旧数据双通路兼容）。
    } else if (message.subtype === 'task_progress') {
      const span = this.subtasks.get(taskId)
      if (!span) return
      this.pipeline.updateSpan(this.traceId, span, {
        meta: {
          ...span.meta,
          sdkSubtype: 'task_progress',
          ...(message.description ? { description: message.description } : {}),
          ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {})
        }
      })
    } else if (message.subtype === 'task_notification') {
      const span = this.subtasks.get(taskId)
      if (!span) return
      this.subtasks.delete(taskId)
      // 子任务收尾时，其在途工具 span 的 tool_result 可能已被 SDK 丢弃（不再送达）：
      // 以 lastMessageAt 兜底收尾（cancelled），避免悬挂到 finish() 产生假时长。
      this.sweepTools((callId) => this.subtaskSpanIdFor(this.toolParents.get(callId)) === span.spanId)
      // 子任务已收尾：清理委派工具 → taskId 注册表，避免 map 随长会话无限增长。
      for (const [toolUseId, registered] of this.taskIdByToolUseId) {
        if (registered === taskId) this.taskIdByToolUseId.delete(toolUseId)
      }
      this.pipeline.endSpan(this.traceId, span, {
        status: message.status === 'success' ? 'completed' : message.status === 'failed' ? 'error' : 'completed',
        meta: {
          ...span.meta,
          sdkSubtype: 'task_notification',
          ...(message.summary ? { summary: message.summary } : {}),
          ...(message.output_file ? { outputFile: message.output_file } : {})
        }
      })
    }
  }

  // === 消息分支 =============================================================

  private onStreamEvent(message: QoderMessage): void {
    const event = message.event
    if (!event) return
    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (delta?.type === 'text_delta' && delta.text) {
        this.ensureLlm(this.modelName)
        this.appendText(delta.text)
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        this.ensureLlm(this.modelName)
        this.appendThinking(delta.thinking)
      } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
        // 工具入参增量：按 block index 反查 callId 后累积（start 时 input 常为空）。
        const callId = event.index !== undefined ? this.toolCallIdByBlockIndex.get(event.index) : undefined
        if (callId) this.accumulateToolInput(callId, delta.partial_json)
      }
    } else if (event.type === 'content_block_start' && event.content_block) {
      const block = event.content_block
      if (block.type === 'tool_use' && block.name) {
        const callId = block.id ?? `qoder-${this.textBuf.length}`
        this.startTool(block.name, block.input, callId, this.lastParentToolUseId)
        // 无论 start 是否已带 input 都注册 index：后续 input_json_delta 一律按 block 配对累积，
        // 避免 SDK 在 start 时给了空对象导致增量入参丢失（工具显示无参数）。
        if (event.index !== undefined) {
          this.toolCallIdByBlockIndex.set(event.index, callId)
          this.toolInputBuf.set(callId, '')
        }
      }
    } else if (event.type === 'error') {
      if (this.llmSpan) {
        const messageText = typeof event.error === 'string' ? event.error : (event.error?.message ?? 'Qoder 流式错误')
        this.endLlm({ status: 'error', error: { message: messageText } })
      }
    }
  }

  private onAssistant(message: QoderMessage): void {
    const content = message.message?.content
    if (!Array.isArray(content)) return
    // 纯 tool_use 回合（无文本/thinking）不建 llm span：这类回合只是工具调用的载体，
    // 建了只会产生 0ms 空记录（历史 trace 里大量无意义 llm 记录的根因）。
    // 流式已开回合（text_delta 创建过 llm）仍在此收尾；工具回合 llmSpan 为空，endLlm 直接跳过。
    const hasTextual = content.some(
      (block) => (block.type === 'text' && block.text) || (block.type === 'thinking' && block.thinking)
    )
    const hasToolBlocks = content.some((block) => block.type === 'tool_use' || block.type === 'tool_result')
    if (hasTextual) this.ensureLlm(this.modelName)
    // SDK 每个 content block 各发一条 assistant 消息（先 thinking 块、后 text 块）：
    // 纯文本/thinking 消息不 endLlm，增量累积进同一 llm span —— 输入/thinking/输出同 span 展示；
    // 仅含 tool_use/tool_result 的消息是 step 边界：先收尾 llm（工具 span 挂刚收尾的 llm）。
    for (const block of content) {
      if (block.type === 'text' && block.text) this.appendText(block.text)
      else if (block.type === 'thinking' && block.thinking) this.appendThinking(block.thinking)
    }
    if (hasToolBlocks) {
      this.endLlm({ usage: usageToSpanUsage(message.message?.usage) })
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          this.startTool(block.name, block.input, block.id ?? '', this.lastParentToolUseId)
        } else if (block.type === 'tool_result') {
          this.endTool(block.tool_use_id ?? '', block.content, block.is_error === true)
        }
      }
    }
  }

  /**
   * user 消息 = 工具结果（assistant 之外的 tool_result 落点，此前缺失导致工具 span 永不收尾）。
   * 主流程的用户文本消息暂存为下一 llm span 的 input（子代理内部 user 消息均为 tool_result，不受影响）。
   */
  private onUser(message: QoderMessage): void {
    const content = message.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type === 'tool_result') {
        this.endTool(block.tool_use_id ?? '', block.content, block.is_error === true)
      } else if (block.type === 'text' && block.text && !this.lastParentToolUseId) {
        this.pendingUserText = block.text
      }
    }
  }

  private onResult(message: QoderMessage): void {
    // SDK result 消息真实形状：result 字段是文本结论，usage/total_cost_usd/modelUsage 在消息顶层。
    // 顶层 usage 缺失时按 modelUsage 分桶求和兜底（含 costUSD）。
    const usage = usageToSpanUsage(message.usage) ?? modelUsageToSpanUsage(message.modelUsage)
    const costUsd = message.total_cost_usd
    if (usage && costUsd) usage.costUsd = costUsd
    // usage 常出现在 result 消息里：llm span 未收尾时直接补录（step 边界收尾过的用 lastLlmSpan 兜底）。
    const target = this.llmSpan ?? this.lastLlmSpan
    if (target && usage) this.pipeline.updateSpan(this.traceId, target, { usage })
    // 会话结果即该 llm 会话结束；回合结束时仍在途的工具 span（tool_result 被 SDK 丢弃）
    // 以 lastMessageAt 兜底收尾，避免悬挂到 finish() 产生假时长。
    this.endLlm()
    this.sweepTools(() => true)
  }

  private onError(message: QoderMessage): void {
    if (this.llmSpan) {
      this.endLlm({ status: 'error', error: { message: message.error ?? 'Qoder SDK 错误' } })
    }
  }
}

/** Qoder usage 字段 → AgentSpanUsage。 */
function usageToSpanUsage(usage: QoderUsage | undefined): AgentSpan['usage'] | undefined {
  if (!usage) return undefined
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  if (input + output + cacheRead + cacheWrite === 0) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite
  }
}

/** result 顶层 usage 缺失时的兜底：modelUsage 按模型分桶求和（含 costUSD 合计）。 */
function modelUsageToSpanUsage(
  modelUsage: Record<string, QoderModelUsage> | undefined
): AgentSpan['usage'] | undefined {
  if (!modelUsage) return undefined
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let costUsd = 0
  for (const bucket of Object.values(modelUsage)) {
    input += bucket.inputTokens ?? 0
    output += bucket.outputTokens ?? 0
    cacheRead += bucket.cacheReadInputTokens ?? 0
    cacheWrite += bucket.cacheCreationInputTokens ?? 0
    costUsd += bucket.costUSD ?? 0
  }
  if (input + output + cacheRead + cacheWrite === 0) return undefined
  const usage: NonNullable<AgentSpan['usage']> = {
    inputTokens: input,
    outputTokens: output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite
  }
  if (costUsd > 0) usage.costUsd = costUsd
  return usage
}
