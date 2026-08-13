import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { TaskStore } from '@task-pipeline/core'
import { ChatStorage } from './chat-storage.js'
import type { ChatDriverRegistry } from './drivers/driver-registry.js'
import { createProjectQueryToolSource } from './drivers/project-query-tools.js'
import type { ToolSource } from './drivers/tool-source.js'
import { isModelAvailable, pickGroupModel, pickSystemDefaultModel } from './system-default-model.js'
import type { ChatDriver } from './drivers/chat-driver.js'
import type {
  AbortChatStreamInput,
  ChatConversation,
  ChatMessageMetadata,
  ChatModelGroup,
  ChatStreamEvent,
  ChatStreamChunk,
  ChatDriverId,
  ChatUsage,
  DriverPart,
  McpServiceId,
  StartChatStreamInput,
  StoredMessage,
  StoredMessageRecord
} from './chat-types.js'
import type { TaskCreationBackend } from './task-backends/index.js'

type ActiveStream = { streamId: string; abort: AbortController }
type TaskBackendFactory = () => TaskCreationBackend | undefined
type MemoryContextProvider = (input: { conversationId: string; query: string }) => Promise<string | undefined>
type ConversationConsolidator = (input: {
  conversation: ChatConversation
  signal: AbortSignal
  driverId: ChatDriverId
  model: string
  /** 所属对话回合 traceId（记忆整理 LLM 调用 join 用）。 */
  traceId?: string
}) => Promise<void>

/**
 * 对话回合 trace 管理器（对话级：一个对话 = 一个 Trace，回合间重开续接）。
 * 由主进程注入：回合 begin/end 控制 trace 生命周期，辅助 LLM 调用（关键词提取/记忆整理）
 * 通过 traceIdForChat 拿到 traceId 后 join 同一回合。
 */
export type ChatTraceManager = {
  /**
   * 开启一个对话回合的 trace。
   * 返回回合句柄：traceId 供 driver/辅助调用 join（对话级，跨回合不变）；
   * turnKey 是回合隔离令牌（每回合递增），endTurn / 阶段容器按它识别「自己回合」，
   * 避免回合被新回合接管（连发/打断）时误关新回合的 trace 或误收新回合的阶段容器。
   */
  beginTurn(
    chatId: string,
    messageId: string,
    text: string,
    driverId: ChatDriverId,
    model: string,
    /** 本回合选择态（MCP 服务 / Agent）：写入根 span meta，Trace 里可见。 */
    extras?: { mcpServices?: McpServiceId[]; agentId?: string }
  ): { traceId: string; turnKey: string } | undefined
  endTurn(chatId: string, turnKey?: string): void
  traceIdForChat(chatId: string): string | undefined
  /**
   * 阶段容器（可选）：begin/end 成对调用，包裹期间产生的 span 自动挂入
   * agent.run 阶段容器（keyword/chat/memory），Trace 页据此按阶段分组而非平铺。
   * turnKey 隔离：回合被新回合接管（连发/打断）时，旧回合只收尾自己的阶段容器。
   */
  beginStage?(chatId: string, phase: ChatStagePhase, turnKey: string): void
  endStage?(chatId: string, turnKey: string, status?: 'completed' | 'error'): void
}

/** 对话回合的阶段划分：关键词提取并注入 / 对话生成 / 记忆整理。 */
export type ChatStagePhase = 'keyword' | 'chat' | 'memory'

/**
 * ChatService — 编排层。
 *
 * 不再 import 任何 ai-sdk / UIMessage / driver 实现细节。
 * 职责只剩:
 *  1. 从 `ChatDriverRegistry` 取 driver;
 *  2. 把 `StartChatStreamInput` 翻译成 `StreamChatInput` 调 `driver.streamChat`;
 *  3. 把 driver 推上来的 `ChatStreamChunk` 透传给前端 (附 `driverId` 字段);
 *  4. 流结束后用 `driver.serializeAssistantMessage` 把累积的 parts 落盘;
 *  5. 单会话切换 driver:历史 messages 按各自 driverId 反序列化渲染,新消息用新 driverId 生成。
 */
export class ChatService {
  private readonly storage: ChatStorage
  private readonly activeStreams = new Map<string, ActiveStream>()

