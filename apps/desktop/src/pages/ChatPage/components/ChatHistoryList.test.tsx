import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatHistoryList } from './ChatHistoryList'
import type { ChatConversationMeta } from '@/api'

const noop = {
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  onCreateInDirectory: vi.fn(),
  onDelete: vi.fn()
}

function meta(overrides: Partial<ChatConversationMeta>): ChatConversationMeta {
  return {
    id: 'chat-a',
    title: '测试对话',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 1,
    ...overrides
  }
}

describe('ChatHistoryList', () => {
  it('keeps an empty project group after its conversations are deleted', () => {
    // 目录下所有会话已删除:metas 为空,但项目实体仍在
    render(
      <ChatHistoryList
        metas={[]}
        projects={[{ directory: '/project/x', lastActiveAt: '2026-01-01T00:00:00.000Z' }]}
        {...noop}
      />
    )
    // 项目组头仍显示(目录名),并提示「没有对话」
    expect(screen.getByText('x')).toBeInTheDocument()
    expect(screen.getByText(/没有对话/)).toBeInTheDocument()
  })

  it('shows the conversation count and items for a project with chats', () => {
    render(
      <ChatHistoryList
        metas={[meta({ id: 'c1', workingDirectory: '/project/x', title: '发布检查' })]}
        projects={[{ directory: '/project/x', lastActiveAt: '2026-01-01T00:00:00.000Z' }]}
        {...noop}
      />
    )
    expect(screen.getByText('发布检查')).toBeInTheDocument()
    expect(screen.queryByText('没有对话')).not.toBeInTheDocument()
  })

  it('orders project groups by latest activity, empty projects by lastActiveAt', () => {
    render(
      <ChatHistoryList
        metas={[meta({ id: 'c1', workingDirectory: '/project/old', updatedAt: '2026-01-10T00:00:00.000Z' })]}
        projects={[
          { directory: '/project/empty-recent', lastActiveAt: '2026-02-01T00:00:00.000Z' },
          { directory: '/project/old', lastActiveAt: '2026-01-01T00:00:00.000Z' },
          { directory: '/project/empty-old', lastActiveAt: '2025-12-01T00:00:00.000Z' }
        ]}
        {...noop}
      />
    )
    const headers = screen.getAllByRole('button', { name: /在 .* 新建对话/ })
    // 组头按最近活动倒序:空项目(2月) > 有会话项目(1月10日) > 空项目(12月)
    expect(headers[0]?.getAttribute('aria-label')).toContain('empty-recent')
    expect(headers[1]?.getAttribute('aria-label')).toContain('old')
    expect(headers[2]?.getAttribute('aria-label')).toContain('empty-old')
  })
})
