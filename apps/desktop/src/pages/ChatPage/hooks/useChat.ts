import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentProfile } from '@task-pipeline/core'
import { ElectronChatTransport } from '../chat-transport'
import type { McpServiceId } from '../components/ChatMcpSelector'
import {
  api,
  type ChatAgentMode,
  type ChatConversation,
  type ChatConversationMeta,
  type ChatDriverId,
  type ChatMessage,
  type ChatMessageMetadata,
  type ChatModelGroup,
  type ChatGroup,
  type ChatStreamChunk,
  type DriverPart,
  type ModelParams,
  type StoredMessageRecord,
  type UserFileAttachment
} from '@/api'
import { useChatModels } from '@/hooks/useChatModels'
import { useFeedback } from '@/hooks/useGlobalFeedback'
import { isModelAvailable, isOpenAIModelValue, pickSystemDefaultModel } from '@/utils/chat-models'
import type { ChatApprovalRequest } from '@/components/ToolApprovalCard'

// 兼容旧导入路径（ChatConversation / ChatPage 从 useChat import 该类型）。
export type { ChatApprovalRequest } from '@/components/ToolApprovalCard'

const transport = new ElectronChatTransport()

/** 流看门狗超时：超过此时间未收到任何 chunk 则认为流已死（主进程崩溃 / IPC 断连），自动清理残留状态。 */
const STREAM_WATCHDOG_MS = 60_000

export type ChatStatus = 'idle' | 'submitted' | 'streaming' | 'error'

/**
 * 在 user 推上来 user message + 在 user 推上"在飞"的 assistant 消息时,把它们存进同一份 list。
 * assistant 消息的 `metadata` 来自 `start` chunk 推上来的 `messageMetadata`,以及 stream 结束时的
 * `task-created` / `done` 事件。
 */
type InFlightAssistant = {
  id: string
  driverId: ChatDriverId
  parts: DriverPart[]
  metadata: Record<string, never>
}

type ActiveStream = {
  streamId: string
  chatId: string
  driverId: ChatDriverId
  model: string
  userMessageId: string
  assistant: InFlightAssistant
  abort: () => void
  closed: Promise<void>
}

/** 排队等待发送的消息（当前对话进行中用户预输入的下一轮消息）。 */
export type PendingMessage = {
  id: string
  text: string
  files?: UserFileAttachment[]
}