  constructor(
    private readonly store: TaskStore,
    dataDir: string,
    private readonly driverRegistry: ChatDriverRegistry,
    private readonly getMainWindow: () => BrowserWindow | undefined,
    private readonly resolveTaskBackend?: TaskBackendFactory,
    private readonly memoryContext?: MemoryContextProvider,
    private readonly consolidateConversation?: ConversationConsolidator,
    private readonly traceManager?: ChatTraceManager
  ) {
    this.storage = new ChatStorage(dataDir)
  }

  listChats() {
    return this.storage.listMetas()
  }

  /** 列出所有项目(工作目录),与具体会话解耦 —— 目录下会话删光后项目仍保留。 */
  listProjects() {
    return this.storage.listProjects()
  }

  /**
   * 加载会话并把每条 message 按 `driverId` 反序列化为 `StoredMessage`(带 parts)。
   * `ChatConversation.messages` 本身是 record 列表(无 parts),这里补齐 parts 给 UI 用。
   */
  getChat(id: string): { conversation: ChatConversation; messages: StoredMessage[] } | undefined {
    const conversation = this.storage.getConversation(id)
    if (!conversation) return undefined
    const messages = conversation.messages.map((record) => this.deserializeRecord(record))
    return { conversation, messages }
  }

  /**
   * 列出所有 driver 提供的模型,按 driverId 分组。
   */
  async listModels(): Promise<ChatModelGroup[]> {
    const groups: ChatModelGroup[] = []
    for (const driver of this.driverRegistry.list()) {
      try {
        const models = await driver.listModels()
        if (models.length) groups.push({ driverId: driver.id, displayName: driver.displayName, models })
      } catch {
        /* driver 列表失败不影响其他 driver */
      }
    }
    return groups
  }

  /**
   * 系统默认模型:Qoder 可用优先,否则第一个有模型的分组;组内 isDefault 优先。
   * 无任何可用模型时返回 undefined(前端禁用发送)。
   */
  async getDefaultModel(): Promise<{ driverId: ChatDriverId; model: string } | undefined> {
    return pickSystemDefaultModel(await this.listModels())
  }

  /**
   * 解析本轮实际使用的 driver + model(失效模型 fallback):
   *  1. 请求的 driver 下 model 仍存在 → 原样使用;
   *  2. model 失效但该 driver 还有模型 → 用该 driver 的默认模型;
   *  3. driver 无模型 / 未注册 → 回落到系统默认模型(可能换 driver);
   *  4. 全无可用模型 → 抛错提示配置。
   */
  private async resolveStreamTarget(input: StartChatStreamInput): Promise<{ driver: ChatDriver; model: string }> {
    const groups = await this.listModels()
    const group = groups.find((item) => item.driverId === input.driverId)
    if (group && isModelAvailable(groups, input.model)) {
      const driver = this.driverRegistry.tryGet(input.driverId)
      if (driver) return { driver, model: input.model }
    }
    if (group?.models.length) {
      const driver = this.driverRegistry.tryGet(input.driverId)
      // 与系统默认解析同一回落规则（isDefault → lite → 第一个），
      // 否则 Qoder 无 credit 时重试 fallback 可能落到非 lite 模型。
      const fallback = pickGroupModel(group)
      if (driver && fallback) return { driver, model: fallback.value }
    }
    const systemDefault = pickSystemDefaultModel(groups)
    const driver = systemDefault ? this.driverRegistry.tryGet(systemDefault.driverId) : undefined
    if (!driver || !systemDefault) throw new Error('未配置可用模型，请在设置中添加 Qoder Token 或 OpenAI 配置')
    return { driver, model: systemDefault.model }
  }

  createChat(driverId?: ChatDriverId, model?: string, workingDirectory?: string): ChatConversation {
    // 统一复用规则:普通对话(无目录)复用无目录空对话,项目对话复用同目录空对话 ——
    // 避免反复点「+」无限新增空会话。匹配条件是 workingDirectory 全等。
    const existing = this.storage
      .listMetas()
      .find((item) => item.messageCount === 0 && item.workingDirectory === workingDirectory)
    if (existing) {
      const conversation = this.storage.getConversation(existing.id)
      if (conversation) return conversation
    }
    const now = new Date().toISOString()
    const conversation: ChatConversation = {
      id: randomUUID(),
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      model,
      driverId,
      workingDirectory,
      messages: []
    }
    this.storage.saveConversation(conversation)
    return conversation
  }

