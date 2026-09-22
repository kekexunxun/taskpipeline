import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChat } from './useChat'
import type { ChatConversation, ChatReattachState, StoredMessage } from '@/api'

/**
 * useChat 多对话并行 + 内联 HITL 核心逻辑测试。
 * mock api：listChats/listChatGroups/listAgents/listTaskBackends 返回空，createChat/getChat 返回内存对话。
 * 注意：mock 的 useFeedback / useChatModels 必须返回稳定引用（真实实现是 useCallback），
 * 否则挂载 effect 的依赖（showError / modelGroups）每次渲染都变化 → 无限重渲染循环。
 */

const mockApi = vi.hoisted(() => {
  const chatListeners = new Set<(event: unknown) => void>()
  const conv = (id: string): ChatConversation => ({
    id,
    title: `对话 ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    driverId: 'qoder',
    model: 'qoder:lite',
    messageCount: 0,
    messages: []
  })
  return {
    chatListeners,
    conv,
    /** reattach 快照 mock：默认无在飞流；单测内赋值后挂载时生效。 */
    reattachable: { streams: [], chats: [] } as ChatReattachState,
    getChat: vi.fn(async (id: string) => ({ conversation: conv(id), messages: [] })),
    getChatReattachState: vi.fn(async () => mockApi.reattachable),
    createChat: vi.fn(async ({ driverId, model }: { driverId?: string; model?: string }) => ({
      ...conv('c1'),
      driverId,
      model
    })),
    respondTaskUi: vi.fn(async () => undefined),
    abortChat: vi.fn(async () => undefined),
    /** 向所有监听广播一条流事件（模拟主进程 dispatch）。 */
    fire(event: unknown) {
      chatListeners.forEach((callback) => callback(event))
    }
  }
})

const mockHooks = vi.hoisted(() => {
  const feedback = { showError: vi.fn(), showSuccess: vi.fn() }
  // 需含可用的 qoder 模型组：select 恢复配置走 isModelAvailable/driverOfModelValue 判定。
  const models = {
    modelGroups: [{ driverId: 'qoder', models: [{ value: 'qoder:lite', displayName: 'Lite' }] }] as never[]
  }
  return { feedback, models }
})

vi.mock('@/api', () => ({
  api: {
    listChats: vi.fn(async () => []),
    listChatGroups: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    listTaskBackends: vi.fn(async () => []),
    getChat: mockApi.getChat,
    createChat: mockApi.createChat,
    deleteChat: vi.fn(async () => undefined),
    startChatStream: vi.fn(async () => undefined),
    abortChat: mockApi.abortChat,
    getChatReattachState: mockApi.getChatReattachState,
    respondTaskUi: mockApi.respondTaskUi,
    onChatStreamEvent: vi.fn((callback: (event: unknown) => void) => {
      mockApi.chatListeners.add(callback)
      return () => mockApi.chatListeners.delete(callback)
    }),
    onChatCompaction: vi.fn(() => () => undefined)
  }
}))

vi.mock('@/hooks/useChatModels', () => ({ useChatModels: () => mockHooks.models }))
vi.mock('@/hooks/useGlobalFeedback', () => ({ useFeedback: () => mockHooks.feedback }))

describe('useChat（多对话并行 + 内联 HITL）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.chatListeners.clear()
    mockApi.reattachable = { streams: [], chats: [] }
  })

  it('draft 按对话隔离：切对话不串草稿，切回恢复', async () => {
    const { result } = renderHook(() => useChat())
    await act(async () => {
      await result.current.select('c1')
    })
    act(() => result.current.setDraft('对话 A 的草稿'))
    expect(result.current.draft).toBe('对话 A 的草稿')

    await act(async () => {
      await result.current.select('c2')
    })
    expect(result.current.draft).toBe('')
    expect(result.current.activeId).toBe('c2')

    await act(async () => {
      await result.current.select('c1')
    })
    expect(result.current.draft).toBe('对话 A 的草稿')
  })

  it('pushApproval 按 conversationId 归属 + respondApproval 响应后从队列移除', async () => {
    const { result } = renderHook(() => useChat())
    await act(async () => {
      await result.current.select('c1')
    })
    act(() => {
      result.current.pushApproval('c1', {
        id: 'a1',
        method: 'confirm',
        title: '允许执行 Bash?',
        message: 'rm -rf build'
      })
    })
    expect(result.current.approvals).toHaveLength(1)
    // 并行归属：推到 c2 的请求不污染当前 c1 视图
    act(() => {
      result.current.pushApproval('c2', { id: 'a2', method: 'confirm', title: 'B 对话请求' })
    })
    expect(result.current.approvals).toHaveLength(1)

    await act(async () => {
      await result.current.respondApproval('a1', { confirmed: true })
    })
    expect(mockApi.respondTaskUi).toHaveBeenCalledWith({ id: 'a1', confirmed: true })
    await waitFor(() => expect(result.current.approvals).toHaveLength(0))
  })

  it('切换对话不 abort 进行中的流（并行核心）', async () => {
    const { result } = renderHook(() => useChat())
    await act(async () => {
      await result.current.select('c1')
    })
    await act(async () => {
      await result.current.send('你好')
    })
    expect(result.current.streaming).toBe(true)
    expect(result.current.messages).toHaveLength(2) // user + in-flight assistant
    await act(async () => {
      await result.current.select('c2')
    })
    // 切走不中断：c1 仍在生成（streamingChatIds 保留 c1）
    expect(result.current.streamingChatIds.has('c1')).toBe(true)
    expect(result.current.streaming).toBe(false) // 当前是 c2
    // 切回 c1 消息仍在内存（未落盘的 in-flight 消息）
    await act(async () => {
      await result.current.select('c1')
    })
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.streaming).toBe(true)
  })

  it('reattach：重挂载接管在飞流，seq 水位去重续渲染，done 收口', async () => {
    const stalePart = { driverId: 'qoder', type: 'text', text: '旧快照' } as const
    const inFlight: StoredMessage = {
      id: 'a9',
      role: 'assistant',
      createdAt: '2026-01-01T00:00:01.000Z',
      driverId: 'qoder',
      raw: { kind: 'assistant', parts: [stalePart] },
      parts: [stalePart]
    }
    mockApi.reattachable = {
      streams: [
        {
          chatId: 'c9',
          streamId: 's9',
          driverId: 'qoder',
          model: 'qoder:lite',
          assistantId: 'a9',
          createdAt: '2026-01-01T00:00:01.000Z',
          seq: 3,
          parts: [{ driverId: 'qoder', type: 'text', text: '内存新快照' }]
        }
      ],
      chats: [{ conversation: mockApi.conv('c9'), messages: [inFlight] }]
    }
    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.streamingChatIds.has('c9')).toBe(true))
    await act(async () => {
      await result.current.select('c9')
    })
    // 磁盘滞后快照被内存 parts 覆盖（同 assistantId 不重复成两条）
    expect(result.current.messages).toHaveLength(1)
    const messageOf = () => result.current.messages[0]!
    expect(
      messageOf()
        .parts.map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
    ).toBe('内存新快照')

    // 重叠事件（seq ≤ 水位 3）：已含在快照里，不重应用
    act(() =>
      mockApi.fire({
        chatId: 'c9',
        streamId: 's9',
        driverId: 'qoder',
        seq: 3,
        chunk: { type: 'part', part: { driverId: 'qoder', type: 'text', text: '旧快照' } }
      })
    )
    expect(messageOf().parts).toHaveLength(1)

    // 续流事件（seq > 水位）：正常应用
    act(() =>
      mockApi.fire({
        chatId: 'c9',
        streamId: 's9',
        driverId: 'qoder',
        seq: 4,
        chunk: { type: 'part', part: { driverId: 'qoder', type: 'text', text: ' + 续流' } }
      })
    )
    expect(
      messageOf()
        .parts.map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
    ).toBe('内存新快照 + 续流')

    // done chunk → 解除接管，退出流式态
    act(() =>
      mockApi.fire({
        chatId: 'c9',
        streamId: 's9',
        driverId: 'qoder',
        seq: 5,
        chunk: { type: 'done', status: 'done' }
      })
    )
    await waitFor(() => expect(result.current.streamingChatIds.has('c9')).toBe(false))
    // 后续 done:true 信封不再影响状态
    act(() => mockApi.fire({ chatId: 'c9', streamId: 's9', driverId: 'qoder', done: true }))
    expect(result.current.streamingChatIds.has('c9')).toBe(false)
  })

  it('reattach：stop 对无活会话的接管流按登记 streamId 请主进程 abort', async () => {
    mockApi.reattachable = {
      streams: [
        {
          chatId: 'c9',
          streamId: 's9',
          driverId: 'qoder',
          model: 'qoder:lite',
          assistantId: 'a9',
          createdAt: '2026-01-01T00:00:01.000Z',
          seq: 1,
          parts: [{ driverId: 'qoder', type: 'text', text: '在飞' }]
        }
      ],
      chats: [{ conversation: mockApi.conv('c9'), messages: [] }]
    }
    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.streamingChatIds.has('c9')).toBe(true))
    await act(async () => {
      await result.current.select('c9')
    })
    act(() => result.current.stop())
    expect(mockApi.abortChat).toHaveBeenCalledWith({ chatId: 'c9', streamId: 's9' })
  })
})
