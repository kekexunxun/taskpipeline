import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolApprovalCard, type ChatApprovalRequest } from './ToolApprovalCard'

describe('ToolApprovalCard（HITL Dialog 确认框，对话/任务板块共用）', () => {
  const approval: ChatApprovalRequest = {
    id: 'a1',
    method: 'confirm',
    title: '允许执行 Bash?',
    message: 'rm -rf build',
    timeout: 60_000
  }

  it('展示标题与描述', () => {
    render(<ToolApprovalCard approval={approval} onRespond={vi.fn()} />)
    expect(screen.getByText('允许执行 Bash?')).toBeInTheDocument()
    // message 在 DialogDescription 和 pre 详情区都会渲染
    expect(screen.getAllByText('rm -rf build').length).toBeGreaterThan(0)
  })

  it('允许/拒绝按钮回调正确参数', () => {
    const onRespond = vi.fn()
    render(<ToolApprovalCard approval={approval} onRespond={onRespond} />)
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(onRespond).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(onRespond).toHaveBeenCalledWith(false)
  })

  it('超过 timeout 自动按拒绝处理（与主进程超时兜底对齐）', () => {
    vi.useFakeTimers()
    try {
      const onRespond = vi.fn()
      render(<ToolApprovalCard approval={{ ...approval, timeout: 5_000 }} onRespond={onRespond} />)
      expect(onRespond).not.toHaveBeenCalled()
      vi.advanceTimersByTime(5_000)
      expect(onRespond).toHaveBeenCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('无 timeout 时不自动触发响应', () => {
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
