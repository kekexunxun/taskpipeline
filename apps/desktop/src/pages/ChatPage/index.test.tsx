import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPage from './index'

const mocks = vi.hoisted(() => ({
  injectGuidance: vi.fn<() => Promise<void>>(),
  showError: vi.fn(),
  chat: {
    activeId: 'c1',
    streaming: true,
    messages: [],
    metas: [],
    groups: [],
    modelGroups: [{ driverId: 'qoder', models: [{ value: 'qoder:auto' }] }],
    model: 'qoder:auto',
    compactingChatIds: new Set<string>(),
    pendingMessages: [{ id: 'p1', text: '不要独立一行' }],
    conversation: { title: '测试对话' },
    pushApproval: vi.fn()
  }
}))

vi.mock('./hooks/useChat', () => ({ useChat: () => mocks.chat }))
vi.mock('@/api', () => ({
  api: { injectChatGuidance: mocks.injectGuidance, onTaskEvent: () => () => undefined }
}))
vi.mock('@/hooks/useGlobalFeedback', () => ({ useFeedback: () => ({ showError: mocks.showError }) }))
vi.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: mocks.chat.activeId }),
  useNavigate: () => vi.fn()
}))
vi.mock('./components/ChatHistoryList', () => ({ ChatHistoryList: () => null }))
vi.mock('./components/ChatConversation', () => ({ ChatConversation: () => null }))
vi.mock('./components/ChatComposer', () => ({ ChatComposer: () => null }))
vi.mock('./components/ChatModelSelector', () => ({ ChatModelSelector: () => null }))
vi.mock('./components/ChatMcpSelector', () => ({ ChatMcpSelector: () => null }))
vi.mock('./components/ChatSkillSelector', () => ({ ChatSkillSelector: () => null }))
vi.mock('./components/ChatAgentSelector', () => ({ ChatAgentSelector: () => null }))
vi.mock('./components/ChatWelcomeView', () => ({ ChatWelcomeView: () => null }))
vi.mock('./components/ChatSidePanel', () => ({ ChatSidePanel: () => null }))
vi.mock('./components/WorkspaceCreateDialog', () => ({ WorkspaceCreateDialog: () => null }))
vi.mock('./components/TaskCreationTool', () => ({ TaskCreationTool: () => null }))
vi.mock('./components/ChatModeToggle', () => ({ ChatModeToggle: () => null }))
vi.mock('@/pages/CodingPage/components/UiRequestDialog', () => ({ UiRequestDialog: () => null }))

describe('ChatPage 引导按钮', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.injectGuidance.mockReset()
    mocks.chat.activeId = 'c1'
    mocks.chat.streaming = true
    mocks.chat.pendingMessages = [{ id: 'p1', text: '不要独立一行' }]
  })

  it('字号覆盖全局继承，连点只发送一次，确认期间 loading、成功后禁用', async () => {
    let confirm!: () => void
    mocks.injectGuidance.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve
        })
    )
    render(<ChatPage />)
    const button = screen.getByRole('button', { name: '引导' })
    expect(button).toHaveClass('text-[10px]!')
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(mocks.injectGuidance).toHaveBeenCalledExactlyOnceWith('c1', '不要独立一行')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveTextContent('引导中')
    expect(button.querySelector('.animate-spin')).not.toBeNull()
    await act(async () => confirm())
    expect(button).toHaveTextContent('已引导')
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(mocks.injectGuidance).toHaveBeenCalledOnce()
  })

  it('投递失败时结束 loading 并显示错误，不允许重复投递', async () => {
    mocks.injectGuidance.mockRejectedValue(new Error('Qoder 未采用引导消息'))
    render(<ChatPage />)
    fireEvent.click(screen.getByRole('button', { name: '引导' }))
    const button = await screen.findByRole('button', { name: '引导失败' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(mocks.showError).toHaveBeenCalledWith('Qoder 未采用引导消息')
  })

  it('切换对话后，旧请求的完成状态不会污染新消息', async () => {
    let confirm!: () => void
    mocks.injectGuidance.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve
        })
    )
    const { rerender } = render(<ChatPage />)
    fireEvent.click(screen.getByRole('button', { name: '引导' }))
    mocks.chat.activeId = 'c2'
    mocks.chat.pendingMessages = [{ id: 'p2', text: '另一个对话' }]
    rerender(<ChatPage />)
    await act(async () => confirm())
    expect(screen.getByRole('button', { name: '引导' })).toBeEnabled()
    mocks.chat.activeId = 'c1'
    mocks.chat.pendingMessages = [{ id: 'p1', text: '不要独立一行' }]
    rerender(<ChatPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: '已引导' })).toBeDisabled())
  })

  it('没有进行中的回复时不允许引导', () => {
    mocks.chat.streaming = false
    render(<ChatPage />)
    const button = screen.getByRole('button', { name: '引导' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(mocks.injectGuidance).not.toHaveBeenCalled()
  })
})
