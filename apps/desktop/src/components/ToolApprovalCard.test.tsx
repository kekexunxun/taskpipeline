import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolApprovalCard, type ChatApprovalRequest } from './ToolApprovalCard'

describe('ToolApprovalCard（HITL 内联确认卡片，对话/任务板块共用）', () => {
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
    expect(screen.getByText('rm -rf build')).toBeInTheDocument()
  })

  it('允许/拒绝按钮回调 correct 参数', () => {
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
      // advanceTimersByTime 同步触发 setTimeout 回调（fake timers 下不能用 waitFor）。
      vi.advanceTimersByTime(5_000)
      expect(onRespond).toHaveBeenCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('无 timeout 时不自动触发响应', async () => {
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
