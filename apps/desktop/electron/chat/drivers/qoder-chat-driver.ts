/**
 * Qoder Chat Driver — ChatDriver 的 Qoder SDK 实现。
 *
 * 职责(全部封在本文件内):
 *  - listModels: 通过 getQoderStatus 回调拿到 Qoder runtime 的可用模型;
 *  - streamChat: 调 `@qoder-ai/qoder-agent-sdk` 的 `query()`,把 SDKMessage 流拆成
 *    DriverPart (text / qoder.thinking / qoder.tool-use / qoder.tool-result / qoder.session);
 *  - 工具注入:把 `ToolSource` 翻译成 Qoder MCP server (`qoderTool + createSdkMcpServer`);
 *  - 任务已创建:每次 tool 执行后调 `ToolSource.describeResult(output)`,有结果就调
 *    `onTaskCreated` 回调 (并 emit qoder.tool-result part);
 *  - 持久化:raw 字段存 SDK 自己的"原样"消息列表(由 driver 内部累积,流结束一次性 dump)。
 *
 * 上层 (ChatService) 完全不感知 SDK 协议。
 */

import {
  accessToken,
  createSdkMcpServer,
  query,
  tool as qoderTool,
  type Query,
  type SdkMcpToolDefinition
} from '@qoder-ai/qoder-agent-sdk'
import type { z } from 'zod'
import type {
  ChatMessageMetadata,
  ChatModelInfo,
  ChatStreamChunk,
  ChatTaskCreationResult,
  DriverPart,
  StoredMessage,
  StoredMessageRecord
} from '../chat-types.js'
import type { ChatDriver, StreamChatInput } from './chat-driver.js'
import type { ToolSource } from './tool-source.js'

type QoderStatus = {
  enabled: boolean
  connected: boolean
  running: boolean
  models: Array<
    Pick<ChatModelInfo, 'value' | 'displayName'> & {
      isDefault?: boolean
      isReasoning?: boolean
      isVl?: boolean
      priceFactor?: number
    }
  >
}

type QoderTokenProvider = () => string | undefined

type QoderStatusProvider = () => Promise<QoderStatus>

/**
 * Qoder driver 自己的 raw 形态(给存储层用):
 *  - 用户消息: `{ kind: "user", text: string }`;
 *  - 助手消息: `{ kind: "assistant", parts: { type, ... }[], sessionId?: string }` —— parts 与
 *    DriverPart 完全一致,driver 加载时直接透传;
 *  - 系统消息: `{ kind: "system", text: string }` (memory context 等)。
 */
type QoderRawMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; parts: DriverPart[]; sessionId?: string }
  | { kind: 'system'; text: string }

function emptyParts(): DriverPart[] {
  return []
}

function rawToParts(raw: unknown): DriverPart[] {
  if (!raw || typeof raw !== 'object') return emptyParts()
  const record = raw as QoderRawMessage
  if (record.kind === 'user' || record.kind === 'system')
    return [{ driverId: 'qoder', type: 'text', text: record.text }]
  if (record.kind === 'assistant' && Array.isArray(record.parts)) return record.parts
  return emptyParts()
}

function partToText(part: DriverPart): string {
  if (part.type === 'text') return part.text
  if (part.type === 'qoder.thinking') return part.text
  return ''
}

/**
 * 把 ToolDeclaration[] 翻译成 Qoder MCP server。
 *  - `qoderTool(name, description, shape, execute, opts)` 直接吃单层 zod 字段;
 *  - `permissionPolicy: "always_allow"` 让工具不被 Qoder 权限检查拦截(任务创建工具不在 CLI 上下文内);
 *  - `modelToolResult` 把 execute 结果包成 MCP 标准 `CallToolResult` 形态。
 */
function buildTaskCreationMcp(source: ToolSource): {
  server: ReturnType<typeof createSdkMcpServer>
  toolNames: string[]
} {
  const declarations = source.tools()
  if (declarations.length === 0) {
    return { server: createSdkMcpServer({ name: 'task-creation', version: '1.0.0', tools: [] }), toolNames: [] }
  }
  const tools: SdkMcpToolDefinition<any>[] = declarations.map((decl) => {
    const annotations = decl.annotations ?? {}
    const mcpAnnotations: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } = {}
    if (annotations.readOnlyHint) mcpAnnotations.readOnlyHint = true
    if (annotations.destructiveHint) mcpAnnotations.destructiveHint = true
    if (annotations.openWorldHint) mcpAnnotations.openWorldHint = true
    return qoderTool(
      decl.name,
      decl.description,
      decl.schema as Record<string, z.ZodTypeAny>,
      async (input: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(await decl.execute(input)) }]
      }),
      { annotations: mcpAnnotations, permissionPolicy: 'always_allow' }
    )
  })
  return {
    server: createSdkMcpServer({ name: 'task-creation', version: '1.0.0', tools }),
    toolNames: declarations.map((decl) => `mcp__task_creation__${decl.name}`)
  }
}

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

