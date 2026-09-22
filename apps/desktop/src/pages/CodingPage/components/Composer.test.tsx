import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskComposer } from './Composer'
import { TooltipProvider } from '@/components/ui/tooltip'

function renderComposer(props: Partial<Parameters<typeof TaskComposer>[0]> = {}) {
  const onStop = vi.fn()
  render(
    <TooltipProvider>
      <TaskComposer value="继续" onChange={vi.fn()} onSend={vi.fn()} onStop={onStop} {...props} />
    </TooltipProvider>
  )
  return { onStop }
}

describe('TaskComposer', () => {
  it('shows a submitting indicator while a message is being queued', () => {
    renderComposer({ submitting: true })

    // 消息待发送队列设计：submitting 期间不再禁用输入/发送，
    // 仅通过按钮 aria-label 与 placeholder 提示当前处于提交中。
    expect(screen.getByRole('button', { name: '正在提交' })).toBeInTheDocument()
    expect(screen.getByTestId('chat-composer')).not.toBeDisabled()
  })

  it('changes the send button into a stop action while the task is running', () => {
    const { onStop } = renderComposer({ streaming: true })

    fireEvent.click(screen.getByRole('button', { name: '停止执行' }))
    expect(onStop).toHaveBeenCalledOnce()
  })
})
