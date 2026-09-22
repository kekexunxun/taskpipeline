import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolApprovalCard, type ChatApprovalRequest } from './ToolApprovalCard'

describe('ToolApprovalCard（HITL 内联确认条，对话/任务板块共用）', () => {
  const approval: ChatApprovalRequest = {
    id: 'a1',
    method: 'confirm',
    title: '允许执行 Bash?',
    message: 'rm -rf build',
    timeout: 60_000
  }

  it('只展示标题与操作按钮，message 不再重复渲染（详情已在消息流工具行展示）', () => {
    render(<ToolApprovalCard approval={approval} onRespond={vi.fn()} />)
    expect(screen.getByText('允许执行 Bash?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '允许' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument()
    expect(screen.queryByText('rm -rf build')).not.toBeInTheDocument()
  })

  it('允许/拒绝按钮回调正确参数', () => {
    const onRespond = vi.fn()
    render(<ToolApprovalCard approval={approval} onRespond={onRespond} />)
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(onRespond).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(onRespond).toHaveBeenCalledWith(false)
  })

  it('组件侧不做超时自动响应（超时拒绝由主进程兜底）', () => {
    vi.useFakeTimers()
    try {
      const onRespond = vi.fn()
      render(<ToolApprovalCard approval={{ ...approval, timeout: 5_000 }} onRespond={onRespond} />)
      expect(onRespond).not.toHaveBeenCalled()
      vi.advanceTimersByTime(60_000)
      expect(onRespond).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('无 timeout 时同样不自动触发响应', () => {
    vi.useFakeTimers()
    try {
      const onRespond = vi.fn()
      render(<ToolApprovalCard approval={{ ...approval, timeout: undefined }} onRespond={onRespond} />)
      vi.advanceTimersByTime(10_000)
      expect(onRespond).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
