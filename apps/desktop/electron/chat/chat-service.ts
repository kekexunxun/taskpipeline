import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { TaskStore } from '@task-pipeline/core'
import { hasPendingUiFor } from '../task/pi-session.js'
import { ChatStorage } from './chat-storage.js'
import { ChatPlanStorage } from './chat-plan-storage.js'
import type { ChatDriverRegistry } from './drivers/driver-registry.js'
import { createProjectQueryToolSource, WRITE_PLAN_TOOL } from './drivers/project-query-tools.js'
import type { ToolDeclaration, ToolSource } from './drivers/tool-source.js'
import { isModelAvailable, pickGroupModel, pickSystemDefaultModel } from './system-default-model.js'
import {
  budgetForModel,
  contextWindowForModel,
  estimateRecordTokens,
  estimateTokens,
  trimHistoryToBudget
} from './context-budget.js'
import {
  buildCompaction,
  buildCompactionTranscript,
  COMPACT_CONTEXT_USAGE_RATIO,
  excludeCoveredRecords,
  makeSummarySystemRecord,
  shouldCompact,
  summarizeOverflow
} from './context-compaction.js'
import type { ChatDriver } from './drivers/chat-driver.js'
import type {
  AbortChatStreamInput,
  ActiveChatStreamSnapshot,
  ChatConversation,
  ChatConversationMeta,
  ChatConversationMode,
  ChatMessageMetadata,
  ChatModelGroup,
  ChatGroup,
  ChatReattachState,
  ChatStreamEvent,
  ChatStreamChunk,
  ChatDriverId,
  ChatUsage,
  DriverPart,
  HitlMode,
  McpServiceId,
  StartChatStreamInput,
  StoredMessage,
  StoredMessageRecord
} from './chat-types.js'
import type { TaskCreationBackend } from './task-backends/index.js'
import { runChatCodeReview, type ChatReviewInfra } from './chat-review.js'

/**
 * 在飞流注册项：除 streamId/abort 外还携带 reattach 快照（driverId/model/assistantId/
 * parts/seq）。渲染层卸载重挂载（如切去 Trace 再切回 Chat）时活订阅丢失，
 * 主进程流不受影响；重挂载方经 getReattachState 拿内存 parts 恢复在飞消息，
 * 再按 seq 水位去重续应用后续事件。
 */
type ActiveStream = {
  streamId: string
  abort: AbortController
  driverId: ChatDriverId
  model: string
  /** 本轮在飞 assistant 消息 id（与磁盘增量快照同 id）。 */
  assistantId: string
  createdAt: string
  /** 本轮已累积 parts（与流循环同一数组引用，快照时 slice 拷贝）。 */
  parts: DriverPart[]
  /** dispatch 单调水位：每条外发事件 +1，reattach 去重用。 */
  seq: number
}
type TaskBackendFactory = () => TaskCreationBackend | undefined
/**
 * 记忆检索工具解析器：按对话归属（工作目录 -> repositoryIds / conversationId）产出本回合可用的
 * `search_memory` 工具声明列表。不再像旧实现那样在模型调用前无条件检索并作为 system 文本
 * 注入——现在改为把检索能力作为一个普通工具交给 driver，模型自己决定何时调用。
 */
type MemoryToolsResolver = (input: { conversationId: string; workingDirectory?: string }) => Promise<ToolDeclaration[]>
type ConversationConsolidator = (input: {
  conversation: ChatConversation
  signal: AbortSignal
  driverId: ChatDriverId
  model: string
  /** 所属对话回合 traceId（记忆整理 LLM 调用 join 用）。 */
  traceId?: string
}) => Promise<void>
/**
 * 工作区上下文解析器：根据当前 workingDirectory 返回工作区描述文本。
 * 用于注入系统提示，告知 LLM 当前工作区的多目录结构和 agents.md 规范。
 */
type WorkspaceContextResolver = (workingDirectory: string | undefined) => Promise<string | undefined>

/**
 * 对话回合 trace 管理器（对话级：一个对话 = 一个 Trace，回合间重开续接）。
 * 由主进程注入：回合 begin/end 控制 trace 生命周期，辅助 LLM 调用（记忆检索 / 记忆整理）
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

/** 对话回合的阶段划分：对话生成 / 代码审查 / 记忆整理。 */
export type ChatStagePhase = 'chat' | 'review' | 'memory'

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

/**
 * 流存活心跳间隔（毫秒）：只要一轮流在飞，就按此间隔向渲染层发一个 heartbeat chunk。
 * 用于重置前端 60s 流看门狗——推理模型长思考、或模型正在流式生成超大工具参数（如 write_plan 的
 * 整篇计划正文）期间，driver 可能连续数十秒不向渲染层吐任何事件，会被看门狗误判为死流而 abort。
 * 心跳由主进程发出：主进程崩溃 / IPC 断连时心跳随之停止，看门狗仍能如期兜底真正的死流。
 * 注意：心跳只探「主进程 IPC 投递能力」，探不到「主进程活着但 driver 子进程挂死」，
 * 后者由下方 CHAT_DRIVER_STALL_MS 的 driver 静默检测负责（同一心跳回调内顺带判定）。
 */
export const CHAT_STREAM_HEARTBEAT_MS = 20_000

/**
 * driver 静默挂死阈值：连续无任何 driver chunk 超过该时长、且没有 HITL 弹窗在等用户决策，
 * 判定子进程 / SDK 挂死：停发心跳、给前端 dispatch 明确 error、主动 abort 本轮。
 * 阈值必须大于最长合法静默段（单个长构建/测试工具执行可安静 ~10 分钟），取 15 分钟：
 * 漏判代价 = 用户多等几分钟；误判代价 = 杀死一个正常长工具回合，显然后者更糟。
 */
export const CHAT_DRIVER_STALL_MS = 15 * 60_000

/** 计划正文达到该长度才视为「真正的计划」（过滤模型只说“我这就写”这类开场白）。 */
export const PLAN_DOC_MIN_CHARS = 240

/**
 * 把计划落盘到工作区仓库的相对路径：`docs/<清洗后的标题>-开发计划.md`。
 * 标题里的路径分隔符 / 控制字符 / Windows 非法字符会被替换为空格（防目录穿越与非法文件名）。
 */
