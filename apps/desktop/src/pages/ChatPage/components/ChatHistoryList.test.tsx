import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatHistoryList } from './ChatHistoryList'
import type { ChatConversationMeta, ChatGroup } from '@/api'

const noop = {
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  onCreateInDirectory: vi.fn(),
  onShowWelcome: vi.fn(),
  onDelete: vi.fn(),
  onDeleteGroup: vi.fn()
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

function directoryGroup(overrides: Partial<ChatGroup> & { directory: string }): ChatGroup {
  return {
    id: crypto.randomUUID(),
    chatType: 'directory',
    directories: [overrides.directory],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.directory, // 用 directory 做唯一 updatedAt 方便排序测试
    ...overrides
  }
}

describe('ChatHistoryList', () => {
  it('keeps an empty directory group header after its conversations are deleted', () => {
    // 目录下所有会话已删除:metas 为空,但 group 实体仍在
    render(
      <ChatHistoryList
        metas={[]}
        groups={[directoryGroup({ directory: '/project/x', updatedAt: '2026-01-01T00:00:00.000Z' })]}
        {...noop}
      />
    )
    // 项目组头仍显示(目录名)和数量 0
    expect(screen.getByText('x')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('shows the conversation count and items for a group with chats', () => {
    render(
      <ChatHistoryList
        metas={[meta({ id: 'c1', workingDirectory: '/project/x', title: '发布检查' })]}
        groups={[directoryGroup({ directory: '/project/x', updatedAt: '2026-01-01T00:00:00.000Z' })]}
        {...noop}
      />
    )
    expect(screen.getByText('发布检查')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('orders groups by latest activity, empty groups by updatedAt', () => {
    render(
      <ChatHistoryList
        metas={[meta({ id: 'c1', workingDirectory: '/project/old', updatedAt: '2026-01-10T00:00:00.000Z' })]}
        groups={[
          directoryGroup({ directory: '/project/empty-recent', updatedAt: '2026-02-01T00:00:00.000Z' }),
          directoryGroup({ directory: '/project/old', updatedAt: '2026-01-01T00:00:00.000Z' }),
          directoryGroup({ directory: '/project/empty-old', updatedAt: '2025-12-01T00:00:00.000Z' })
        ]}
        {...noop}
      />
    )
    // 组头按最近活动倒序:空 group(2月) > 有会话 group(1月10日) > 空 group(12月)
    const headers = screen
      .getAllByRole('button')
      .filter(
        (btn) =>
          btn.querySelector('span')?.textContent === 'empty-recent' ||
          btn.querySelector('span')?.textContent === 'old' ||
          btn.querySelector('span')?.textContent === 'empty-old'
      )
    expect(headers.length).toBe(3)
    expect(headers[0]?.textContent).toContain('empty-recent')
    expect(headers[1]?.textContent).toContain('old')
    expect(headers[2]?.textContent).toContain('empty-old')
  })
})