function textOf(parts: DriverPart[]): string {
  return parts
    .filter((p): p is Extract<DriverPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** 从 model value (`driverId:model`) 中抽出 driverId;失败返回 undefined。 */
function driverOfModelValue(value: string | undefined, groups: ChatModelGroup[]): ChatDriverId | undefined {
  if (!value) return undefined
  // 1. 先按精确 group 匹配:model value 属于哪一组,driverId 就是哪组
  for (const group of groups) {
    if (group.models.some((model) => model.value === value)) return group.driverId
  }
  // 2. 回退:用 value 的前缀判断
  if (value.startsWith('qoder:')) return 'qoder'
  if (isOpenAIModelValue(value)) return 'openai'
  return undefined
}

/**
 * 对话板块状态模型(多对话并行):
 *  - 每个对话独立维护消息/草稿/阶段提示/确认请求,切换对话不中断后台流;
 *  - 主进程 ChatService 与 ElectronChatTransport 本就按 chatId 隔离(activeStreams Map +
 *    streamId/chatId 双过滤),渲染层只需把单流状态换成 per-chat 状态表。
 */
export function useChat() {
  const { showError, showSuccess } = useFeedback()
  const [metas, setMetas] = useState<ChatConversationMeta[]>([])
  const [groups, setGroups] = useState<ChatGroup[]>([])
  const [activeId, setActiveId] = useState<string>()
  /** activeId 的同步 ref(select/send 竞态与 setDraft 归属判定用,避免异步渲染时序)。 */
  const activeIdRef = useRef<string | undefined>(undefined)
  /** chatId → 会话元信息(含落盘配置:model/mcpService/skills/agentId)。 */
  const [conversationsByChat, setConversationsByChat] = useState<Record<string, ChatConversation>>({})
  /** chatId → 消息列表(含流式中的 in-flight 消息,落盘前先留在内存,切回可见)。 */
  const [messagesByChat, setMessagesByChat] = useState<Record<string, ChatMessage[]>>({})
  /** 正在生成的对话集合(并行流)。 */
  const [streamingChatIds, setStreamingChatIds] = useState<ReadonlySet<string>>(new Set())
  /** chatId → 草稿(隔离,避免切换对话时输入内容串台)。 */
  const [draftsByChat, setDraftsByChat] = useState<Record<string, string>>({})
  /** chatId → 阶段提示(关键词提取/记忆检索中…),仅对当前对话展示。 */
  const [hintsByChat, setHintsByChat] = useState<Record<string, string | undefined>>({})
  /** chatId → 待用户确认的 HITL 请求(内联卡片)。 */
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, ChatApprovalRequest[]>>({})
  /** pendingApprovals 的同步 ref（flushApprovals 在 updater 外读取，避免副作用入 updater）。 */
  const pendingApprovalsRef = useRef<Record<string, ChatApprovalRequest[]>>({})
  useEffect(() => {
    pendingApprovalsRef.current = pendingApprovals
  }, [pendingApprovals])
  /** chatId → 排队等待发送的消息（对话进行中用户预输入）。 */
  const [pendingMessagesByChat, setPendingMessagesByChat] = useState<Record<string, PendingMessage[]>>({})
  const pendingMessagesByChatRef = useRef<Record<string, PendingMessage[]>>({})
  useEffect(() => {
    pendingMessagesByChatRef.current = pendingMessagesByChat
  }, [pendingMessagesByChat])
  /** 活跃流表(key = chatId,同一对话同时只允许一个流)。 */
  const activeStreams = useRef<Map<string, ActiveStream>>(new Map())
  /** 流看门狗:每个流一个 timer,收到事件时重置;超时(主进程崩溃/IPC 断连)则清理残留流状态。 */
  const streamWatchdogs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const { modelGroups } = useChatModels()
  const [model, setModel] = useState<string>()
  const [driverId, setDriverId] = useState<ChatDriverId | undefined>()
  /** 对话级运行时模型参数（推理力度/思考模式等），切换模型时清空。 */
  const [modelParams, setModelParams] = useState<ModelParams | undefined>()
  /** 包装 setModel:同时根据 model value 推断 driverId 并设上;切换模型时清空参数。 */
  const setModelAndDriver = useCallback(
    (value: string | undefined) => {
      if (value !== model) setModelParams(undefined)
      setModel(value)
      const resolved = driverOfModelValue(value, modelGroups)
      if (resolved) setDriverId(resolved)
    },
    [model, modelGroups]
  )
  const [taskCreationEnabled, setTaskCreationEnabled] = useState(false)
  const [taskBackend, setTaskBackend] = useState<{ id: string; displayName: string; configured: boolean }>()
  /** 选中的 MCP 服务列表（随对话落盘，切换对话时按落盘值恢复）。 */
  const [mcpService, setMcpService] = useState<McpServiceId[]>([])
  /** 选中的 Skill 名列表（随对话落盘，切换对话时按落盘值恢复）。 */
  const [skills, setSkills] = useState<string[]>([])
  /** 选中的 Agent id（随对话落盘，切换对话时按落盘值恢复）。 */
  const [agentId, setAgentIdState] = useState<string>()
  const [agents, setAgents] = useState<AgentProfile[]>([])
  /** 选中 Agent 的 profile 引用，send() 发送时取 systemPrompt 注入（避免 send 依赖重建）。 */
  const selectedAgentRef = useRef<AgentProfile | undefined>(undefined)
  const setAgentId = useCallback(
    (next: string | undefined) => {
      setAgentIdState(next)
      selectedAgentRef.current = next ? agents.find((agent) => agent.id === next) : undefined
    },
    [agents]
  )
  // agents 列表异步加载：落盘恢复的 agentId 先入 state，agents 到达后按 id 回填
  // selectedAgentRef（send 时取 systemPrompt 依赖它），避免恢复早于列表时引用丢失。
  useEffect(() => {
    selectedAgentRef.current = agentId ? agents.find((agent) => agent.id === agentId) : undefined
  }, [agentId, agents])

  const refreshMetas = useCallback(async () => {
    try {
      const [nextMetas, nextGroups] = await Promise.all([api.listChats(), api.listChatGroups()])
      setMetas(nextMetas)
      setGroups(nextGroups)
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [showError])

  useEffect(() => {
    void refreshMetas()
    // Agent 列表（Agent 选择器用；挂载时拉取一次）
    void api
      .listAgents()
      .then((list) => setAgents(list))
      .catch(() => undefined)
    // 任务后端列表
    void api
      .listTaskBackends()
      .then((backends) => {
        const firstConfigured = backends.find((item) => item.configured) ?? backends[0]
        setTaskBackend(firstConfigured)
      })
      .catch(() => undefined)
  }, [refreshMetas, showError])

  // 模型列表首次加载时,设置默认 driver 和 model。
  // 系统默认规则:Qoder 分组优先(已连接且有模型),否则第一个分组;组内取 isDefault,无则第一个。
  useEffect(() => {
    if (modelGroups.length === 0) return
    const preferred = pickSystemDefaultModel(modelGroups)
    if (!preferred) return
    setDriverId((current) => current ?? preferred.driverId)
    setModel((current) => current ?? preferred.model)
  }, [modelGroups])

  /** 拉取并缓存一个对话(消息 + 元信息)。返回元信息供 select 恢复配置。 */
  const loadConversation = useCallback(
    async (id: string): Promise<ChatConversation | undefined> => {
      try {
        const next = await api.getChat(id)
        if (!next) {
          setMessagesByChat((current) => ({ ...current, [id]: [] }))
          return undefined
        }
        setConversationsByChat((current) => ({ ...current, [id]: next.conversation }))
        setMessagesByChat((current) => ({ ...current, [id]: next.messages }))
        return next.conversation
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason))
        return undefined
      }
    },
    [showError]
  )

  /** 切换对话:不中断后台流,仅切视图并恢复该对话的配置/草稿。 */
  const select = useCallback(
    async (id: string | undefined) => {
      activeIdRef.current = id
      setActiveId(id)
      // 切对话清该对话的阶段提示（并行下各对话 hint 独立）。
      setHintsByChat((current) => (id && current[id] ? { ...current, [id]: undefined } : current))
      if (!id) return
      // 已缓存(本会话内加载过,含流式中未落盘的消息)直接用;否则拉取。
      let conv = conversationsByChat[id]
      if (!conv) conv = await loadConversation(id)
      // 异步竞态:拉取期间用户又切走了,放弃恢复(避免覆盖当前视图)。
      if (activeIdRef.current !== id || !conv) return
      // 存储模型失效(profile 删除 / 模型下线)时回落系统默认,不动存储值。
      const stored = conv.model
      const storedValid = Boolean(stored) && isModelAvailable(modelGroups, stored)
      if (stored && storedValid) {
        setModelAndDriver(stored)
        if (conv.driverId) setDriverId(conv.driverId)
        setModelParams(conv.modelParams)
      } else {
        const fallback = pickSystemDefaultModel(modelGroups)
        if (fallback) setModelAndDriver(fallback.model)
        setModelParams(undefined)
      }
      // MCP / Skill / Agent 选择态按落盘值恢复（切换对话不丢失）；agents 列表异步到达，
      // selectedAgentRef 由上面的 effect 在列表加载后按 id 回填。
      setMcpService(conv.mcpService ?? [])
      setSkills(conv.skills ?? [])
      setAgentIdState(conv.agentId)
    },
    [conversationsByChat, loadConversation, modelGroups, setModelAndDriver]
  )

  const create = useCallback(
    async (workingDirectory?: string) => {
      try {
        // 并行:新建对话不中断其它对话的流。
        const next = await api.createChat({ driverId, model, workingDirectory })
        activeIdRef.current = next.id
        setActiveId(next.id)
        setConversationsByChat((current) => ({ ...current, [next.id]: next }))
        setMessagesByChat((current) => ({ ...current, [next.id]: [] }))
        await refreshMetas()
        return next.id
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason))
        return undefined
      }
    },
    [driverId, model, refreshMetas, showError]
  )

  const remove = useCallback(
    async (id: string) => {
      // 只终止该对话的流,不影响其它并行对话。
      activeStreams.current.get(id)?.abort()
      activeStreams.current.delete(id)
      const removeWatchdog = streamWatchdogs.current.get(id)
      if (removeWatchdog) {
        clearTimeout(removeWatchdog)
        streamWatchdogs.current.delete(id)
      }
      setStreamingChatIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      setMessagesByChat((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setConversationsByChat((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setDraftsByChat((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setPendingApprovals((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setHintsByChat((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setPendingMessagesByChat((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      if (activeIdRef.current === id) {
        activeIdRef.current = undefined
        setActiveId(undefined)
      }
      try {
        await api.deleteChat(id)
        await refreshMetas()
        showSuccess('对话已删除')
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [refreshMetas, showError, showSuccess]
  )

  const removeGroup = useCallback(
    async (id: string) => {
      try {
        await api.deleteChatGroup(id)
        await refreshMetas()
        showSuccess('分组已删除')
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [refreshMetas, showError, showSuccess]
  )

  const stop = useCallback(() => {
    // 只停当前对话的流。
    const id = activeIdRef.current
    if (id) {
      activeStreams.current.get(id)?.abort()
      const stopWatchdog = streamWatchdogs.current.get(id)
      if (stopWatchdog) {
        clearTimeout(stopWatchdog)
        streamWatchdogs.current.delete(id)
      }
    }
  }, [])

  /**
   * 把 ChatStreamChunk 应用到指定对话的指定 in-flight assistant 消息上。
   * 并行下每个流的事件按 chatId 路由到自己的消息表。
   */
  const applyChunk = useCallback((chatId: string, assistantId: string, chunk: ChatStreamChunk) => {
    if (chunk.type === 'status') {
      // 阶段提示：只更新提示文案，不改动消息列表（keyword 阶段在 start 之前，尚无 part）。
      setHintsByChat((current) => ({ ...current, [chatId]: chunk.text }))
      return
    }
    setMessagesByChat((current) => {
      const list = current[chatId] ?? []
      return {
        ...current,
        [chatId]: list.map((message) => {
          if (message.id !== assistantId) return message
          if (chunk.type === 'part') {
            return { ...message, parts: [...message.parts, chunk.part] }
          }
          if (chunk.type === 'error') {
            // 驱动失败:标记消息为 error 并带上异常详情,界面红色错误块展示。
            const metadata = {
              ...(message.metadata ?? {}),
              status: 'error',
              errorMessage: chunk.message
            } as ChatMessageMetadata
            return { ...message, metadata }
          }
          if (chunk.type === 'done' && chunk.status === 'error') {
            // 兜底:若 error chunk 未送达(理论上不会),done(status=error) 也能让消息进入错误态。
            const metadata = { ...(message.metadata ?? {}), status: 'error' } as ChatMessageMetadata
            return { ...message, metadata }
          }
          // 其它 chunk (start / model / task-created / done) 不影响 parts。
          return message
        })
      }
    })
    if (chunk.type === 'part') {
      // 收到第一个 part 时切换到 streaming 状态(让 UI 的流式动画启用)，并清掉阶段提示（正文开始）。
      setStreamingChatIds((current) => new Set(current).add(chatId))
      setHintsByChat((current) => (current[chatId] ? { ...current, [chatId]: undefined } : current))
    }
  }, [])

  /** 当前对话的草稿（per-chat 隔离）。 */
  const setDraft = useCallback((value: string) => {
    const id = activeIdRef.current
    if (!id) return
    setDraftsByChat((current) => (current[id] === value ? current : { ...current, [id]: value }))
  }, [])

  /** 推送一个 HITL 确认请求到指定对话（缺省挂当前对话），由内联卡片展示。 */
  const pushApproval = useCallback((chatId: string | undefined, request: ChatApprovalRequest) => {
    const id = chatId ?? activeIdRef.current
    if (!id) return
    setPendingApprovals((current) => ({ ...current, [id]: [...(current[id] ?? []), request] }))
    // HITL 等待期间无流式事件到达属正常态,清除看门狗避免误杀(用户可通过停止按钮主动中止)。
    const timer = streamWatchdogs.current.get(id)
    if (timer) {
      clearTimeout(timer)
      streamWatchdogs.current.delete(id)
    }
  }, [])

  /** 响应确认请求（允许/拒绝），并把它从对应对话的队列移除。 */
  const respondApproval = useCallback(async (id: string, confirmed: boolean) => {
    // 乐观移除：先清卡片再响应（IPC 失败时主进程超时兜底默认拒绝，卡片不残留误导）。
    setPendingApprovals((current) => {
      let changed = false
      const next: Record<string, ChatApprovalRequest[]> = {}
      for (const [chatId, list] of Object.entries(current)) {
        const filtered = list.filter((approval) => approval.id !== id)
        if (filtered.length !== list.length) changed = true
        if (filtered.length) next[chatId] = filtered
      }
      return changed ? next : current
    })
    try {
      await api.respondTaskUi({ id, confirmed })
    } catch {
      /* 主进程超时/会话关闭后响应为 no-op，忽略 */
    }
  }, [])

  /** 流结束时未确认的请求默认拒绝（安全兜底）：通知主进程结束等待，并清空该对话卡片。 */
  const flushApprovals = useCallback((chatId: string) => {
    const list = pendingApprovalsRef.current[chatId]
    if (!list || list.length === 0) return
    // 副作用在 updater 外：StrictMode 双执行 updater 也不会重复发响应（主进程端幂等）。
    for (const approval of list) void api.respondTaskUi({ id: approval.id, confirmed: false })
    setPendingApprovals((current) => {
      if (!current[chatId]?.length) return current
      const next = { ...current }
      delete next[chatId]
      return next
    })
  }, [])

  /** 将消息加入指定对话的待发送队列（对话进行中用户预输入）。 */
  const enqueuePending = useCallback((chatId: string, text: string, files?: UserFileAttachment[]) => {
    const message: PendingMessage = { id: crypto.randomUUID(), text, files }
    setPendingMessagesByChat((current) => ({
      ...current,
      [chatId]: [...(current[chatId] ?? []), message]
    }))
  }, [])

  /** 从待发送队列中移除指定消息。 */
  const removePendingMessage = useCallback((chatId: string, messageId: string) => {
    setPendingMessagesByChat((current) => {
      const list = current[chatId]
      if (!list) return current
      const filtered = list.filter((m) => m.id !== messageId)
      if (filtered.length === 0) {
        const next = { ...current }
        delete next[chatId]
        return next
      }
      return { ...current, [chatId]: filtered }
    })
  }, [])

  const send = useCallback(
    async (value?: string, files?: UserFileAttachment[]) => {
      const targetDraft = activeIdRef.current ? (draftsByChat[activeIdRef.current] ?? '') : ''
      const text = (value ?? targetDraft).trim()
      if (!driverId || !model || !text) return undefined
      // 同一对话只允许一个流(并行:不同对话互不影响)。
      const existing = activeIdRef.current ? activeStreams.current.get(activeIdRef.current) : undefined
      if (existing) return undefined

      // 没有当前对话时,自动创建一个。
      let targetId = activeIdRef.current
      if (!targetId) {
        try {
          const created = await api.createChat({ driverId, model })
          targetId = created.id
          activeIdRef.current = created.id
          setActiveId(created.id)
          setConversationsByChat((current) => ({ ...current, [created.id]: created }))
          setMessagesByChat((current) => ({ ...current, [created.id]: [] }))
          await refreshMetas()
        } catch (reason) {
          showError(reason instanceof Error ? reason.message : String(reason))
          return undefined
        }
      }
      const chatId = targetId
      // 按 chatId 精确清草稿(不用 setDraft:其按 activeIdRef 归属,异步创建期间切对话会清错)。
      setDraftsByChat((current) => (current[chatId] ? { ...current, [chatId]: '' } : current))
      const streamId = crypto.randomUUID()
      const userId = crypto.randomUUID()
      const assistantId = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      const userRecord: StoredMessageRecord = {
        id: userId,
        role: 'user',
        createdAt,
        driverId,
        raw: { kind: 'user', text, ...(files?.length ? { files } : {}) }
      }
      const userParts: DriverPart[] = [
        { driverId, type: 'text', text },
        ...(files ?? []).map((f) => ({
          driverId,
          type: 'file' as const,
          mediaType: f.mediaType,
          localPath: f.localPath,
          filename: f.filename
        }))
      ]
      const userMessage: ChatMessage = { ...userRecord, parts: userParts }
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        createdAt,
        driverId,
        raw: { kind: 'assistant', parts: [] },
        parts: []
      }
      // 立刻把 user 消息和"在飞"的 assistant 消息都 push 进对应对话,UI 立即看到。
      setMessagesByChat((current) => ({
        ...current,
        [chatId]: [...(current[chatId] ?? []), userMessage, assistantMessage]
      }))
      setStreamingChatIds((current) => new Set(current).add(chatId))

      const session = transport.start({
        streamId,
        chatId,
        driverId,
        model,
        modelParams,
        message: { id: userId, text, createdAt, ...(files?.length ? { files } : {}) },
        mode: (taskCreationEnabled ? 'task-create' : 'chat') satisfies ChatAgentMode,
        mcpService,
        skills,
        agentId,
        systemPrompt: selectedAgentRef.current?.systemPrompt,
        onEvent: (event) => {
          const chunk = event.chunk
          // 看门狗：每次收到事件重置计时器，防止主进程崩溃/IPC 断连后残留流状态。
          const existingTimer = streamWatchdogs.current.get(chatId)
          if (existingTimer) clearTimeout(existingTimer)
          streamWatchdogs.current.set(
            chatId,
            setTimeout(() => {
              if (activeStreams.current.get(chatId)?.streamId === streamId) {
                // HITL 等待用户响应期间无事件到达属正常态,不视为流死亡(用户可通过停止按钮中止)。
                if (pendingApprovalsRef.current[chatId]?.length) return
                activeStreams.current.get(chatId)?.abort()
                activeStreams.current.delete(chatId)
                streamWatchdogs.current.delete(chatId)
                setStreamingChatIds((current) => {
                  const next = new Set(current)
                  next.delete(chatId)
                  return next
                })
                setHintsByChat((current) => (current[chatId] ? { ...current, [chatId]: undefined } : current))
                flushApprovals(chatId)
                void refreshMetas()
              }
            }, STREAM_WATCHDOG_MS)
          )
          if (!chunk) return
          applyChunk(chatId, assistantId, chunk)
        },
        onError: (error) => {
          showError(error.message)
          // 把异常详情挂到在飞 assistant 消息上,界面红色错误块展示(持久化走落盘 errorMessage)。
          setMessagesByChat((current) => {
            const list = current[chatId] ?? []
            return {
              ...current,
              [chatId]: list.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      metadata: {
                        ...(message.metadata ?? {}),
                        status: 'error',
                        errorMessage: error.message
                      } as ChatMessageMetadata
                    }
                  : message
              )
            }
          })
        }
      })

      activeStreams.current.set(chatId, {
        streamId,
        chatId,
        driverId,
        model,
        userMessageId: userId,
        assistant: {
          id: assistantId,
          driverId,
          parts: [],
          metadata: {} as Record<string, never>
        },
        abort: () => session.abort(),
        closed: session.closed
      })

      // 流结束(成功 / 失败 / 主动停止)时,清理该对话的流状态并刷新 metas。
      void session.closed.then(async () => {
        // 清理看门狗：流已正常结束，不再需要超时检测。
        const watchdog = streamWatchdogs.current.get(chatId)
        if (watchdog) {
          clearTimeout(watchdog)
          streamWatchdogs.current.delete(chatId)
        }
        if (activeStreams.current.get(chatId)?.streamId !== streamId) return
        activeStreams.current.delete(chatId)
        setStreamingChatIds((current) => {
          const next = new Set(current)
          next.delete(chatId)
          return next
        })
        setHintsByChat((current) => (current[chatId] ? { ...current, [chatId]: undefined } : current))
        // 流结束:该对话未确认的 HITL 请求默认拒绝(替代原全局 task:ui-clear)。
        flushApprovals(chatId)
        await refreshMetas()
        // 自动发送排队中的下一条待发送消息。
        const pending = pendingMessagesByChatRef.current[chatId]
        if (pending && pending.length > 0) {
          const [next, ...rest] = pending
          setPendingMessagesByChat((current) => {
            const updated = current[chatId]?.filter((m) => m.id !== next.id) ?? []
            if (updated.length === 0) {
              const n = { ...current }
              delete n[chatId]
              return n
            }
            return { ...current, [chatId]: rest }
          })
          void send(next.text, next.files)
        }
      })

      return chatId
    },
    [
      agentId,
      applyChunk,
      draftsByChat,
      driverId,
      flushApprovals,
      mcpService,
      model,
      modelParams,
      refreshMetas,
      showError,
      skills,
      taskCreationEnabled
    ]
  )

  // === 对外派生(保持与旧单流版相同的形状,兼容 UI) ===========================
  const conversation = activeId ? conversationsByChat[activeId] : undefined
  /** 当前对话的草稿(per-chat 隔离)。 */
  const draft = activeId ? (draftsByChat[activeId] ?? '') : ''
  const messages = useMemo(() => (activeId ? (messagesByChat[activeId] ?? []) : []), [activeId, messagesByChat])
  const streaming = Boolean(activeId && streamingChatIds.has(activeId))
  const status: ChatStatus = streaming ? 'streaming' : 'idle'
  const hint = activeId ? hintsByChat[activeId] : undefined
  /** 当前对话的确认请求(内联卡片渲染源)。 */
  const approvals = useMemo(() => (activeId ? (pendingApprovals[activeId] ?? []) : []), [activeId, pendingApprovals])
  /** 当前对话的待发送消息队列。 */
  const pendingMessages = useMemo(
    () => (activeId ? (pendingMessagesByChat[activeId] ?? []) : []),
    [activeId, pendingMessagesByChat]
  )
  /** 当前选中模型是否支持视觉/多模态输入（控制附件入口显隐）。 */
  const modelSupportsVision = useMemo(() => {
    if (!model) return false
    for (const group of modelGroups) {
      const found = group.models.find((m) => m.value === model)
      if (found) return Boolean(found.isVl)
    }
    return false
  }, [model, modelGroups])

  return useMemo(
    () => ({
      metas,
      groups,
      activeId,
      conversation,
      messages,
      draft,
      streaming,
      status,
      hint,
      /** 正在生成的对话集合（侧边栏生成状态用）。 */
      streamingChatIds,
      /** 当前对话待确认的 HITL 请求（内联卡片用）。 */
      approvals,
      /** 当前对话的待发送消息队列。 */
      pendingMessages,
      modelGroups,
      model,
      driverId,
      modelParams,
      modelSupportsVision,
      taskCreationEnabled,
      taskBackend,
      mcpService,
      skills,
      agentId,
      setDraft,
      setModelAndDriver,
      setModelParams,
      setDriverId,
      setTaskCreationEnabled,
      setMcpService,
      setSkills,
      setAgentId,
      select,
      create,
      remove,
      removeGroup,
      send,
      stop,
      pushApproval,
      respondApproval,
      enqueuePending,
      removePendingMessage,
      refreshMetas
    }),
    [
      metas,
      groups,
      activeId,
      conversation,
      messages,
      draft,
      streaming,
      status,
      hint,
      streamingChatIds,
      approvals,
      pendingMessages,
      modelGroups,
      model,
      driverId,
      modelParams,
      taskCreationEnabled,
      taskBackend,
      mcpService,
      skills,
      agentId,
      setDraft,
      setModelAndDriver,
      setModelParams,
      setDriverId,
      setTaskCreationEnabled,
      setMcpService,
      setSkills,
      setAgentId,
      select,
      create,
      remove,
      removeGroup,
      send,
      stop,
      pushApproval,
      respondApproval,
      enqueuePending,
      removePendingMessage,
      refreshMetas
    ]
  )
}

/** 测试/调试辅助。 */
export const __testHelpers = { textOf, driverOfModelValue }