  deleteChat(id: string): void {
    this.activeStreams.get(id)?.abort.abort()
    // 关闭该对话对应的常驻 Qoder 会话(qodercli 进程),避免随应用生命周期悬挂。
    const conversation = this.storage.getConversation(id)
    if (conversation?.driverId) {
      this.driverRegistry.tryGet(conversation.driverId)?.closeSession?.(id)
    }
    this.storage.deleteConversation(id)
  }

  /**
   * 绑定/解绑对话的工作目录(项目对话)。
   * 传 undefined 即解绑,回到普通对话;正在流式时返回 undefined。
   */
  setChatWorkingDirectory(id: string, workingDirectory?: string): ChatConversation | undefined {
    if (this.activeStreams.has(id)) return undefined
    return this.storage.updateMeta(id, { workingDirectory })
  }

  abortChat(input: AbortChatStreamInput): void {
    const active = this.activeStreams.get(input.chatId)
    if (active?.streamId === input.streamId) active.abort.abort()
  }

  /**
   * 阶段容器包裹（与任务路径 agent.run 阶段同构）：fn 执行期间产生的 span 自动挂入
   * keyword/chat/memory 阶段容器，Trace 页据此按阶段分组。trace 不活跃或管理器缺
   * 阶段能力时直通执行；阶段内异常标记容器 error 后原样上抛（不吞错）。
   */
  private async withStage<T>(
    traceActive: boolean,
    chatId: string,
    turnKey: string | undefined,
    phase: ChatStagePhase,
    fn: () => Promise<T>
  ): Promise<T> {
    if (!traceActive || !turnKey || !this.traceManager?.beginStage || !this.traceManager.endStage) return fn()
    this.traceManager.beginStage(chatId, phase, turnKey)
    try {
      const result = await fn()
      this.traceManager.endStage(chatId, turnKey)
      return result
    } catch (error) {
      this.traceManager.endStage(chatId, turnKey, 'error')
      throw error
    }
  }

