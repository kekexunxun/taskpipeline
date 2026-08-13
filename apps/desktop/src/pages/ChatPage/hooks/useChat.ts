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
  type ChatProject,
  type ChatStreamChunk,
  type DriverPart,
  type ModelParams,
  type StoredMessageRecord
} from '@/api'
import { useChatModels } from '@/hooks/useChatModels'
import { useFeedback } from '@/hooks/useGlobalFeedback'
import { isModelAvailable, isOpenAIModelValue, pickSystemDefaultModel } from '@/utils/chat-models'

const transport = new ElectronChatTransport()

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

export function useChat() {
  const { showError, showSuccess } = useFeedback()
  const [metas, setMetas] = useState<ChatConversationMeta[]>([])
  const [projects, setProjects] = useState<ChatProject[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [conversation, setConversation] = useState<ChatConversation>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
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
  const [status, setStatus] = useState<ChatStatus>('idle')
  /** 阶段提示文案：主进程关键词提取/记忆检索期间推 status chunk 展示，首个 part 到达后清空。 */
  const [hint, setHint] = useState<string>()
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

  const activeStream = useRef<ActiveStream | undefined>(undefined)

  const refreshMetas = useCallback(async () => {
    try {
      const [nextMetas, nextProjects] = await Promise.all([api.listChats(), api.listChatProjects()])
      setMetas(nextMetas)
      setProjects(nextProjects)
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

  const loadConversation = useCallback(
    async (id: string) => {
      try {
        const next = await api.getChat(id)
        if (!next) {
          setMessages([])
          return
        }
        setConversation(next.conversation)
        setMessages(next.messages)
        // 存储模型失效(profile 删除 / 模型下线)时回落系统默认,不动存储值。
        const stored = next.conversation.model
        const storedValid = Boolean(stored) && isModelAvailable(modelGroups, stored)
        if (stored && storedValid) {
          setModelAndDriver(stored)
          if (next.conversation.driverId) setDriverId(next.conversation.driverId)
          setModelParams(next.conversation.modelParams)
        } else {
          const fallback = pickSystemDefaultModel(modelGroups)
          if (fallback) setModelAndDriver(fallback.model)
          setModelParams(undefined)
        }
        // MCP / Skill / Agent 选择态按落盘值恢复（切换对话不丢失）；agents 列表异步到达，
        // selectedAgentRef 由上面的 effect 在列表加载后按 id 回填。
        setMcpService(next.conversation.mcpService ?? [])
        setSkills(next.conversation.skills ?? [])
        setAgentIdState(next.conversation.agentId)
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [modelGroups, setModelAndDriver, showError]
  )

  const select = useCallback(
    async (id: string | undefined) => {
      activeStream.current?.abort()
      activeStream.current = undefined
      setStatus('idle')
      setHint(undefined)
      setActiveId(id)
      setConversation(undefined)
      setMessages([])
      if (!id) return
      await loadConversation(id)
    },
    [loadConversation]
  )

  const create = useCallback(
    async (workingDirectory?: string) => {
      try {
        activeStream.current?.abort()
        activeStream.current = undefined
        setStatus('idle')
        const next = await api.createChat({ driverId, model, workingDirectory })
        setActiveId(next.id)
        setConversation(next)
        setMessages([])
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
      try {
        if (activeId === id) {
          activeStream.current?.abort()
          activeStream.current = undefined
          setStatus('idle')
          setHint(undefined)
          setActiveId(undefined)
          setConversation(undefined)
          setMessages([])
        }
        await api.deleteChat(id)
        await refreshMetas()
        showSuccess('对话已删除')
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [activeId, refreshMetas, showError, showSuccess]
  )

  const stop = useCallback(() => {
    activeStream.current?.abort()
  }, [])

  const send = useCallback(
    async (value?: string) => {
      const text = (value ?? draft).trim()
      if (!driverId || !model || !text) return undefined
      if (activeStream.current) return undefined
      setDraft('')

      // 没有当前对话时,自动创建一个。
      let targetId = activeId
      if (!targetId) {
        try {
          const created = await api.createChat({ driverId, model })
          targetId = created.id
          setActiveId(created.id)
          setConversation(created)
          setMessages([])
          await refreshMetas()
        } catch (reason) {
          showError(reason instanceof Error ? reason.message : String(reason))
          return undefined
        }
      }
      const streamId = crypto.randomUUID()
      const userId = crypto.randomUUID()
      const assistantId = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      const userRecord: StoredMessageRecord = {
        id: userId,
        role: 'user',
        createdAt,
        driverId,
        raw: { kind: 'user', text }
      }
      const userMessage: ChatMessage = { ...userRecord, parts: [{ driverId, type: 'text', text }] }
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        createdAt,
        driverId,
        raw: { kind: 'assistant', parts: [] },
        parts: []
      }
      // 立刻把 user 消息和"在飞"的 assistant 消息都 push 进去,UI 立即看到。
      setMessages((current) => [...current, userMessage, assistantMessage])
      setStatus('submitted')
      setHint(undefined)

      const session = transport.start({
        streamId,
        chatId: targetId!,
        driverId,
        model,
        modelParams,
        message: { id: userId, text, createdAt },
        mode: (taskCreationEnabled ? 'task-create' : 'chat') satisfies ChatAgentMode,
        mcpService,
        skills,
        agentId,
        systemPrompt: selectedAgentRef.current?.systemPrompt,
        onEvent: (event) => {
          const chunk = event.chunk
          if (!chunk) return
          applyChunk(assistantId, chunk)
        },
        onError: (error) => {
          showError(error.message)
          setStatus('error')
          // 把异常详情挂到在飞 assistant 消息上,界面红色错误块展示(持久化走落盘 errorMessage)。
          setMessages((current) =>
            current.map((message) =>
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
          )
        }
      })

      activeStream.current = {
        streamId,
        chatId: targetId!,
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
      }

      // 流结束(成功 / 失败 / 主动停止)时,重置 status 并刷新 metas。
      void session.closed.then(async () => {
        if (activeStream.current?.streamId !== streamId) return
        activeStream.current = undefined
        setStatus('idle')
        setHint(undefined)
        await refreshMetas()
      })

      return targetId
    },
    [
      activeId,
      agentId,
      draft,
      driverId,
      mcpService,
      model,
      modelParams,
      refreshMetas,
      showError,
      skills,
      taskCreationEnabled
    ]
  )

  /**
   * 把 ChatStreamChunk 应用到指定 in-flight assistant 消息上。
   * 使用 functional setState 保证多次事件间的状态不会相互覆盖。
   */
  const applyChunk = useCallback((assistantId: string, chunk: ChatStreamChunk) => {
    if (chunk.type === 'status') {
      // 阶段提示：只更新提示文案，不改动消息列表（keyword 阶段在 start 之前，尚无 part）。
      setHint(chunk.text)
      return
    }
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== assistantId) return message
        if (chunk.type === 'part') {
          const next = [...message.parts, chunk.part]
          return { ...message, parts: next }
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
          const metadata = {
            ...(message.metadata ?? {}),
            status: 'error'
          } as ChatMessageMetadata
          return { ...message, metadata }
        }
        // 其它 chunk (start / model / task-created / done) 不影响 parts。
        return message
      })
    )
    if (chunk.type === 'part') {
      // 收到第一个 part 时切换到 streaming 状态(让 UI 的流式动画启用)，并清掉阶段提示（正文开始）。
      setStatus('streaming')
      setHint(undefined)
    }
    if (chunk.type === 'error') {
      setStatus('error')
      setHint(undefined)
    }
  }, [])

  const streaming = status === 'streaming' || status === 'submitted'

  return useMemo(
    () => ({
      metas,
      projects,
      activeId,
      conversation,
      messages,
      draft,
      streaming,
      status,
      hint,
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
      send,
      stop
    }),
    [
      metas,
      projects,
      activeId,
      conversation,
      messages,
      draft,
      streaming,
      status,
      hint,
      modelGroups,
      model,
      driverId,
      modelParams,
      taskCreationEnabled,
      taskBackend,
      mcpService,
      skills,
      agentId,
      select,
      create,
      remove,
      send,
      stop
    ]
  )
}

/** 测试/调试辅助。 */
export const __testHelpers = { textOf, driverOfModelValue }
