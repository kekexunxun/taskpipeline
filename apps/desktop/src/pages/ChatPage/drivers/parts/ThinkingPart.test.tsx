import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ThinkingPart } from './ThinkingPart'
import type { DriverPart } from '@/api'

const thinkingPart = {
  driverId: 'qoder',
  type: 'qoder.thinking',
  text: '推理过程'
} as Extract<DriverPart, { type: 'qoder.thinking' }>

/**
 * Radix Collapsible 会把 [data-state] 写到根节点上(open/closed);
 * trigger 按钮上也带 data-state,用它来观察折叠态最稳。
 * label 会随流式状态切换(思考中… / 思考过程),两种都接受。
 */
function getCollapsibleState(): 'open' | 'closed' | null {
  const trigger = screen.getByRole('button', { name: /思考/ })
  return (trigger.getAttribute('data-state') as 'open' | 'closed' | null) ?? null
}

describe('ThinkingPart', () => {
  it('流式时默认展开,label 显示"思考中…"', () => {
    render(<ThinkingPart part={thinkingPart} isStreaming />)
    expect(screen.getByText('思考中…')).toBeInTheDocument()
    expect(getCollapsibleState()).toBe('open')
  })

  it('非流式时默认收起,label 切换为"思考过程",用户可手动展开', async () => {
    const user = userEvent.setup()
    render(<ThinkingPart part={thinkingPart} />)
    // 流结束 → 思考已完成,文案从"思考中…"切到"思考过程"
    expect(screen.getByText('思考过程')).toBeInTheDocument()
    expect(screen.queryByText('思考中…')).not.toBeInTheDocument()
    expect(getCollapsibleState()).toBe('closed')
    await user.click(screen.getByRole('button', { name: /思考过程/ }))
    expect(getCollapsibleState()).toBe('open')
  })

  it('流式时用户点击关闭后,isStreaming 再次渲染时不会把用户的选择覆盖回去', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ThinkingPart part={thinkingPart} isStreaming />)
    expect(getCollapsibleState()).toBe('open')
    await user.click(screen.getByRole('button', { name: /思考中/ }))
    expect(getCollapsibleState()).toBe('closed')
    // 流式仍在继续(父组件可能因流式数据重渲染)
    rerender(<ThinkingPart part={thinkingPart} isStreaming />)
    expect(getCollapsibleState()).toBe('closed')
  })
  it('用户收起后再点击能重新展开', async () => {
    const user = userEvent.setup()
    render(<ThinkingPart part={thinkingPart} isStreaming />)
    expect(getCollapsibleState()).toBe('open')
    await user.click(screen.getByRole('button', { name: /思考中/ }))
    expect(getCollapsibleState()).toBe('closed')
    await user.click(screen.getByRole('button', { name: /思考中/ }))
    expect(getCollapsibleState()).toBe('open')
  })
})
