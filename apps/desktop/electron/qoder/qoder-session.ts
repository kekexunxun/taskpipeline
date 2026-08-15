/**
 * Qoder 常驻会话引擎 — 多轮对话的统一执行底座。
 *
 * 背景:
 *  - 对话板块(QoderChatDriver)与任务板块(QoderTaskAgentDriver)都调 `@qoder-ai/qoder-agent-sdk`
 *    的 `query()`,但此前各自"每次调用新建一个 query + 用 resume 续接",与官方多轮语义
 *    (同一 query 会话内连续送用户消息,见 https://docs.qoder.com/zh/cli/sdk/multi-turn-conversation)
 *    不符:resume 依赖本地 session 文件,`persistSession:false` 时第二轮会因
 *    "Error resuming session" 直接空回复。
 *
 * 设计(官方 TS SDK 多轮方式):
 *  - 每个逻辑会话(conversationId / taskId)常驻一个 `QoderSession`,内部持有唯一的 `query()`;
 *  - 用户消息通过异步输入流(AsyncGenerator<SDKUserMessage>)按顺序送入,输入流在会话 close
 *    前永不结束,因此会话不会自动关闭;
 *  - 消费循环独占 `for await (const msg of query)`(SDK 输出流只能迭代一次),把输出按
 *    "回合"分发:一次 `turn()` 调用 = 一个回合,`result` 消息 = 回合结束;
 *  - 会话控制作为底层能力: `resume`(恢复历史会话)、`interrupt`(停止当前回复、保留会话)、
 *    `close`(结束会话)、`dispose`(应用退出统一清理)。
 */

import { accessToken, query, type Query, type SDKMessage, type SDKUserMessage } from '@qoder-ai/qoder-agent-sdk'
import type { ChatStreamChunk, ChatTaskCreationResult, DriverPart } from '../chat/chat-types.js'
import type { ToolSource } from '../chat/drivers/tool-source.js'

/** SDK query options(用于让会话 options 与 SDK 类型严格对齐)。 */
type SdkQueryOptions = NonNullable<Parameters<typeof query>[0]['options']>
type SdkMcpServers = NonNullable<SdkQueryOptions['mcpServers']>

// === SDK 消息形态(与 qoder-chat-driver 同源) =================================

type SdkContentBlock = {
  type: string
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

export type RawSdkMessage = {
  type?: string
  session_id?: string
  subtype?: string
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
  parent_tool_use_id?: string | null
  event?: {
    type?: string
    delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string }
    content_block?: SdkContentBlock
    index?: number
    error?: { message?: string } | string
  }
  message?: { content?: SdkContentBlock[]; usage?: unknown; parent_tool_use_id?: string | null }
  result?: string | unknown
  error?: string
}

/** 从任意位置读一个非空字符串(避开 SDK 在多处的字段摇移)。 */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 抽取 SDKMessage 上的 parent_tool_use_id(SDK 可能挂在顶层或 message 顶层)。 */
function parentToolUseIdOf(message: RawSdkMessage): string | undefined {
  return readNonEmptyString(message.parent_tool_use_id) ?? readNonEmptyString(message.message?.parent_tool_use_id)
}

// === 回合 =====================================================================

export type QoderTurnStatus = 'active' | 'done' | 'error' | 'aborted' | 'closed'

