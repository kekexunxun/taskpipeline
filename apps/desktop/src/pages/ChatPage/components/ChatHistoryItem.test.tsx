import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatHistoryItem } from './ChatHistoryItem'

describe('ChatHistoryItem', () => {
  it('requires confirmation before deleting a conversation', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(
      <ChatHistoryItem
        active={false}
        onClick={vi.fn()}
        onDelete={onDelete}
        meta={{
          id: 'chat-a',
          title: '发布检查',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          messageCount: 2
        }}
      />
    )
    // 点击三点菜单按钮打开下拉
    await user.click(screen.getByRole('button', { name: '对话操作 发布检查' }))
    // 点击下拉菜单中的"删除"项
    await user.click(screen.getByText('删除'))
    // 此时应弹出确认对话框,删除尚未执行
    expect(onDelete).not.toHaveBeenCalled()
    // 点击确认对话框中的"删除"按钮
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })
})