export function buildPlanDocRelPath(title: string, chatId: string): string {
  const cleaned = (title ?? '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 去掉不可见控制字符（不用字面量控制区间正则，避开 no-control-regex）。
  const base = Array.from(cleaned)
    .filter((c) => c.codePointAt(0)! >= 0x20)
    .join('')
    .slice(0, 60)
  const name = base ? `${base}-开发计划` : `plan-${(chatId ?? '').slice(0, 8) || 'chat'}-开发计划`
  return `docs/${name}.md`
}

/**
 * 是否兜底把计划正文写入工作区仓库：仅当绑定了工作目录、本轮模型未自行调用 write_plan、
 * 且捕获到的计划正文足够长时。避免重复落盘、避免把一句开场白写成“计划”。
 */
export function shouldPersistPlanDoc(opts: {
  workingDirectory?: string
  usedWritePlan: boolean
  planText: string
  minChars?: number
}): boolean {
  if (!opts.workingDirectory) return false
  if (opts.usedWritePlan) return false
  return opts.planText.trim().length >= (opts.minChars ?? PLAN_DOC_MIN_CHARS)
}

/**
 * 提取计划正文：只取主流程的 text part。
 *
 * 计划模式现在是「委派 planner 子代理」实现：子代理在子任务里流式输出的正文会带
 * `parentTaskId`，主线的转述才是这份回复的正式文本。两者都收会导致计划卡里同一份
 * 计划重复两遍，因此带 parentTaskId 的子任务内部文本一律排除。
 */
export function collectPlanText(parts: DriverPart[]): string {
  return parts
    .filter((p): p is Extract<DriverPart, { type: 'text' }> => p.type === 'text' && !p.parentTaskId)
    .map((p) => p.text)
    .join('')
}

export class ChatService {
  private readonly storage: ChatStorage
  private readonly planStorage: ChatPlanStorage
  private readonly dataDir: string
  private readonly activeStreams = new Map<string, ActiveStream>()
  /** 活跃流的完整生命周期 Promise（含 finally 持久化），供退出时 await 确保落盘。 */
  private readonly activeStreamLifecycles = new Map<string, Promise<void>>()
  /**
   * 对话引导队列（OpenAI 等无状态 driver 用）：
   * 流式期间收到的引导消息暂存于此，当前轮次结束后作为 system 消息写入历史，
   * 下一轮 streamChat 自然带入上下文。Qoder driver 走 SDK 原生注入，不经过此队列。
   */
  private readonly pendingGuidanceByChat = new Map<string, string[]>()
  /** 回合结束后仍在后台执行的记忆整理/滚动摘要 promise：退出前由 waitForPendingConsolidations 兜底等待。 */
  private readonly pendingConsolidations = new Set<Promise<void>>()
  /** 应用正在退出：阻止新流启动，abortAllActiveStreams 期间为 true。 */
  private isQuitting = false
  /** 流式期间增量持久化定时间隔 ID（finally 中清除）。 */
  private streamPersistInterval: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly store: TaskStore,
    dataDir: string,
    private readonly driverRegistry: ChatDriverRegistry,
    private readonly getMainWindow: () => BrowserWindow | undefined,
    private readonly resolveTaskBackend?: TaskBackendFactory,
    private readonly resolveMemoryTools?: MemoryToolsResolver,
    private readonly consolidateConversation?: ConversationConsolidator,
    private readonly traceManager?: ChatTraceManager,
    private readonly resolveWorkspaceContext?: WorkspaceContextResolver,
    private readonly chatReview?: ChatReviewInfra
  ) {
    this.dataDir = dataDir
    this.storage = new ChatStorage(dataDir)
    this.planStorage = new ChatPlanStorage(dataDir)
  }

  async listChats(): Promise<ChatConversationMeta[]> {
    return this.storage.listMetas()
  }

  /** 列出所有分组(目录 + 工作区),与具体会话解耦 —— 目录下会话删光后分组仍保留。 */
  async listGroups(): Promise<ChatGroup[]> {
    return this.storage.listGroups()
  }

  /** 创建 workspace 类型分组(用户显式创建多目录工作区)。 */
  async createWorkspaceGroup(name: string, directories: string[]): Promise<ChatGroup> {
    return this.storage.createGroup(name, directories)
  }

  /** 编辑 workspace 类型分组(更新名称/目录)。 */
  async updateWorkspaceGroup(id: string, name: string, directories: string[]): Promise<ChatGroup | undefined> {
    return this.storage.updateGroup(id, name, directories)
  }

  /** 删除分组(用户显式删除 workspace)。 */
  async deleteGroup(id: string): Promise<void> {
    return this.storage.deleteGroup(id)
  }

  /**
   * 加载会话并把每条 message 按 `driverId` 反序列化为 `StoredMessage`(带 parts)。
   * `ChatConversation.messages` 本身是 record 列表(无 parts),这里补齐 parts 给 UI 用。
   */
  async getChat(id: string): Promise<{ conversation: ChatConversation; messages: StoredMessage[] } | undefined> {
    const conversation = await this.storage.getConversation(id)
    if (!conversation) return undefined
    const messages = conversation.messages.map((record) => this.deserializeRecord(record))
    return { conversation, messages }
  }

  /**
   * 列出所有 driver 提供的模型,按 driverId 分组。
   */
  async listModels(): Promise<ChatModelGroup[]> {
    const drivers = this.driverRegistry.list()
    const results = await Promise.allSettled(drivers.map((driver) => driver.listModels()))
    const groups: ChatModelGroup[] = []
    for (let i = 0; i < drivers.length; i++) {
      const result = results[i]
      if (result && result.status === 'fulfilled' && result.value.length) {
        groups.push({ driverId: drivers[i]!.id, displayName: drivers[i]!.displayName, models: result.value })
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

  async createChat(driverId?: ChatDriverId, model?: string, workingDirectory?: string): Promise<ChatConversation> {
    // 统一复用规则:普通对话(无目录)复用无目录空对话,项目对话复用同目录空对话 ——
    // 避免反复点「+」无限新增空会话。匹配条件是 workingDirectory 全等。
    const metas = await this.storage.listMetas()
    const existing = metas.find((item) => item.messageCount === 0 && item.workingDirectory === workingDirectory)
    if (existing) {
      const conversation = await this.storage.getConversation(existing.id)
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
    await this.storage.saveConversation(conversation)
    return conversation
  }

  async deleteChat(id: string): Promise<void> {
    this.activeStreams.get(id)?.abort.abort()
    // 关闭该对话对应的常驻 Qoder 会话(qodercli 进程),避免随应用生命周期悬挂。
    const conversation = await this.storage.getConversation(id)
    if (conversation?.driverId) {
      this.driverRegistry.tryGet(conversation.driverId)?.closeSession?.(id)
    }
    await this.storage.deleteConversation(id)
  }

  /**
   * 绑定/解绑对话的工作目录(项目对话)。
   * 传 undefined 即解绑,回到普通对话;正在流式时返回 undefined。
   */
  async setChatWorkingDirectory(id: string, workingDirectory?: string): Promise<ChatConversation | undefined> {
    if (this.activeStreams.has(id)) return undefined
    return this.storage.updateMeta(id, { workingDirectory })
  }

  /**
   * 设置对话级 HITL 模式。
   */
  async setChatHitlMode(id: string, hitlMode: HitlMode): Promise<ChatConversation | undefined> {
    return this.storage.updateMeta(id, { hitlMode })
  }

  /**
   * 取消一条待执行计划：把该 assistant 消息里 plan part 的状态改写为 cancelled 并落盘。
   * 计划状态直接随消息 part 持久化（openai driver 原样存 parts），故重启/重载后仍为已取消。
   * 仅 pending 计划可取消；非 pending / 未找到时幂等返回。
   */
  async cancelPlan(chatId: string, messageId: string): Promise<ChatConversation | undefined> {
    const current = await this.storage.getConversation(chatId)
    if (!current) return undefined
    const index = current.messages.findIndex((m) => m.id === messageId)
    if (index < 0) return undefined
    const record = current.messages[index]!
    const driver = this.driverRegistry.tryGet(record.driverId)
    if (!driver) return undefined
    const message = driver.deserializeMessage(record)
    let changed = false
    const parts = message.parts.map((part) => {
      if (part.type === 'plan' && part.plan.status === 'pending') {
        changed = true
        return { ...part, plan: { ...part.plan, status: 'cancelled' as const } }
      }
      return part
    })
    if (!changed) return current
    const nextRecord = driver.serializeAssistantMessage({
      id: record.id,
      parts,
      createdAt: record.createdAt,
      ...(record.usage ? { usage: record.usage } : {})
    })
    const nextMessages = [...current.messages]
    nextMessages[index] = nextRecord
    await this.storage.replaceMessages(chatId, nextMessages)
    return this.storage.getConversation(chatId)
  }

  abortChat(input: AbortChatStreamInput): void {
    const active = this.activeStreams.get(input.chatId)
    if (active?.streamId === input.streamId) active.abort.abort()
  }

  /**
   * 渲染层重挂载（如切去 Trace 再切回 Chat，活订阅已丢）时的 reattach 状态：
   * 在飞流内存快照 + 所属对话全量数据。内存 parts 比磁盘增量快照（3s 落盘）更新，
   * seq 水位供前端对快照之后的续流事件去重。
   */
  async getReattachState(): Promise<ChatReattachState> {
    const streams: ActiveChatStreamSnapshot[] = [...this.activeStreams.entries()].map(([chatId, active]) => ({
      chatId,
      streamId: active.streamId,
      driverId: active.driverId,
      model: active.model,
      assistantId: active.assistantId,
      createdAt: active.createdAt,
      seq: active.seq,
      parts: active.parts.slice()
    }))
    const chats = await Promise.all(
      [...new Set(streams.map((stream) => stream.chatId))].map((chatId) => this.getChat(chatId))
    )
    return { streams, chats }
  }

  /**
   * 对话引导：在当前轮次中注入引导消息，不打断对话。
   * - Qoder driver：走 SDK 原生 priority + shouldQuery 机制，实时注入当前轮次。
   * - OpenAI driver：请求-响应模式无法中途注入，排队等当前轮次结束后写入历史。
   * - 无活跃流时忽略（引导只对正在进行的对话生效）。
   */
  async injectGuidance(chatId: string, text: string): Promise<void> {
    const active = this.activeStreams.get(chatId)
    if (!active) return
    const conversation = await this.storage.getConversation(chatId)
    if (!conversation?.driverId) return
    const driver = this.driverRegistry.tryGet(conversation.driverId)
    // Qoder driver 有活跃会话：直接走 SDK 原生注入
    if (driver?.injectGuidance) {
      driver.injectGuidance(chatId, text)
      return
    }
    // OpenAI 等无状态 driver：排队，当前轮次结束后持久化
    const queue = this.pendingGuidanceByChat.get(chatId) ?? []
    queue.push(text)
    this.pendingGuidanceByChat.set(chatId, queue)
  }

  /**
   * 中止所有活跃流并等待其 finally 块（含 assistant 消息持久化）完成。
   * 给 `before-quit` 用：确保关闭程序时已接收到的回复内容不丢失。
   */
  async abortAllActiveStreams(timeoutMs = 5000): Promise<void> {
    this.isQuitting = true
    for (const active of this.activeStreams.values()) active.abort.abort()
    const lifecycles = Array.from(this.activeStreamLifecycles.values())
    if (lifecycles.length === 0) return
    await Promise.race([Promise.allSettled(lifecycles), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
  }

  /**
   * 等待回合结束后仍在后台运行的记忆整理/滚动摘要（before-quit 链路）。
   * 流式收尾时可能才启动新的整理，故轮询排空直至超时；超时放弃，
   * 整理内部均有 try/catch + 写入侧查重，丢弃一次不影响正确性。
   */
  async waitForPendingConsolidations(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.pendingConsolidations.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      await Promise.race([
        Promise.allSettled([...this.pendingConsolidations]),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, remaining)))
      ])
    }
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

  /**
   * CodeReview 编排（在 review 阶段容器内被调用）：解析工作区根、把状态事件桥接到前端，
   * 委托 runChatCodeReview 完成评审 + 自动修订。逐回合补全 provider/model（随 stream 变化）。
   */
  private async runChatReview(
    effective: StartChatStreamInput,
    userText: string,
    parts: DriverPart[],
    workingDirectory: string,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.chatReview) return
    const roots = await this.resolveWorkspaceRoots(workingDirectory)
    const infra = this.chatReview
    await runChatCodeReview(
      {
        ...infra,
        providerForChat: () => effective.driverId,
        modelForChat: () => effective.model
      },
      {
        chatId: effective.chatId,
        workingDirectory,
        workspaceRoots: roots.length > 0 ? roots : [workingDirectory],
        userText,
        parts,
        signal,
        onStatus: (title, detail) =>
          this.dispatch(effective, { type: 'status', text: detail ? `${title}：${detail}` : title }),
        onReview: (card) => {
          // 评审结论落为持久 part：替换本轮已有的评审卡（多轮修订只保留终态一张），
          // 既随 assistant 消息一起 serializeAssistantMessage 落盘，也即时 dispatch 给前端。
          const part: DriverPart = {
            driverId: effective.driverId,
            type: 'chat.review-result',
            outcome: card.outcome,
            level: card.level,
            comments: card.comments.map((comment) => ({
              ...(comment.severity !== undefined ? { severity: comment.severity } : {}),
              ...(comment.path !== undefined ? { path: comment.path } : {}),
              ...(comment.line !== undefined ? { line: comment.line } : {}),
              ...(comment.message !== undefined ? { message: comment.message } : {})
            })),
            filesReviewed: card.filesReviewed,
            fixRounds: card.fixRounds,
            autoFix: card.autoFix
          }
          const existing = parts.findIndex((p) => p.type === 'chat.review-result')
          if (existing >= 0) parts[existing] = part
          else parts.push(part)
          this.dispatch(effective, { type: 'part', part })
        }
      }
    )
  }

  /**
   * 多目录工作区：找出 `workingDirectory` 所属 workspace 分组的全部目录，作为只读查询工具的可访问根。
   * 不属于任何 workspace（普通单目录对话）或查询失败时，只含自身——与旧行为一致。
   */
  async resolveWorkspaceRoots(workingDirectory: string): Promise<string[]> {
    try {
      const groups = await this.storage.listGroups()
      const ws = groups.find((g) => g.chatType === 'workspace' && g.directories.includes(workingDirectory))
      return ws && ws.directories.length > 0 ? ws.directories : [workingDirectory]
    } catch {
      return [workingDirectory]
    }
  }

  /**
   * 上下文滚动摘要（问题 2-B）：溢出轮次达阈值时跑一次辅助 LLM 调用，把「已有摘要 + 溢出轮次」
   * 压成新的 compaction 并持久化。任何异常只记日志、不阻断对话（降级为仅 2-A 裁剪）。
   */
  private async maybeCompactConversation(input: {
    chatId: string
    driver: ChatDriver
    driverId: ChatDriverId
    model: string
    existingSummary?: string
    overflow: StoredMessageRecord[]
    contextReached?: boolean
    /** 触发压缩时本轮的上下文占用估算与窗口（用于压缩后向前端推送下调后的估算值）。 */
    contextUsedTokens?: number
    contextWindowTokens?: number
    traceId?: string
    signal: AbortSignal
  }): Promise<void> {
    if (!input.overflow.length || !shouldCompact(input.overflow, { contextReached: input.contextReached })) return
    try {
      const transcript = buildCompactionTranscript(input.driver, input.overflow)
      if (!transcript.trim()) return
      // 压缩进行时的界面瞬时提示（走独立常驻 IPC，因其在 finish 后执行、stream 会话已关）。
      this.emitCompaction(input.chatId, 'start')
      let projectedContext: { usedTokens: number; windowTokens: number } | undefined
      try {
        const summary = await summarizeOverflow({
          driver: input.driver,
          driverId: input.driverId,
          model: input.model,
          ...(input.existingSummary ? { existingSummary: input.existingSummary } : {}),
          transcript,
          signal: input.signal,
          ...(input.traceId ? { traceId: input.traceId } : {})
        })
        if (!summary) return
        const compaction = buildCompaction(input.overflow, summary)
        if (!compaction) return
        await this.storage.updateMeta(input.chatId, { compaction })
        // 压缩成功：估算下一轮实际发送的上下文（本轮占用 − 被摘要覆盖的溢出轮次 + 摘要本身），
        // 随 end 广播下发，让头部占用率立即回落而不必等到下一条 assistant 实测值。
        if (input.contextUsedTokens != null && input.contextWindowTokens != null) {
          const overflowTokens = input.overflow.reduce((acc, r) => acc + estimateRecordTokens(r), 0)
          const usedTokens = Math.max(0, input.contextUsedTokens - overflowTokens + estimateTokens(summary))
          projectedContext = { usedTokens, windowTokens: input.contextWindowTokens }
        }
      } finally {
        this.emitCompaction(input.chatId, 'end', projectedContext)
      }
    } catch (reason) {
      console.warn('[compaction] chat compaction failed:', reason)
    }
  }

  /** 向渲染层广播一次上下文压缩状态（start/end）；纯瞬时 UI 提示，不落库、不持久。 */
  private emitCompaction(
    chatId: string,
    phase: 'start' | 'end',
    context?: { usedTokens: number; windowTokens: number }
  ): void {
    this.getMainWindow()?.webContents.send('chat:compaction', { chatId, phase, ...(context ? { context } : {}) })
  }

  /**
   * 把计划正文兼底写入工作区仓库（调用方已用 shouldPersistPlanDoc 把关）。
   * 路径固定为 `workingDirectory/docs/...`（文件名已在 buildPlanDocRelPath 清洗，无分隔符/穿越风险），
   * 父目录 mkdir -p；返回写入的相对路径。失败向上抛出，由调用方吞掉不阻断本轮。
   */
  private async writePlanDoc(workingDirectory: string, relPathPosix: string, content: string): Promise<string> {
    const abs = path.join(workingDirectory, ...relPathPosix.split('/'))
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf8')
    return relPathPosix
  }

  async startChatStream(input: StartChatStreamInput): Promise<void> {
    if (this.isQuitting) throw new Error('应用正在退出')
    const conversation = await this.storage.getConversation(input.chatId)
    if (!conversation) throw new Error('对话不存在')
    // 失效模型 fallback:存储/请求里的 model 可能已不存在(profile 删除 / Qoder 模型下线),
    // 解析出本轮真正可用的 driver + model(可能换 driver);不做前置改写,仅本轮按实际使用值落盘。
    const target = await this.resolveStreamTarget(input)
    const driver = target.driver
    const effective: StartChatStreamInput = { ...input, driverId: driver.id, model: target.model }

    const prior = this.activeStreams.get(input.chatId)
    if (prior) prior.abort.abort()
    const abort = new AbortController()
    // 在飞 assistant 消息与累积 parts 提前创建：随流一起登记进 activeStreams，
    // 供重挂载方（getReattachState）快照当前内存态。
    const assistantId = randomUUID()
    const parts: DriverPart[] = []
    this.activeStreams.set(input.chatId, {
      streamId: input.streamId,
      abort,
      driverId: effective.driverId,
      model: effective.model,
      assistantId,
      createdAt: input.message.createdAt,
      parts,
      seq: 0
    })
    // 追踪流的完整生命周期（含 finally 持久化），供 abortAllActiveStreams 等待落盘完成。
    let resolveLifecycle!: () => void
    const lifecyclePromise = new Promise<void>((resolve) => {
      resolveLifecycle = resolve
    })
    this.activeStreamLifecycles.set(input.chatId, lifecyclePromise)

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
        ...(effective.skills?.length ? { skills: effective.skills } : {}),
        ...(effective.agentId ? { agentId: effective.agentId } : {})
      }
    )
    const turnTraceId = turn?.traceId
    const turnKey = turn?.turnKey
    const userRecord = driver.serializeUserMessage({
      id: input.message.id,
      text: input.message.text,
      createdAt: now,
      ...(input.message.files?.length ? { files: input.message.files } : {})
    })
    const existing = conversation.messages.filter((message) => message.id !== userRecord.id)
    // 选中 Agent 的 systemPrompt：以 system 消息插入本轮上下文，随 messages 一起落盘，
    // 保证注入内容进入模型上下文且历史加载后仍可见。
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
    // 流存活心跳定时器（本方法局部，多对话并发各自独立；finally 中清除）。
    let heartbeat: ReturnType<typeof setInterval> | undefined
    // 最后一次「driver 真实活动」时刻：每个 driver chunk 刷新；HITL 弹窗在飞期间心跳顺带刷新
    // （等用户决策属正常静默，答完重新计时）。距现在超 CHAT_DRIVER_STALL_MS 即判挂死。
    let lastDriverActivityAt = Date.now()
    let status: ChatMessageMetadata['status'] = 'done'
    let capturedSessionId: string | undefined
    let streamUsage: ChatUsage | undefined
    let errorMessage: string | undefined
    let userPersisted = false
    // 本轮组装时被裁掉的溢出轮次（问题 2-B）：回合结束后达阈值则滚动摘要。
    let overflowRecords: StoredMessageRecord[] = []
    // 本轮上下文占用是否已达窗口 80%：达阈时回合结束只要有溢出即摘要，不等攒批。
    let contextReachedLimit = false
    // 本轮上下文占用估算与模型窗口（供压缩后向前端推送下调估算值，finally 闭包内读取）。
    let contextUsedTokensEstimate: number | undefined
    let contextWindowTokensEstimate: number | undefined
    // 实际生效的对话模式：try 内解析，finally 落盘前也要读取（计划模式失败时需据此把
    // 文本转成失败计划卡），故提到 try 之外声明。
    let effectiveChatMode: ChatConversationMode = 'normal'
    const taskBackend = input.mode === 'task-create' ? this.resolveTaskBackend?.() : undefined
    // task-create 优先注入任务后端工具（Jira 等）；否则项目对话（绑定了工作目录）注入只读
    // 查询工具集，让模型能真正读取代码回答项目问题；普通对话仍无工具（行为不变）。
    // 多目录工作区：把对话所属 workspace 分组的全部目录作为可访问根传入，否则工具沙箱只认
    // 单一 workingDirectory，模型按 system prompt 里的工作区描述访问兄弟目录时会被误判越界。
    const toolSource: ToolSource | undefined =
      taskBackend?.toToolSource() ??
      (conversation.workingDirectory
        ? createProjectQueryToolSource(
            conversation.workingDirectory,
            await this.resolveWorkspaceRoots(conversation.workingDirectory),
            // 注入 write_plan：它只属于 planner 子回合（driver 从主链路工具集里剔除）。
            { includePlanWrite: true }
          )
        : undefined)

    try {
      const isFirstUserMessage = !conversation.messages.some((m) => m.role === 'user')
      const title = isFirstUserMessage ? titleOf(input.message.text) : conversation.title
      await this.storage.replaceMessages(input.chatId, messages, {
        title,
        model: effective.model,
        driverId: effective.driverId,
        // 运行时模型参数随对话落盘：切回对话时恢复，换模型时由前端清空后不再携带。
        ...(effective.modelParams ? { modelParams: effective.modelParams } : {}),
        // 选中的 MCP 服务 / Skill / Agent 随对话落盘：切换对话后前端恢复选择态，发送时注入 driver。
        ...(effective.mcpService?.length ? { mcpService: effective.mcpService } : {}),
        ...(effective.skills?.length ? { skills: effective.skills } : {}),
        ...(effective.agentId ? { agentId: effective.agentId } : {}),
        updatedAt: now
      })
      userPersisted = true

      // 记忆检索不再无条件预先注入：本回合把 search_memory 工具声明交给 driver（下面 streamChat
      // 调用处），模型自己决定何时检索。工作区上下文（多目录描述 + agents.md 规范）仍按原逻辑
      // 作为 system 消息注入——这与记忆无关，不受本次改造影响。
      const workspaceContext = await this.resolveWorkspaceContext?.(conversation.workingDirectory)
      // 构建历史消息：注入工作区上下文作为 system 消息（OpenAI driver 会从中提取并融入分层系统提示）
      const systemMessages: StoredMessageRecord[] = []
      if (workspaceContext) {
        systemMessages.push({
          id: randomUUID(),
          role: 'system',
          createdAt: now,
          driverId: effective.driverId,
          raw: { kind: 'system', text: workspaceContext }
        } as StoredMessageRecord)
      }
      const historyRecords =
        systemMessages.length > 0 ? [...messages.slice(0, -1), ...systemMessages, userRecord] : messages
      // 问题 2-B：排除已被滚动摘要覆盖的更早轮次，把摘要作为 system 注入到最前。
      const compaction = conversation.compaction
      const withCompaction = excludeCoveredRecords(historyRecords, compaction?.coveredUntilMessageId)
      const historyRecordsForModel = compaction?.summary
        ? [makeSummarySystemRecord(input.chatId, compaction.summary, effective.driverId, now), ...withCompaction]
        : withCompaction
      // 问题 2-A：按 token 预算裁剪到保留窗口（system + 最近若干轮），防爆窗。
      // 取该对话最近一轮实测 input token 作为触发下限（估算漏算工具定义/system 时仍能兜底）。
      const lastUsageTokens = [...conversation.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.usage?.inputTokens)?.usage?.inputTokens
      const trimmed = trimHistoryToBudget({
        records: historyRecordsForModel,
        budgetTokens: budgetForModel(this.store, effective.model),
        ...(lastUsageTokens ? { lastUsageTokens } : {})
      })
      // 上下文占用判定：实测上轮 input 与裁剪前全量估算取大，达窗口 80% 即标记触发压缩。
      const estimatedFull = historyRecordsForModel.reduce((acc, r) => acc + estimateRecordTokens(r), 0)
      const contextUsedTokens = Math.max(estimatedFull, lastUsageTokens ?? 0)
      const contextWindowTokens = contextWindowForModel(this.store, effective.model)
      contextUsedTokensEstimate = contextUsedTokens
      contextWindowTokensEstimate = contextWindowTokens
      contextReachedLimit = contextUsedTokens >= contextWindowTokens * COMPACT_CONTEXT_USAGE_RATIO
      // 溢出（超出保留窗口、尚未被摘要覆盖）的更早轮次：留待回合结束后滚动摘要。
      overflowRecords = trimmed.dropped
      const history = trimmed.kept.map((record) => this.deserializeRecord(record))

      // 解析实际生效的对话模式（前端指定 > 自动检测 > 对话持久化值 > 默认 normal）
      effectiveChatMode = input.chatMode ?? conversation.chatMode ?? 'normal'
      if (effectiveChatMode === 'normal') {
        const autoDetected = detectPlanModeNeeded(input.message.text)
        if (autoDetected) {
          effectiveChatMode = 'plan'
          this.dispatch(effective, { type: 'status', text: '已自动切换到计划模式' })
        }
      }
      // 自动切换时持久化 chatMode，保证切换对话后恢复
      if (effectiveChatMode !== (conversation.chatMode ?? 'normal')) {
        try {
          await this.storage.updateMeta(input.chatId, { chatMode: effectiveChatMode })
        } catch {
          /* 持久化失败不影响本轮 */
        }
      }

      this.dispatch(effective, {
        type: 'start',
        messageId: assistantId,
        messageMetadata: { createdAt: now, model: effective.model, agentMode: input.mode ?? 'chat' }
      })

      // 流式期间每 3 秒把已累积的 parts 覆盖写入磁盘，崩溃/强杀最多丢 3 秒内容。
      this.startPartialPersist(input.chatId, assistantId, parts, now, effective)

      // 流存活心跳 + driver 挂死检测：默认每 20s 发一个无副作用 heartbeat 重置前端 60s 看门狗，
      // 避免推理模型长思考 / 生成超大工具参数这类「活着但安静」的流被误杀；但 driver 连续安静
      // 超 CHAT_DRIVER_STALL_MS 且无 HITL 弹窗在等用户时，判定子进程挂死：停发心跳、
      // dispatch 明确 error、主动 abort（前端看门狗只能探 IPC 断连，探不到这种「主进程活、driver 死」）。
      heartbeat = setInterval(() => {
        if (hasPendingUiFor(input.chatId)) {
          lastDriverActivityAt = Date.now()
        } else if (Date.now() - lastDriverActivityAt > CHAT_DRIVER_STALL_MS) {
          if (heartbeat) {
            clearInterval(heartbeat)
            heartbeat = undefined
          }
          const silentSec = Math.round((Date.now() - lastDriverActivityAt) / 1000)
          console.warn(`[chat] driver 静默 ${silentSec}s 判定挂死，自动中止本轮: chat=${input.chatId}`)
          this.dispatch(effective, {
            type: 'error',
            message: `模型运行时连续 ${Math.round(CHAT_DRIVER_STALL_MS / 60000)} 分钟无任何响应（子进程可能挂死），已自动中止本轮，请重新发送。`
          })
          abort.abort(new Error(`chat driver stalled: no activity for ${silentSec}s`))
          return
        }
        this.dispatch(effective, { type: 'heartbeat' })
      }, CHAT_STREAM_HEARTBEAT_MS)

      // 计划模式：通知前端将后续内容渲染为 PlanCard
      if (effectiveChatMode === 'plan') {
        this.dispatch(effective, { type: 'plan-start' })
      }

      // 记忆检索工具：不再预先注入，改为随本回合透传给 driver，模型自主决定何时调用 search_memory。
      const memoryTools = await this.resolveMemoryTools?.({
        conversationId: input.chatId,
        workingDirectory: conversation.workingDirectory
      })

      // chat 阶段容器：主对话生成（driver 流式期间的 llm/tool/subtask span 挂入阶段）。
      await this.withStage(Boolean(turnTraceId), input.chatId, turnKey, 'chat', async () => {
        for await (const chunk of driver.streamChat({
          conversationId: input.chatId,
          model: effective.model,
          ...(effective.modelParams ? { modelParams: effective.modelParams } : {}),
          history,
          userInput: {
            id: input.message.id,
            text: input.message.text,
            createdAt: now,
            ...(input.message.files?.length ? { files: input.message.files } : {})
          },
          signal: abort.signal,
          cwd: conversation.workingDirectory,
          ...(turnTraceId ? { traceId: turnTraceId } : {}),
          ...(toolSource ? { toolSource } : {}),
          ...(memoryTools?.length ? { memoryTools } : {}),
          ...(effective.mcpService?.length ? { mcpServices: effective.mcpService } : {}),
          ...(effective.skills?.length ? { skills: effective.skills } : {}),
          ...(workspaceContext ? { workspaceContext } : {}),
          chatMode: effectiveChatMode
        })) {
          if (abort.signal.aborted) break
          // driver 产出任何 chunk 都是真实活动：刷新挂死检测的静默基准。
          lastDriverActivityAt = Date.now()
          // 累积 parts
          if (chunk.type === 'part') {
            parts.push(chunk.part)
            if (chunk.part.type === 'qoder.session') capturedSessionId = chunk.part.sessionId
            this.dispatch(effective, chunk)
          } else if (chunk.type === 'task-created') {
            // task-created 已随 dispatch 透传给前端，无需本地累积。
            this.dispatch(effective, chunk)
          } else if (chunk.type === 'done') {
            // driver 在流结束时带回用量（openai 路径），供 Trace 元信息展示与落盘。
            if (chunk.usage) streamUsage = chunk.usage
            // 暂不 dispatch done，先处理计划模式
          } else {
            this.dispatch(effective, chunk)
          }
        }
      })
      if (abort.signal.aborted) status = 'aborted'
      if (status === 'done' && parts.length === 0) throw new Error('模型返回了空响应')
      // 计划模式：流成功后提取计划内容并保存为文件
      if (status === 'done' && effectiveChatMode === 'plan') {
        const planContent = collectPlanText(parts)
        if (planContent.trim()) {
          try {
            const plan = await this.planStorage.savePlan(input.chatId, assistantId, planContent)
            // 兜底落盘：本轮模型未自行调用 write_plan 时，把捕获到的完整计划正文写入工作区仓库，
            // 使「计划落库」不再依赖模型成功 stream 超长工具参数（历史正是被前端 60s 看门狗探杀）。
            const usedWritePlan = parts.some((p) => p.type === 'openai.tool-call' && p.name === WRITE_PLAN_TOOL)
            if (
              shouldPersistPlanDoc({
                workingDirectory: conversation.workingDirectory,
                usedWritePlan,
                planText: planContent
              })
            ) {
              try {
                const relPath = await this.writePlanDoc(
                  conversation.workingDirectory as string,
                  buildPlanDocRelPath(title, input.chatId),
                  planContent
                )
                this.dispatch(effective, { type: 'status', text: `开发计划已写入仓库 ${relPath}` })
              } catch (error) {
                console.warn('[chat] failed to persist plan doc to workspace:', error)
              }
            }
            // 将文本 parts 替换为计划 part（保留文件路径供执行时使用）
            const planPart: DriverPart = {
              driverId: effective.driverId,
              type: 'plan',
              plan: {
                id: plan.id,
                chatId: plan.chatId,
                createdAt: plan.createdAt,
                status: plan.status,
                content: plan.content,
                filePath: plan.filePath
              }
            }
            // 保留非文本 parts（如 qoder.session），替换文本 parts 为计划 part
            const nonTextParts = parts.filter((p) => p.type !== 'text')
            const newParts = [...nonTextParts, planPart]
            parts.length = 0
            parts.push(...newParts)
            // 通知前端用 plan part 替换所有 parts
            this.dispatch(effective, { type: 'plan-part', parts: newParts })
            // 计划生成后对话进入“等待用户处理”态（同 HITL 语义）：本轮结束但对话未完成。
            // 立即退出计划模式：用户点计划卡“开始执行”或继续发普通消息；若停留在
            // plan 模式，下一条消息（含“执行这个计划”）会再生成一份计划。
            try {
              await this.storage.updateMeta(input.chatId, { chatMode: 'normal' })
            } catch {
              /* 持久化失败不影响本轮 */
            }
          } catch (error) {
            console.warn('[chat] failed to save plan:', error)
          }
        }
      }
      // CodeReview：正常模式下、本轮存在文件变更时，复用 Task 判定口径做代码审查 + 自动修订。
      // 评审异常绝不阻断对话落盘/收尾（与 Task review 失败回退同理），包在 review 阶段容器内。
      if (status === 'done' && effectiveChatMode !== 'plan' && this.chatReview && conversation.workingDirectory) {
        try {
          await this.withStage(Boolean(turnTraceId), input.chatId, turnKey, 'review', () =>
            this.runChatReview(
              effective,
              input.message.text,
              parts,
              conversation.workingDirectory as string,
              abort.signal
            )
          )
        } catch (reason) {
          if (!abort.signal.aborted) console.warn('[chat] code review failed:', reason)
        }
      }
      // 最后才 dispatch done chunk（计划模式在 plan-part 之后）
      if (status === 'done') {
        this.dispatch(effective, { type: 'done', status: 'done', usage: streamUsage, model: effective.model })
      }
    } catch (reason) {
      if (abort.signal.aborted) status = 'aborted'
      else {
        status = 'error'
        const message = reason instanceof Error ? reason.message : String(reason)
        errorMessage = message
        this.dispatch(effective, { type: 'error', message })
      }
    } finally {
      // 停止流存活心跳：本轮已结束（成功 / 失败 / abort），不再需要重置看门狗。
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
      // 清除增量持久化定时器：后续由 finally 的 appendMessage 统一落盘。
      if (this.streamPersistInterval) {
        clearInterval(this.streamPersistInterval)
        this.streamPersistInterval = undefined
      }
      // 计划模式但本轮未成功产出计划（模型异常 / 被中止）：把已累积的文本转成「失败 / 已取消」
      // 的计划卡。既让前端实时看到正确终态（而非永远停在「生成中」），也随消息一起落盘，
      // 保证重新加载 / 继续对话后卡片不再消失（旧的临时卡只存在于渲染层、从不落盘）。
      if (effectiveChatMode === 'plan' && status !== 'done') {
        const planText = collectPlanText(parts)
        if (planText.trim()) {
          const failedPlanPart: DriverPart = {
            driverId: effective.driverId,
            type: 'plan',
            plan: {
              id: assistantId,
              chatId: input.chatId,
              createdAt: now,
              status: status === 'aborted' ? 'cancelled' : 'failed',
              content: planText,
              filePath: ''
            }
          }
          const newParts = [...parts.filter((p) => p.type !== 'text'), failedPlanPart]
          parts.length = 0
          parts.push(...newParts)
          this.dispatch(effective, { type: 'plan-part', parts: newParts })
        }
      }
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
          await this.storage.appendMessage(input.chatId, assistantRecord, {
            model: effective.model,
            driverId: effective.driverId
          })
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        this.dispatch(effective, { type: 'error', message: `保存聊天失败:${message}` })
      } finally {
        // 持久化排队的对话引导（OpenAI 等无状态 driver）：
        // 每条引导作为独立 user 消息写入历史，下一轮 streamChat 自然带入上下文。
        const guidanceQueue = this.pendingGuidanceByChat.get(input.chatId)
        if (guidanceQueue && guidanceQueue.length > 0) {
          this.pendingGuidanceByChat.delete(input.chatId)
          try {
            for (const text of guidanceQueue) {
              await this.storage.appendMessage(input.chatId, {
                id: randomUUID(),
                role: 'user',
                createdAt: new Date().toISOString(),
                driverId: effective.driverId,
                raw: { kind: 'user', text }
              } as StoredMessageRecord)
            }
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason)
            this.dispatch(effective, { type: 'error', message: `保存对话引导失败:${message}` })
          }
        }
        toolSource?.close()
        taskBackend?.close()
        if (status === 'aborted') this.dispatch(effective, { type: 'done', status: 'aborted' })
        else this.dispatch(effective, { type: 'done', status })
        this.finish(effective)
        if (this.activeStreams.get(input.chatId)?.streamId === input.streamId) this.activeStreams.delete(input.chatId)
        if (status === 'done' && parts.length) {
          const conversation = await this.storage.getConversation(input.chatId)
          if (conversation) {
            // 记忆整理是回合的一部分：await 它完成后再 endTurn，确保整理 LLM 调用
            // 挂在同一 trace 下；consolidate 异常也 endTurn（兜底关闭）。
            // memory 阶段容器包裹整理过程（整理 LLM span 挂入阶段）。
            const consolidation = (async () => {
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
                // 上下文滚动摘要（问题 2-B）：溢出轮次达阈值则压入 compaction，失败不阻断（内部吞异常）。
                await this.maybeCompactConversation({
                  chatId: input.chatId,
                  driver,
                  driverId: effective.driverId,
                  model: effective.model,
                  existingSummary: conversation.compaction?.summary,
                  overflow: overflowRecords,
                  contextReached: contextReachedLimit,
                  contextUsedTokens: contextUsedTokensEstimate,
                  contextWindowTokens: contextWindowTokensEstimate,
                  traceId: turnTraceId,
                  signal: abort.signal
                })
                this.traceManager?.endTurn(input.chatId, turnKey)
              }
            })()
            this.pendingConsolidations.add(consolidation)
            void consolidation.finally(() => this.pendingConsolidations.delete(consolidation))
          } else {
            this.traceManager?.endTurn(input.chatId, turnKey)
          }
        } else {
          // 错误 / 中止：无记忆整理，直接收尾回合。
          this.traceManager?.endTurn(input.chatId, turnKey)
        }
      }
      // 生命周期收尾：assistant 消息持久化 + 资源清理全部完成后 resolve，
      // abortAllActiveStreams 据此等待落盘结束再允许退出。
      this.activeStreamLifecycles.delete(input.chatId)
      resolveLifecycle()
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
    // 活跃流事件盖单调 seq：reattach 方按「seq > 已应用水位」去重，
    // 消除快照与续流事件的重叠/缝隙。非活跃流（已收尾）事件不带 seq。
    const active = this.activeStreams.get(input.chatId)
    const seq = active && active.streamId === input.streamId ? (active.seq += 1) : undefined
    this.getMainWindow()?.webContents.send('chat:stream-event', {
      streamId: input.streamId,
      chatId: input.chatId,
      driverId: input.driverId,
      chunk,
      ...(seq !== undefined ? { seq } : {})
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

  /**
   * 启动流式期间增量持久化：每 3 秒把当前已累积的 parts 覆盖写入磁盘。
   * 不重置——固定间隔，`saveConversation` 全量替换，无重复风险。
   */
  private startPartialPersist(
    chatId: string,
    assistantId: string,
    parts: DriverPart[],
    createdAt: string,
    effective: Pick<StartChatStreamInput, 'driverId' | 'model'>
  ): void {
    this.streamPersistInterval = setInterval(() => {
      if (parts.length === 0) return
      void (async () => {
        try {
          const driver = this.driverRegistry.tryGet(effective.driverId as ChatDriverId)
          if (!driver) return
          const serialized = driver.serializeAssistantMessage({ id: assistantId, parts, createdAt })
          const current = await this.storage.getConversation(chatId)
          if (!current) return
          const next: ChatConversation = {
            ...current,
            messages: [...current.messages.filter((m) => m.id !== assistantId), serialized],
            messageCount: current.messages.filter((m) => m.id !== assistantId).length + 1,
            updatedAt: new Date().toISOString()
          }
          await this.storage.saveConversation(next)
        } catch (error) {
          console.warn('[chat] partial persist failed:', error)
        }
      })()
    }, 3000)
  }

  /** 释放所有 driver 的资源(给 main.ts 退出时用)。 */
  dispose(): void {
    for (const driver of this.driverRegistry.list()) driver.dispose()
  }
}

function titleOf(text: string): string {
  return text.slice(0, 32).replace(/\s+/g, ' ').trim() || '新对话'
}

/**
 * 自动检测是否需要切换到计划模式。
 *
 * 判定条件（任一命中即返回 true）：
 * 1. 消息明确表达计划/方案意图（"出个计划"、"先做方案"等）
 * 2. 消息很长（超过 1500 字）且包含大规模修改意图关键词。纯长文本
 *    （粘贴错误日志、上下文等）不触发，避免误判。
 *
 * 旧规则（消息超 500 字 / 命中常见关键词 / 历史中已有计划）过于激进，导致：
 * - 历史里出现过计划后，后续每一轮（含"执行计划"这类指令）都被自动切回
 *   计划模式，反复生成异常计划；
 * - 普通长消息或提到"重构/升级"的简单请求被误切到计划模式。
 * 故收敛为：仅显式计划意图、或超长且复杂的请求才自动切换。
 */
function detectPlanModeNeeded(messageText: string): boolean {
  const text = messageText.toLowerCase()
  // 1. 显式计划/方案意图
  const planIntentKeywords = [
    '制定计划',
    '做个计划',
    '出个计划',
    '列个计划',
    '先做计划',
    '先规划',
    '规划一下',
    '计划一下',
    '出份计划',
    '输出一份计划',
    '输出计划',
    '生成计划',
    '生成一份计划',
    '写一份计划',
    '写个计划',
    '开发计划',
    '实现计划',
    '实施计划',
    '计划文档',
    '出个方案',
    '给个方案',
    '做个方案',
    '制定方案',
    '设计方案',
    '实现方案',
    '技术方案',
    '实施方案',
    '出方案',
    '先别动手',
    '先不要改代码',
    '先分析',
    'make a plan',
    'create a plan',
    'write a plan',
    'draft a plan',
    'plan first',
    'propose a plan',
    'give me a plan',
    'generate a plan',
    'output a plan',
    'development plan',
    'implementation plan',
    'implementation approach',
    'technical plan',
    'technical approach'
  ]
  if (planIntentKeywords.some((kw) => text.includes(kw))) return true
  // 2. 超长消息 + 大规模修改意图：仅长文本（日志/上下文粘贴）不触发
  if (messageText.length > 1500) {
    const complexityKeywords = [
      '重构',
      '重写',
      '迁移',
      '升级',
      '架构',
      '改造',
      '端到端',
      'refactor',
      'rewrite',
      'migrate',
      'redesign',
      'overhaul'
    ]
    if (complexityKeywords.some((kw) => text.includes(kw))) return true
  }
  return false
}

export type { ChatDriver } from './drivers/chat-driver.js'
