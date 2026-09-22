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
 * ThinkingPart 委托共享的 ThinkingBlock：
 * - 默认一律折叠（流式也不再自动展开），用户点击后以用户选择为准；
 * - label 流式未冻结时为"思考中 - n秒"，其余为"深度思考 - n秒"。
 * Radix Collapsible 会把 [data-state] 写到 trigger 按钮上，用它观察折叠态最稳。
 */
function getCollapsibleState(): 'open' | 'closed' | null {
  const trigger = screen.getByRole('button', { name: /思考/ })
  return (trigger.getAttribute('data-state') as 'open' | 'closed' | null) ?? null
}

describe('ThinkingPart', () => {
  it('流式时 label 显示"思考中 - n秒"，默认折叠，点击可展开看到推理文本', async () => {
    const user = userEvent.setup()
    render(<ThinkingPart part={thinkingPart} isStreaming />)
    expect(screen.getByText(/思考中 - \d+秒/)).toBeInTheDocument()
    expect(getCollapsibleState()).toBe('closed')
    await user.click(screen.getByRole('button', { name: /思考中/ }))
    expect(getCollapsibleState()).toBe('open')
    expect(screen.getByText('推理过程')).toBeInTheDocument()
  })

  it('非流式时 label 显示"深度思考 - n秒"，不出现"思考中"文案', async () => {
    const user = userEvent.setup()
    render(<ThinkingPart part={thinkingPart} />)
    expect(screen.getByText(/深度思考 - \d+秒/)).toBeInTheDocument()
    expect(screen.queryByText(/思考中/)).not.toBeInTheDocument()
    expect(getCollapsibleState()).toBe('closed')
    await user.click(screen.getByRole('button', { name: /深度思考/ }))
    expect(getCollapsibleState()).toBe('open')
  })

  it('用户展开后，isStreaming 驱动的父级重渲染不会把用户的选择覆盖回去', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ThinkingPart part={thinkingPart} isStreaming />)
    await user.click(screen.getByRole('button', { name: /思考中/ }))
    expect(getCollapsibleState()).toBe('open')
    // 流式仍在继续(父组件可能因流式数据重渲染)
    rerender(<ThinkingPart part={{ ...thinkingPart, text: '推理过程更多' }} isStreaming />)
    expect(getCollapsibleState()).toBe('open')
  })

  it('用户收起后再点击能重新展开', async () => {
    const user = userEvent.setup()
    render(<ThinkingPart part={thinkingPart} isStreaming />)
    expect(getCollapsibleState()).toBe('closed')
    await user.click(screen.getByRole('button', { name: /思考中/ }))
    expect(getCollapsibleState()).toBe('open')
    await user.click(screen.getByRole('button', { name: /思考中/ }))
    expect(getCollapsibleState()).toBe('closed')
    await user.click(screen.getByRole('button', { name: /思考中/ }))
    expect(getCollapsibleState()).toBe('open')
  })
})