type RawSdkMessage = {
  type?: string
  session_id?: string
  subtype?: string
  /** 子任务关联字段(仅 task_started / task_progress / task_notification 携带)。 */
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
  /** Qoder SDK 在每条消息上携带该字段,标识该消息属于哪个父级 tool_use —— 顶层为 null/缺失。 */
  parent_tool_use_id?: string | null
  event?: {
    type?: string
    delta?: { type?: string; text?: string; thinking?: string; signature?: string }
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

/**
 * Qoder Chat Driver。
 */
export class QoderChatDriver implements ChatDriver {
  readonly id = 'qoder' as const
  readonly displayName = 'Qoder Agent SDK'

  private activeQuery: Query | undefined
  /**
   * `tool_use_id -> task_id` 映射,跨单次 `streamChat` 调用的 SDKMessage 累积。
   *
   * - 写入:遇到 `system / task_started` 时,以其 `tool_use_id -> task_id` 写一项。
   * - 读取:其它消息的 `parent_tool_use_id` 反查。命中后挂到 emit 的 part 上,作为
   *   PartRenderer 拆"主流程 vs 子任务"的唯一依据。
   * - 不跨 streamChat 调用保留(每次开始都重置),避免历史 tool_use_id 污染新会话。
   */
  private taskIdByToolUseId = new Map<string, string>()

  constructor(
    private readonly tokenProvider: QoderTokenProvider,
    private readonly statusProvider: QoderStatusProvider
  ) {
    if (!tokenProvider) throw new Error('QoderChatDriver requires a token provider')
    if (!statusProvider) throw new Error('QoderChatDriver requires a status provider')
  }

  async listModels(): Promise<ChatModelInfo[]> {
    try {
      const status = await this.statusProvider()
      if (!status.enabled || !status.connected) return []
      return status.models.map((model) => ({
        value: `qoder:${model.value}`,
        displayName: model.displayName,
        isDefault: model.isDefault,
        isReasoning: model.isReasoning,
        isVl: model.isVl,
        priceFactor: model.priceFactor
      }))
    } catch {
      return []
    }
  }

  serializeUserMessage(input: { id: string; text: string; createdAt: string }): StoredMessageRecord {
    return {
      id: input.id,
      role: 'user',
      createdAt: input.createdAt,
      driverId: 'qoder',
      raw: { kind: 'user', text: input.text } satisfies QoderRawMessage
    }
  }

  serializeAssistantMessage(input: {
    id: string
    parts: DriverPart[]
    createdAt: string
    sessionId?: string
  }): StoredMessageRecord {
    return {
      id: input.id,
      role: 'assistant',
      createdAt: input.createdAt,
      driverId: 'qoder',
      raw: {
        kind: 'assistant',
        parts: input.parts,
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      } satisfies QoderRawMessage
    }
  }

  deserializeMessage(record: StoredMessageRecord): StoredMessage {
    return { ...record, parts: rawToParts(record.raw) }
  }

  async *streamChat(input: StreamChatInput): AsyncGenerator<ChatStreamChunk> {
    const token = this.tokenProvider()
    if (!token) throw new Error('请先在设置中配置 Qoder Token')

    // 续接:从 history 末尾找最后一个 qoder.session part,取其 sessionId 传 SDK resume。
    // server-side session 包含该 session 所在 assistant message 及其之后所有内容,
    // 所以拼 prompt 时从该 message 之前开始,避免重复。SDK 会用 server 端历史补齐。
    const { resume, remaining } = this.extractResumeContext(input.history)
    const prompt = this.buildPrompt(remaining, input.userInput.text)

    // driver 内部累积 parts;流结束一次性 emit assistant StoredMessage(raw) 的 part。
    // 这里我们边流边 emit part 到 ChatService,ChatService 自己累积存储形态。
    const internalAbort = new AbortController()
    const onParentAbort = () => internalAbort.abort(input.signal.reason)
    input.signal.addEventListener('abort', onParentAbort, { once: true })

    const taskSource = input.toolSource
    const mcpSetup = taskSource ? buildTaskCreationMcp(taskSource) : undefined

    // 每次新的对话回合重置子任务映射 —— 避免历史 tool_use_id 污染新会话。
    // 与 CodingPage 那边的 recordQoderSubtaskCtx(进程级)是两条独立路径,这里只在 chat
    // 流式期间累积,不跨 streamChat 复用。
    this.taskIdByToolUseId = new Map()
    /** 根据 parent_tool_use_id 反查当前消息所属子任务(undefined = 主流程)。 */
    const resolveParentTaskId = (message: RawSdkMessage): string | undefined => {
      const parent = parentToolUseIdOf(message)
      return parent ? this.taskIdByToolUseId.get(parent) : undefined
    }

    // 收集所有 emit 过的 part,流结束后 driver 还要把 assistant 消息的 raw 形态告诉上层;
    // 但因为持久化发生在 ChatService 端,driver 只需要逐 part emit,ChatService 自己拼 raw。
    const parts: DriverPart[] = []
    let captured = false
    let sessionId: string | undefined
    let buffer = ''
    let taskCreated: ChatTaskCreationResult | undefined

    const qoderSession = query({
      prompt,
      options: {
        auth: accessToken(token),
        cwd: process.cwd(),
        abortController: internalAbort,
        persistSession: false,
        permissionMode: 'default',
        controlRequestTimeoutMs: 15_000,
        model: input.model.startsWith('qoder:') ? input.model.slice(6) : input.model,
        ...(resume ? { resume } : {}),
        ...(taskSource && mcpSetup
          ? {
              systemPrompt: taskSource.systemPrompt(),
              tools: [],
              mcpServers: { task_creation: mcpSetup.server },
              allowedMcpServerNames: ['task_creation'],
              allowedTools: mcpSetup.toolNames,
              maxTurns: 10
            }
          : {})
      }
    })
    this.activeQuery = qoderSession

    try {
      for await (const raw of qoderSession) {
        if (input.signal.aborted) return
        const message = raw as RawSdkMessage
        const parentTaskId = resolveParentTaskId(message)
        /**
         * 给 part 附上当前消息反查出的 parentTaskId 并 push 到 parts 缓存,返回 part 让 caller yield。
         * yield 不能封进普通函数(generator 只能在自己体内 yield),所以 caller 必须自己 `yield`。
         */
        const pushPart = (part: DriverPart): DriverPart => {
          const stamped: DriverPart = parentTaskId ? ({ ...part, parentTaskId } as DriverPart) : part
          parts.push(stamped)
          return stamped
        }
        if (typeof message.session_id === 'string' && message.session_id && message.session_id !== sessionId) {
          sessionId = message.session_id
          // session id 是个跨消息元信息,不属于主流程 / 子任务的某条 —— 不挂 parentTaskId。
          parts.push({ driverId: 'qoder', type: 'qoder.session', sessionId })
          yield { type: 'part', part: { driverId: 'qoder', type: 'qoder.session', sessionId } }
        }
        if (message.type === 'system') {
          // 子任务三类系统消息独立成 part,UI 负责拆主流程 / 折叠卡:
          //  - task_started: 子任务起点 → 折叠卡 header(taskType / description)
          //  - task_progress: 过程态(SDK 会发多次)→ UI 选择性聚合 / 展示
          //  - task_notification: 收尾 → status / summary,负责关闭折叠卡 + 状态徽章
          // 三个 part 都以 taskId 自指 parentTaskId(它本身就属于该子任务),groupByParentTask 据此
          // 把 subtask-start 识别为 group header(因为 taskId === parent),其它两个进入 children。
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
            parts.push(startPart)
            yield { type: 'part', part: startPart }
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
            parts.push(progressPart)
            yield { type: 'part', part: progressPart }
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
            parts.push(endPart)
            yield { type: 'part', part: endPart }
          }
        }
        if (message.type === 'stream_event') {
          const event = message.event
          if (event?.type === 'content_block_delta') {
            const delta = event.delta
            if (delta?.type === 'text_delta' && delta.text) {
              buffer += delta.text
              yield { type: 'part', part: pushPart({ driverId: 'qoder', type: 'text', text: delta.text }) }
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
              const stamped = pushPart({
                driverId: 'qoder',
                type: 'qoder.thinking',
                text: delta.thinking,
                ...(delta.signature ? { signature: delta.signature } : {})
              })
              yield { type: 'part', part: stamped }
            }
          } else if (event?.type === 'content_block_start' && event.content_block) {
            const block = event.content_block
            if (block.type === 'text' && block.text) {
              buffer += block.text
              yield { type: 'part', part: pushPart({ driverId: 'qoder', type: 'text', text: block.text }) }
            } else if (block.type === 'thinking' && block.thinking) {
              yield {
                type: 'part',
                part: pushPart({ driverId: 'qoder', type: 'qoder.thinking', text: block.thinking })
              }
            } else if (block.type === 'tool_use' && block.name) {
              const toolCallId = typeof block.id === 'string' ? block.id : `qoder-${parts.length}`
              yield {
                type: 'part',
                part: pushPart({
                  driverId: 'qoder',
                  type: 'qoder.tool-use',
                  toolCallId,
                  name: block.name,
                  input: block.input ?? {}
                })
              }
            }
          } else if (event?.type === 'content_block_stop' || event?.type === 'message_stop') {
            captured = true
          } else if (event?.type === 'error' && !buffer) {
            const errorText =
              typeof event.error === 'string' ? event.error : (event.error?.message ?? 'Qoder SDK 流式错误')
            throw new Error(errorText)
          }
        } else if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text) {
              if (!buffer.includes(block.text)) {
                buffer += block.text
                yield { type: 'part', part: pushPart({ driverId: 'qoder', type: 'text', text: block.text }) }
              }
            } else if (block.type === 'tool_use' && block.name) {
              const toolCallId = typeof block.id === 'string' ? block.id : `qoder-${parts.length}`
              const toolUsePart: DriverPart = {
                driverId: 'qoder',
                type: 'qoder.tool-use',
                toolCallId,
                name: block.name,
                input: block.input ?? {}
              }
              if (!parts.some((existing) => existing.type === 'qoder.tool-use' && existing.toolCallId === toolCallId)) {
                yield { type: 'part', part: pushPart(toolUsePart) }
              }
            } else if (block.type === 'tool_result') {
              const toolCallId = typeof block.tool_use_id === 'string' ? block.tool_use_id : `qoder-${parts.length}`
              const output = block.content
              const toolResultPart: DriverPart = {
                driverId: 'qoder',
                type: 'qoder.tool-result',
                toolCallId,
                output,
                ...(block.is_error ? { isError: true } : {})
              }
              yield { type: 'part', part: pushPart(toolResultPart) }
              if (taskSource) {
                const described = taskSource.describeResult(output)
                if (described && !taskCreated) {
                  taskCreated = described
                  yield { type: 'task-created', result: described }
                }
              }
            } else if (block.type === 'thinking' && block.thinking) {
              const thinkingPart: DriverPart = { driverId: 'qoder', type: 'qoder.thinking', text: block.thinking }
              if (!parts.some((existing) => existing.type === 'qoder.thinking' && existing.text === block.thinking)) {
                yield { type: 'part', part: pushPart(thinkingPart) }
              }
            }
          }
        } else if (message.type === 'result') {
          const resultText = typeof message.result === 'string' ? message.result : ''
          if (resultText && !buffer.includes(resultText)) {
            const extra = resultText.startsWith(buffer) ? resultText.slice(buffer.length) : resultText
            buffer += extra
            if (extra) {
              yield { type: 'part', part: pushPart({ driverId: 'qoder', type: 'text', text: extra }) }
            }
          }
          // result 里也可能带 mcp tool_result 结构(content 数组) — 让 ToolSource 试一次。
          if (taskSource) {
            const described = taskSource.describeResult(message.result)
            if (described && !taskCreated) {
              taskCreated = described
              yield { type: 'task-created', result: described }
            }
          }
          captured = true
        } else if (message.type === 'error' && !buffer) {
          throw new Error(message.error ?? 'Qoder SDK 错误')
        }
      }
    } catch (error) {
      if (!input.signal.aborted && !captured && !buffer) throw error
    } finally {
      input.signal.removeEventListener('abort', onParentAbort)
      try {
        await qoderSession.close()
      } catch {
        /* may already be closed */
      }
      if (this.activeQuery === qoderSession) this.activeQuery = undefined
    }

    if (!input.signal.aborted) {
      const finalStatus: ChatMessageMetadata['status'] = taskCreated ? 'done' : captured ? 'done' : 'done'
      yield { type: 'done', status: finalStatus }
    }
  }

  dispose(): void {
    try {
      this.activeQuery?.interrupt()
    } catch {
      /* ignore */
    }
    this.activeQuery = undefined
  }

  private buildPrompt(history: StoredMessage[], userText: string): string {
    const blocks: string[] = []
    for (const message of history) {
      if (message.role === 'system') continue
      const text = message.parts.map(partToText).filter(Boolean).join('\n')
      if (!text) continue
      const label = message.role === 'user' ? 'Human' : 'Assistant'
      blocks.push(`${label}: ${text}`)
    }
    blocks.push(`Human: ${userText}`)
    blocks.push('Assistant:')
    return blocks.join('\n\n')
  }

  /**
   * 从 history 末尾倒序查找最后一个 `qoder.session` part;
   * 返回 `{ resume, remaining }` — `resume` 用于 SDK `query()` options,
   * `remaining` 是"被该 session 覆盖前"的历史(不含该 part 所在 assistant 消息
   * 及其之后),拼 prompt 时只发 remaining,SDK 会用 server-side history 补齐。
   */
  private extractResumeContext(history: StoredMessage[]): { resume?: string; remaining: StoredMessage[] } {
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i]
      if (!message || message.role !== 'assistant') continue
      for (const part of message.parts) {
        if (part.type === 'qoder.session' && part.sessionId) {
          return { resume: part.sessionId, remaining: history.slice(0, i) }
        }
      }
    }
    return { remaining: history }
  }
}