  async startChatStream(input: StartChatStreamInput): Promise<void> {
    const conversation = this.storage.getConversation(input.chatId)
    if (!conversation) throw new Error('对话不存在')
    // 失效模型 fallback:存储/请求里的 model 可能已不存在(profile 删除 / Qoder 模型下线),
    // 解析出本轮真正可用的 driver + model(可能换 driver);不做前置改写,仅本轮按实际使用值落盘。
    const target = await this.resolveStreamTarget(input)
    const driver = target.driver
    const effective: StartChatStreamInput = { ...input, driverId: driver.id, model: target.model }

    const prior = this.activeStreams.get(input.chatId)
    if (prior) prior.abort.abort()
    const abort = new AbortController()
    this.activeStreams.set(input.chatId, { streamId: input.streamId, abort })

    const now = input.message.createdAt
    // 对话回合 trace：对话级（一个对话 = 一个 Trace，跨回合重开续接，显示多条「对话生成」记录）。
    // extras 带上 MCP / Agent 选择态，写入根 span meta（Trace 里可见本回合注入了什么）。
    const turn = this.traceManager?.beginTurn(
      effective.chatId,
      effective.message.id,
      effective.message.text,
      effective.driverId,
      effective.model,
      {
        ...(effective.mcpService?.length ? { mcpServices: effective.mcpService } : {}),
        ...(effective.agentId ? { agentId: effective.agentId } : {})
      }
    )
    const turnTraceId = turn?.traceId
    const turnKey = turn?.turnKey
    const userRecord = driver.serializeUserMessage({ id: input.message.id, text: input.message.text, createdAt: now })
    const existing = conversation.messages.filter((message) => message.id !== userRecord.id)
    // 选中 Agent 的 systemPrompt：以 system 消息插入本轮上下文（复用 memoryContext 的插入模式），
    // 随 messages 一起落盘，保证注入内容进入模型上下文且历史加载后仍可见。
    const agentSystemRecord = input.systemPrompt
      ? ({
          id: randomUUID(),
          role: 'system',
          createdAt: now,
          driverId: effective.driverId,
          raw: { kind: 'system', text: input.systemPrompt }
        } as StoredMessageRecord)
      : undefined
    const messages: StoredMessageRecord[] = agentSystemRecord
      ? [...existing, agentSystemRecord, userRecord]
      : [...existing, userRecord]
    const assistantId = randomUUID()
    const parts: DriverPart[] = []
    let status: ChatMessageMetadata['status'] = 'done'
    let capturedSessionId: string | undefined
    let streamUsage: ChatUsage | undefined
    let errorMessage: string | undefined
    let userPersisted = false
    const taskBackend = input.mode === 'task-create' ? this.resolveTaskBackend?.() : undefined
    // task-create 优先注入任务后端工具（Jira 等）；否则项目对话（绑定了工作目录）注入只读
    // 查询工具集，让模型能真正读取代码回答项目问题；普通对话仍无工具（行为不变）。
    const toolSource: ToolSource | undefined =
      taskBackend?.toToolSource() ??
      (conversation.workingDirectory ? createProjectQueryToolSource(conversation.workingDirectory) : undefined)

    try {
      const isFirstUserMessage = !conversation.messages.some((m) => m.role === 'user')
      const title = isFirstUserMessage ? titleOf(input.message.text) : conversation.title
      this.storage.replaceMessages(input.chatId, messages, {
        title,
        model: effective.model,
        driverId: effective.driverId,
        // 运行时模型参数随对话落盘：切回对话时恢复，换模型时由前端清空后不再携带。
        ...(effective.modelParams ? { modelParams: effective.modelParams } : {}),
        // 选中的 MCP 服务 / Agent 随对话落盘：切换对话后前端恢复选择态，发送时注入 driver。
        ...(effective.mcpService?.length ? { mcpService: effective.mcpService } : {}),
        ...(effective.agentId ? { agentId: effective.agentId } : {}),
        updatedAt: now
      })
      userPersisted = true

      // keyword 阶段容器：关键词提取 + 记忆/Repowiki 检索（期间的 llm/tool span 挂入阶段）。
      const memoryContext = await this.withStage(Boolean(turnTraceId), input.chatId, turnKey, 'keyword', async () =>
        this.memoryContext?.({ conversationId: input.chatId, query: input.message.text })
      )
      const historyRecords = memoryContext
        ? [
            ...messages.slice(0, -1),
            {
              id: randomUUID(),
              role: 'system',
              createdAt: now,
              driverId: effective.driverId,
              raw: { kind: 'system', text: memoryContext }
            } as StoredMessageRecord,
            userRecord
          ]
        : messages
      const history = historyRecords.map((record) => this.deserializeRecord(record))

      this.dispatch(effective, {
        type: 'start',
        messageId: assistantId,
        messageMetadata: { createdAt: now, model: effective.model, agentMode: input.mode ?? 'chat' }
      })

      // chat 阶段容器：主对话生成（driver 流式期间的 llm/tool/subtask span 挂入阶段）。
      await this.withStage(Boolean(turnTraceId), input.chatId, turnKey, 'chat', async () => {
        for await (const chunk of driver.streamChat({
          conversationId: input.chatId,
          model: effective.model,
          ...(effective.modelParams ? { modelParams: effective.modelParams } : {}),
          history,
          userInput: { id: input.message.id, text: input.message.text, createdAt: now },
          signal: abort.signal,
          cwd: conversation.workingDirectory,
          ...(turnTraceId ? { traceId: turnTraceId } : {}),
          ...(toolSource ? { toolSource } : {}),
          ...(effective.mcpService?.length ? { mcpServices: effective.mcpService } : {})
        })) {
          if (abort.signal.aborted) break
          // 累积 parts
          if (chunk.type === 'part') {
            parts.push(chunk.part)
            if (chunk.part.type === 'qoder.session') capturedSessionId = chunk.part.sessionId
          } else if (chunk.type === 'task-created') {
            // task-created 已随 dispatch 透传给前端，无需本地累积。
          } else if (chunk.type === 'done') {
            // driver 在流结束时带回用量（openai 路径），供 Trace 元信息展示与落盘。
            if (chunk.usage) streamUsage = chunk.usage
          }
          this.dispatch(effective, chunk)
        }
      })
      if (abort.signal.aborted) status = 'aborted'
      if (status === 'done' && parts.length === 0) throw new Error('模型返回了空响应')
    } catch (reason) {
      if (abort.signal.aborted) status = 'aborted'
      else {
        status = 'error'
        const message = reason instanceof Error ? reason.message : String(reason)
        errorMessage = message
        this.dispatch(effective, { type: 'error', message })
      }
    } finally {
      // 用量/模型已在 done chunk 里随 dispatch 透传给前端，此处只负责落盘（见下方 serializeAssistantMessage）。
      try {
        if (userPersisted) {
          const serialized = driver.serializeAssistantMessage({
            id: assistantId,
            parts,
            createdAt: now,
            ...(capturedSessionId ? { sessionId: capturedSessionId } : {}),
            ...(streamUsage ? { usage: streamUsage } : {})
          })
          // 错误详情不依赖 driver 的序列化实现(各 driver 挑字段返回,可能丢弃多余 input),
          // 统一在编排层合并进 record,保证历史消息重新加载后仍能展示接口异常。
          const assistantRecord = errorMessage ? { ...serialized, errorMessage } : serialized
          this.storage.appendMessage(input.chatId, assistantRecord, {
            model: effective.model,
            driverId: effective.driverId
          })
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        this.dispatch(effective, { type: 'error', message: `保存聊天失败:${message}` })
      } finally {
        toolSource?.close()
        taskBackend?.close()
        if (status === 'aborted') this.dispatch(effective, { type: 'done', status: 'aborted' })
        else this.dispatch(effective, { type: 'done', status })
        this.finish(effective)
        if (this.activeStreams.get(input.chatId)?.streamId === input.streamId) this.activeStreams.delete(input.chatId)
        if (status === 'done' && parts.length) {
          const conversation = this.storage.getConversation(input.chatId)
          if (conversation) {
            // 记忆整理是回合的一部分：await 它完成后再 endTurn，确保整理 LLM 调用
            // 挂在同一 trace 下；consolidate 异常也 endTurn（兜底关闭）。
            // memory 阶段容器包裹整理过程（整理 LLM span 挂入阶段）。
            void (async () => {
              try {
                await this.withStage(Boolean(turnTraceId), input.chatId, turnKey, 'memory', async () => {
                  await this.consolidateConversation?.({
                    conversation,
                    signal: abort.signal,
                    driverId: effective.driverId,
                    model: effective.model,
                    traceId: turnTraceId
                  })
                })
              } catch (reason) {
                console.warn('[memory] chat consolidate failed:', reason)
              } finally {
                this.traceManager?.endTurn(input.chatId, turnKey)
              }
            })()
          } else {
            this.traceManager?.endTurn(input.chatId, turnKey)
          }
        } else {
          // 错误 / 中止：无记忆整理，直接收尾回合。
          this.traceManager?.endTurn(input.chatId, turnKey)
        }
      }
    }
  }

  /**
   * 把 record 按 driverId 反序列化为带 parts 的 StoredMessage。
   * 单会话切换 driver 时,历史消息按各自 driverId 各自反序列化。
   */
  private deserializeRecord(record: StoredMessageRecord): StoredMessage {
    const driver = this.driverRegistry.tryGet(record.driverId)
    if (!driver) {
      // 未注册的 driver (例如旧 driverId) 兜底:parts = []
      return { ...record, parts: [] }
    }
    return driver.deserializeMessage(record)
  }

  private dispatch(
    input: Pick<StartChatStreamInput, 'streamId' | 'chatId' | 'driverId'>,
    chunk: ChatStreamChunk
  ): void {
    this.getMainWindow()?.webContents.send('chat:stream-event', {
      streamId: input.streamId,
      chatId: input.chatId,
      driverId: input.driverId,
      chunk
    } satisfies ChatStreamEvent)
  }

  private finish(input: Pick<StartChatStreamInput, 'streamId' | 'chatId' | 'driverId'>): void {
    this.getMainWindow()?.webContents.send('chat:stream-event', {
      streamId: input.streamId,
      chatId: input.chatId,
      driverId: input.driverId,
      done: true
    } satisfies ChatStreamEvent)
  }

  /** 释放所有 driver 的资源(给 main.ts 退出时用)。 */
  dispose(): void {
    for (const driver of this.driverRegistry.list()) driver.dispose()
  }
}

function titleOf(text: string): string {
  return text.slice(0, 32).replace(/\s+/g, ' ').trim() || '新对话'
}

export type { ChatDriver } from './drivers/chat-driver.js'