type ActiveTurn = {
  seq: number
  status: QoderTurnStatus
  error?: unknown
  /** 待消费循环分发给回合调用方的 chunk(part / task-created)。 */
  queue: ChatStreamChunk[]
  /** part 到达 / 状态变化时唤醒回合调用方。 */
  waiters: Array<() => void>
  /** 回合内累积的 parts(跨消息去重 / taskIdByToolUseId 反查用)。 */
  parts: DriverPart[]
  /** 回合级文本 buffer(SDK 文本增量去重,防止 result 与流式文本重复)。 */
  buffer: string
  /** stream block index → toolCallId(input_json_delta 反查 / content_block_stop 兜底落定用)。 */
  toolCallIdByIndex: Map<number, string>
  /** callId → 工具名(stream 阶段暂存,完整入参定型后 push 用)。 */
  toolNameByCallId: Map<string, string>
  /** callId → 已 push 的 tool-use(assistant 快照 / 兜底重复出现时跳过)。 */
  pushedToolUseIds: Set<string>
  /** callId → input_json_delta 累积 JSON 文本(可解析时回填 toolUseInput)。 */
  toolInputBuf: Map<string, string>
  /** callId → 已解析的完整工具入参(start 非空 input / 增量累积 / 快照 input)。 */
  toolUseInput: Map<string, unknown>
  /** 回合内已 push 的 thinking 拼接(完整快照 ⊇ 增量碎片时去重,防思考重复展示)。 */
  thinkingBuffer: string
  /** 已 push 的完整 thinking 块(快照路径;碎片路径据此判断快照已覆盖本段,防重复追加)。 */
  thinkingSnapshots: string[]
  /** 已派发过 task-created(去重:tool_result 与 result 都携带产出时只发一次)。 */
  taskCreated?: boolean
  toolSource?: ToolSource
}

// === 会话 ====================================================================

export type QoderSessionOptions = {
  token: string
  cwd?: string
  additionalDirectories?: string[]
  model?: string
  /** 恢复已有会话(底层能力)。 */
  resume?: string
  permissionMode?: SdkQueryOptions['permissionMode']
  settings?: SdkQueryOptions['settings']
  /** 透传给 SDK 的 hooks(任务板块的 PermissionRequest HITL 等)。 */
  hooks?: SdkQueryOptions['hooks']
  allowedTools?: SdkQueryOptions['allowedTools']
  /** 工具调用 HITL：透传给 SDK 的 canUseTool(对话板块由 driver 注入，缺省不注入)。 */
  canUseTool?: SdkQueryOptions['canUseTool']
  systemPrompt?: SdkQueryOptions['systemPrompt']
  mcpServers?: SdkMcpServers
  allowedMcpServerNames?: SdkQueryOptions['allowedMcpServerNames']
  maxTurns?: SdkQueryOptions['maxTurns']
  controlRequestTimeoutMs?: number
  /** 每条 SDK 消息的回调(任务板块记录日志 / 上报 / 持久化用;对话板块不需要)。 */
  onMessage?: (message: SDKMessage) => void
  /** 会话创建时回调(让上层持有 query 句柄,用于中断/状态探测)。 */
  onQueryStarted?: (query: Query, abort: AbortController) => void
  /** 会话关闭时回调。 */
  onQueryFinished?: (query: Query) => void
}

export type QoderTurnInput = {
  text: string
  toolSource?: ToolSource
  signal?: AbortSignal
}

/**
 * 一个常驻 Qoder 会话。
 *
 * 生命周期:
 *  - 构造:创建 `query()`(输入流为异步用户消息流)+ 启动消费循环;
 *  - `turn()`:一次用户输入,消费到本回合 `result` / `error` / abort;
 *  - `interrupt()`:停止当前回复,保留会话(abort 时由 driver 调用);
 *  - `close()`:结束会话(删除对话 / 任务完成 / 应用退出)。
 */
export class QoderSession {
  readonly id: string

  private readonly query: Query
  private readonly consumer: Promise<void>
  private readonly options: QoderSessionOptions
  private readonly abortController = new AbortController()
  private readonly taskIdByToolUseId = new Map<string, string>()
  private sessionId: string | undefined
  private closed = false
  private turnSeq = 0
  private activeTurn: ActiveTurn | undefined
  /** 回合间隙到达的消息(早于回合开始 / interrupt 残留)。回合开始时重放,避免被丢弃。 */
  private readonly pendingMessages: RawSdkMessage[] = []
  /** 回合前消费循环抛出的错误(竞态:consume 早于回合结束)。回合开始时注入。 */
  private pendingError: unknown
  private readonly inputQueue: SDKUserMessage[] = []
  private readonly inputWaiters: Array<(msg: SDKUserMessage | undefined) => void> = []
  /** HITL 拒绝的工具调用 ID 集合(canUseTool 返回 deny 时写入,handleToolResult 读取后标记 isError)。 */
  readonly deniedCallIds = new Set<string>()

  constructor(id: string, options: QoderSessionOptions) {
    this.id = id
    this.options = options
    this.query = query({
      prompt: this.inputStream(),
      options: {
        auth: accessToken(options.token),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.additionalDirectories && options.additionalDirectories.length
          ? { additionalDirectories: options.additionalDirectories }
          : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.resume ? { resume: options.resume } : {}),
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
        ...(options.hooks ? { hooks: options.hooks } : {}),
        ...(options.allowedTools && options.allowedTools.length ? { allowedTools: options.allowedTools } : {}),
        ...(options.canUseTool ? { canUseTool: options.canUseTool } : {}),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.allowedMcpServerNames && options.allowedMcpServerNames.length
          ? { allowedMcpServerNames: options.allowedMcpServerNames }
          : {}),
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        ...(options.controlRequestTimeoutMs !== undefined
          ? { controlRequestTimeoutMs: options.controlRequestTimeoutMs }
          : {}),
        abortController: this.abortController,
        // 流式输出(打字机效果 / 推理过程 / 工具入参增量)是回合实时转发的基础。
        includePartialMessages: true
      }
    })
    this.consumer = this.consume()
    this.options.onQueryStarted?.(this.query, this.abortController)
  }

  /** 已恢复 / 已捕获的 sessionId(resume 的锚点)。 */
  getSessionId(): string | undefined {
    return this.sessionId
  }

  /**
   * 执行一个回合:入队用户消息,实时 yield 本回合输出,直到回合结束 / abort / 错误。
   * 回合结束后会话保留,可继续 `turn()` —— 这是"多轮对话作为执行引擎"的核心。
   */
  async *turn(input: QoderTurnInput): AsyncGenerator<ChatStreamChunk> {
    if (this.closed) throw new Error('Qoder 会话已关闭')
    if (this.activeTurn && this.activeTurn.status === 'active') {
      throw new Error('Qoder 会话已有进行中的回合')
    }
    const turn: ActiveTurn = {
      seq: ++this.turnSeq,
      status: 'active',
      queue: [],
      waiters: [],
      parts: [],
      buffer: '',
      toolCallIdByIndex: new Map(),
      toolNameByCallId: new Map(),
      pushedToolUseIds: new Set(),
      toolInputBuf: new Map(),
      toolUseInput: new Map(),
      thinkingBuffer: '',
      thinkingSnapshots: [],
      toolSource: input.toolSource
    }
    this.activeTurn = turn
    // 竞态兜底:消费循环在回合开始前就已报错 → 注入本回合(原样上抛,保留错误类型)。
    if (this.pendingError !== undefined) {
      const error = this.pendingError
      this.pendingError = undefined
      turn.status = 'error'
      turn.error = error
      this.wakeTurn(turn)
    }
    // 重放回合间隙缓冲的消息(会话元信息 / 残留 part / 竞态时提前到达的回合完整输出)。
    // 不过滤 result/error:竞态下消费循环可能抢先把本回合输出(含 result)全部缓冲,
    // 过滤 result 会导致回合永不结束;result/error 由 handleMessage 自然收尾。
    const buffered = this.pendingMessages.splice(0)
    for (const message of buffered) {
      this.handleMessage(message, turn)
    }
    this.pushUserMessage(input.text)
    try {
      while (true) {
        // 先 drain 队列:回合结束(result)后可能还有已入队未 yield 的 part,不能丢。
        if (turn.queue.length) {
          yield turn.queue.shift()!
          continue
        }
        if (input.signal?.aborted) {
          turn.status = 'aborted'
          break
        }
        if (turn.status === 'done' || turn.status === 'closed') break
        if (turn.status === 'error') {
          // 原样抛原始错误(如 QoderCliProcessError),让上层能做 stderr 增强。
          throw turn.error instanceof Error
            ? turn.error
            : new Error(turn.error !== undefined ? String(turn.error) : 'Qoder SDK 错误')
        }
        // 队列空且回合仍 active:挂起,等消费循环推 chunk / 改状态后唤醒;
        // 同时监听 abort —— 否则 abort/interrupt 后若 SDK 不再产出消息,回合会永久挂起。
        const onAbort = () => this.wakeTurn(turn)
        input.signal?.addEventListener('abort', onAbort, { once: true })
        await new Promise<void>((resolve) => turn.waiters.push(resolve))
        input.signal?.removeEventListener('abort', onAbort)
      }
    } finally {
      if (this.activeTurn === turn) this.activeTurn = undefined
    }
    if (turn.status === 'aborted') await this.interrupt()
  }

  /** 停止当前回复,保留会话(后续仍可 turn())。 */
  async interrupt(): Promise<void> {
    try {
      await this.query.interrupt()
    } catch {
      /* may already be interrupted / closed */
    }
  }

  /** 结束会话:关闭 query、唤醒所有挂起等待。关闭带超时保护,避免 qodercli 子进程异常时悬挂。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const resolve of this.inputWaiters.splice(0)) resolve(undefined)
    if (this.activeTurn) {
      this.activeTurn.status = 'closed'
      this.wakeTurn(this.activeTurn)
    }
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    const closed = await Promise.race([
      this.query
        .close()
        .then(() => true)
        .catch(() => true),
      new Promise<false>((resolve) => {
        closeTimer = setTimeout(() => resolve(false), 5_000)
      })
    ])
    if (closeTimer) clearTimeout(closeTimer)
    if (!closed) {
      console.warn(`[qoder-session] close() 超时(5s):会话 ${this.id} 的 qodercli 进程可能未完全回收`)
    }
    this.options.onQueryFinished?.(this.query)
  }

  // === 内部 ==================================================================

  /** 异步用户消息流:close 前永不结束(会话不自动关闭),消息从队列取。 */
  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = await this.nextInput()
      if (next === undefined) return
      yield next
    }
  }

  private async nextInput(): Promise<SDKUserMessage | undefined> {
    const queued = this.inputQueue.shift()
    if (queued) return queued
    if (this.closed) return undefined
    return new Promise<SDKUserMessage | undefined>((resolve) => this.inputWaiters.push(resolve))
  }

  private pushUserMessage(text: string): void {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null
    }
    const waiter = this.inputWaiters.shift()
    if (waiter) waiter(message)
    else this.inputQueue.push(message)
  }

  private wakeTurn(turn: ActiveTurn): void {
    for (const waiter of turn.waiters.splice(0)) waiter()
  }

  private pushChunk(turn: ActiveTurn, chunk: ChatStreamChunk): void {
    turn.queue.push(chunk)
    this.wakeTurn(turn)
  }

  /** 消费循环:独占 query 输出,把消息转成 chunk 分发给当前回合。 */
  private async consume(): Promise<void> {
    try {
      for await (const raw of this.query) {
        const message = raw as SDKMessage
        this.options.onMessage?.(message)
        const turn = this.activeTurn
        if (!turn || turn.status !== 'active') {
          // 无活跃回合:缓冲,回合开始时重放(竞态/残留消息不丢失)。
          this.pendingMessages.push(message as RawSdkMessage)
          continue
        }
        this.handleMessage(message as RawSdkMessage, turn)
      }
    } catch (error) {
      const turn = this.activeTurn
      if (turn && turn.status === 'active') {
        turn.status = 'error'
        turn.error = error
        this.wakeTurn(turn)
      } else {
        // 回合尚未开始就出错:保留,回合开始时注入。
        this.pendingError = error
      }
    }
    // query 流结束(close / CLI 进程退出 / resume 失败):结束当前回合。
    this.failTurn(new Error('Qoder 会话已结束'))
  }

  private failTurn(error: unknown): void {
    const turn = this.activeTurn
    if (!turn || turn.status !== 'active') return
    turn.status = 'error'
    turn.error = error
    this.wakeTurn(turn)
  }

  /**
   * 把一条 SDKMessage 解析成 chunk 推入当前回合(解析逻辑自 qoder-chat-driver 搬迁)。
   * - `yield` 语义 → `pushChunk`;
   * - `throw` 语义 → failTurn(错误一律上抛,已产出的 parts 由上层保留展示)。
   */
  private handleMessage(message: RawSdkMessage, turn: ActiveTurn): void {
    const parentTaskId = this.resolveParentTaskId(message)
    const pushPart = (part: DriverPart): DriverPart => {
      const stamped: DriverPart = parentTaskId ? ({ ...part, parentTaskId } as DriverPart) : part
      turn.parts.push(stamped)
      this.pushChunk(turn, { type: 'part', part: stamped })
      return stamped
    }

    /**
     * thinking 增量去重 push:已 push 的拼接已覆盖本段则跳过,修复「thinking_delta 碎片 +
     * content_block_start 完整块 + assistant 完整块」三路径重复展示同一思考的问题。
     * - 碎片(thinking_delta)判据用「拼接以本段结尾」:增量是继续追加的 token,`includes`
     *   会把此前已出现过的短 token(如单字「析」)误判为重复而吞字符;
     * - 完整块(content_block_start / assistant 快照)判据用「拼接包含本段」:整段已在
     *   碎片拼接中出现(快照 ⊇ 增量)则跳过,不再重复推入。
     */
    const pushThinking = (text: string, signature?: string, isSnapshot = false): void => {
      if (!text) return
      if (isSnapshot) {
        // 完整块(content_block_start / assistant 快照):整段已在拼接中出现则跳过。
        if (turn.thinkingBuffer.includes(text)) return
      } else {
        // 碎片(thinking_delta):增量是续写追加,用「拼接以本段结尾」判断 —— `includes`
        // 会把此前已出现过的短 token(如单字「析」)误判为重复而吞字符。
        if (turn.thinkingBuffer.endsWith(text)) return
        // 完整快照先到(如 content_block_start 直接带整段)后,碎片若已被快照覆盖则跳过,
        // 避免「快照 + 碎片化 delta」把同一思考逐个重复追加。
        if (turn.thinkingSnapshots.some((snapshot) => snapshot.includes(text))) return
      }
      turn.thinkingBuffer += text
      if (isSnapshot) turn.thinkingSnapshots.push(text)
      pushPart({
        driverId: 'qoder',
        type: 'qoder.thinking',
        text,
        ...(signature ? { signature } : {})
      })
    }

    /** 累积流式工具入参增量(input_json_delta),可解析时回填 toolUseInput。 */
    const accumulateToolInput = (callId: string, partialJson: string): void => {
      const buf = (turn.toolInputBuf.get(callId) ?? '') + partialJson
      turn.toolInputBuf.set(callId, buf)
      try {
        const parsed = JSON.parse(buf) as unknown
        if (parsed !== null && typeof parsed === 'object' && Object.keys(parsed as object).length > 0) {
          turn.toolUseInput.set(callId, parsed)
        }
      } catch {
        /* 片段未闭合,继续累积 */
      }
    }

    /**
     * tool_use 落定 push:输入取「调用方传入(assistant 快照,优先)或累积解析值」,同 callId 只
     * push 一次。stream 阶段不 push(SDK 的 content_block_start 常带空 input),完整入参由
     * input_json_delta 累积、assistant 快照 / 工具结束 / content_block_stop 兜底落定。
     * 注意:SDK 的 input 可能为 null(Anthropic 协议允许),必须显式排除 —— `Object.keys(null)`
     * 会抛 TypeError,而 handleMessage 内抛异常会中断 consume 循环,后续 SDK 消息不再喂给
     * onMessage(trace 采集)与 handleMessage,表现为「对话还在,Trace 没数据」。
     */
    const flushToolUse = (callId: string, name?: string, input?: unknown): void => {
      if (turn.pushedToolUseIds.has(callId)) return
      const finalName = name ?? turn.toolNameByCallId.get(callId)
      if (!finalName) return // 名字都未知(纯孤儿 tool_result),不强行造行
      turn.pushedToolUseIds.add(callId)
      const finalInput =
        input !== null && input !== undefined && typeof input === 'object' && Object.keys(input as object).length > 0
          ? input
          : (turn.toolUseInput.get(callId) ?? input ?? {})
      turn.toolUseInput.delete(callId)
      turn.toolInputBuf.delete(callId)
      pushPart({ driverId: 'qoder', type: 'qoder.tool-use', toolCallId: callId, name: finalName, input: finalInput })
    }

    /** tool_result 处理(assistant 与 user 消息共用):配对 tool-use、产出输出、触发 task-created。 */
    const handleToolResult = (block: SdkContentBlock): void => {
      const toolCallId = typeof block.tool_use_id === 'string' ? block.tool_use_id : `qoder-${turn.parts.length}`
      // 兜底:SDK 异常顺序(tool_result 先于 assistant 快照)时,先用已累积信息补 tool-use 行,
      // 保证按 callId 配对不丢、输出能并入工具行展示。
      flushToolUse(toolCallId)
      const output = block.content
      const toolResultPart: DriverPart = {
        driverId: 'qoder',
        type: 'qoder.tool-result',
        toolCallId,
        output,
        ...(block.is_error ? { isError: true } : {}),
        // HITL 拒绝:canUseTool 返回 deny 时 SDK 不一定设 is_error,由 deniedCallIds 补标。
        ...(this.deniedCallIds.has(toolCallId) ? { isError: true } : {})
      }
      turn.parts.push(toolResultPart)
      // 已消费,清理(避免跨回合内存泄漏)。
      this.deniedCallIds.delete(toolCallId)
      this.pushChunk(turn, { type: 'part', part: toolResultPart })
      if (turn.toolSource && !turn.taskCreated) {
        const described = turn.toolSource.describeResult(output)
        if (described) {
          turn.taskCreated = true
          this.pushChunk(turn, { type: 'task-created', result: described as ChatTaskCreationResult })
        }
      }
    }

    if (typeof message.session_id === 'string' && message.session_id && message.session_id !== this.sessionId) {
      this.sessionId = message.session_id
      const sessionPart: DriverPart = { driverId: 'qoder', type: 'qoder.session', sessionId: message.session_id }
      turn.parts.push(sessionPart)
      this.pushChunk(turn, { type: 'part', part: sessionPart })
    }

    if (message.type === 'system') {
      if (message.subtype === 'task_started' && message.task_id) {
        const toolUseId = readNonEmptyString(message.tool_use_id)
        if (toolUseId) this.taskIdByToolUseId.set(toolUseId, message.task_id)
        const startPart: DriverPart = {
          driverId: 'qoder',
          type: 'qoder.subtask-start',
          taskId: message.task_id,
          parentTaskId: message.task_id,
          ...(readNonEmptyString(message.task_type) ? { taskType: message.task_type } : {}),
          ...(readNonEmptyString(message.subagent_type) ? { subagentType: message.subagent_type } : {}),
          ...(readNonEmptyString(message.description) ? { description: message.description } : {}),
          ...(toolUseId ? { toolUseId } : {})
        }
        turn.parts.push(startPart)
        this.pushChunk(turn, { type: 'part', part: startPart })
      } else if (message.subtype === 'task_progress' && message.task_id) {
        const progressPart: DriverPart = {
          driverId: 'qoder',
          type: 'qoder.subtask-progress',
          taskId: message.task_id,
          parentTaskId: message.task_id,
          ...(readNonEmptyString(message.description) ? { description: message.description } : {}),
          ...(readNonEmptyString(message.last_tool_name) ? { lastToolName: message.last_tool_name } : {}),
          ...(message.usage ? { usage: message.usage } : {})
        }
        turn.parts.push(progressPart)
        this.pushChunk(turn, { type: 'part', part: progressPart })
      } else if (message.subtype === 'task_notification' && message.task_id) {
        const status = readNonEmptyString(message.status) ?? 'unknown'
        const endPart: DriverPart = {
          driverId: 'qoder',
          type: 'qoder.subtask-end',
          taskId: message.task_id,
          parentTaskId: message.task_id,
          status,
          ...(readNonEmptyString(message.summary) ? { summary: message.summary } : {}),
          ...(readNonEmptyString(message.output_file) ? { outputFile: message.output_file } : {}),
          ...(message.usage ? { usage: message.usage } : {})
        }
        turn.parts.push(endPart)
        this.pushChunk(turn, { type: 'part', part: endPart })
      }
      return
    }

    if (message.type === 'stream_event') {
      const event = message.event
      if (event?.type === 'content_block_delta') {
        const delta = event.delta
        if (delta?.type === 'text_delta' && delta.text) {
          turn.buffer += delta.text
          pushPart({ driverId: 'qoder', type: 'text', text: delta.text })
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          pushThinking(delta.thinking, delta.signature)
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          // 工具入参增量:按 block index 反查 callId 后累积(stream 阶段 tool_use 不 push,
          // 完整入参由 input_json_delta 累积、assistant 快照 / 工具结束时定型)。
          const callId = event.index !== undefined ? turn.toolCallIdByIndex.get(event.index) : undefined
          if (callId) accumulateToolInput(callId, delta.partial_json)
        }
      } else if (event?.type === 'content_block_start' && event.content_block) {
        const block = event.content_block
        if (block.type === 'text' && block.text) {
          turn.buffer += block.text
          pushPart({ driverId: 'qoder', type: 'text', text: block.text })
        } else if (block.type === 'thinking' && block.thinking) {
          // content_block_start 的 thinking 是整块(可能部分):按快照判据去重。
          pushThinking(block.thinking, undefined, true)
        } else if (block.type === 'tool_use' && block.name) {
          const toolCallId = typeof block.id === 'string' ? block.id : `qoder-${event.index ?? turn.parts.length}`
          if (event.index !== undefined) turn.toolCallIdByIndex.set(event.index, toolCallId)
          turn.toolNameByCallId.set(toolCallId, block.name)
          turn.toolInputBuf.set(toolCallId, '')
          // 不在此 push:SDK 的 start 事件 input 常为空,真实入参由 input_json_delta 增量
          // 累积、assistant 完整快照定型 —— 提前 push 会让 ToolCallRow 只显示 {}。
          if (block.input && typeof block.input === 'object' && Object.keys(block.input as object).length > 0) {
            turn.toolUseInput.set(toolCallId, block.input)
          }
        }
      } else if (event?.type === 'content_block_stop') {
        // 兜底:块结束仍无 assistant 快照(中断等)时,把已累积的 tool_use 落定,避免工具调用丢失。
        // 仅当累积入参已可解析(toolUseInput 有值)才落定:未闭合/无入参时等快照提供完整 input,
        // 避免抢先 push 空 input 后快照因去重被跳过、工具调用永远显示 {}。
        const callId = event.index !== undefined ? turn.toolCallIdByIndex.get(event.index) : undefined
        if (callId && turn.toolUseInput.has(callId)) flushToolUse(callId)
      } else if (event?.type === 'error') {
        // 错误一律上抛:已有部分文本产出时也 failTurn,已产出的 parts 早已随流事件
        // 推给上层(ChatService 累积并落盘),不会丢;吞掉错误会导致失败界面无任何展示。
        const errorText = typeof event.error === 'string' ? event.error : (event.error?.message ?? 'Qoder SDK 流式错误')
        turn.status = 'error'
        turn.error = errorText
        this.wakeTurn(turn)
      }
      return
    }

    if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          if (!turn.buffer.includes(block.text)) {
            turn.buffer += block.text
            pushPart({ driverId: 'qoder', type: 'text', text: block.text })
          }
        } else if (block.type === 'tool_use' && block.name) {
          const toolCallId = typeof block.id === 'string' ? block.id : `qoder-${turn.parts.length}`
          // 完整快照带真实 input:与流式累积的同一 callId 合并定型(同 callId 只 push 一次)。
          flushToolUse(toolCallId, block.name, block.input)
        } else if (block.type === 'tool_result') {
          handleToolResult(block)
        } else if (block.type === 'thinking' && block.thinking) {
          // 完整快照 vs 流式碎片:已推拼接已覆盖(或包含)则跳过,防止思考重复展示。
          pushThinking(block.thinking, undefined, true)
        }
      }
      return
    }

    if (message.type === 'user' && Array.isArray(message.message?.content)) {
      // SDK 的工具输出(tool_result)主要落在 user 消息里(assistant 之外的落点,此前缺失
      // 导致工具调用只有输入没有输出)。用户文本是回合输入,不在此处理。
      for (const block of message.message.content) {
        if (block.type === 'tool_result') {
          handleToolResult(block)
        }
      }
      return
    }

    if (message.type === 'result') {
      const resultText = typeof message.result === 'string' ? message.result : ''
      if (resultText && !turn.buffer.includes(resultText)) {
        const extra = resultText.startsWith(turn.buffer) ? resultText.slice(turn.buffer.length) : resultText
        turn.buffer += extra
        if (extra) pushPart({ driverId: 'qoder', type: 'text', text: extra })
      }
      if (turn.toolSource && !turn.taskCreated) {
        const described = turn.toolSource.describeResult(message.result)
        if (described) {
          turn.taskCreated = true
          this.pushChunk(turn, { type: 'task-created', result: described as ChatTaskCreationResult })
        }
      }
      turn.status = 'done'
      this.wakeTurn(turn)
      return
    }

    if (message.type === 'error') {
      // 与 stream_event error 同语义:不再按「是否已有文本产出」门控,失败必须可见。
      turn.status = 'error'
      turn.error = message.error ?? 'Qoder SDK 错误'
      this.wakeTurn(turn)
    }
  }

  /** 根据 parent_tool_use_id 反查当前消息所属子任务(undefined = 主流程)。 */
  private resolveParentTaskId(message: RawSdkMessage): string | undefined {
    const parent = parentToolUseIdOf(message)
    return parent ? this.taskIdByToolUseId.get(parent) : undefined
  }
}

// === 注册表 ==================================================================

/**
 * 会话注册表:按 conversationId / taskId 持有常驻会话。
 * 对话板块与任务板块各自持有一个实例,互不干扰。
 */
export class QoderSessionRegistry {
  private readonly sessions = new Map<string, QoderSession>()

  get(id: string): QoderSession | undefined {
    return this.sessions.get(id)
  }

  /** 创建会话并登记(幂等:已存在则直接返回)。 */
  register(id: string, session: QoderSession): QoderSession {
    const existing = this.sessions.get(id)
    if (existing) {
      void session.close()
      return existing
    }
    this.sessions.set(id, session)
    return session
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await session.close()
  }

  async dispose(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((session) => session.close().catch(() => undefined)))
  }
}
