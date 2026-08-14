import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatModelSelector } from './ChatModelSelector'
import type { ChatModelGroup } from '@/api'

const groups: ChatModelGroup[] = [
  {
    driverId: 'openai',
    displayName: 'OpenAI Compatible',
    models: [
      {
        value: 'openai:deepseek-chat',
        displayName: 'DeepSeek Chat',
        capabilities: [{ key: 'reasoningEffort', kind: 'enum', options: ['low', 'medium', 'high'] }]
      },
      { value: 'openai:plain-model', displayName: 'Plain Model' },
      { value: 'openai-compatible:qwen3.8-max', displayName: '我的百炼', vendor: 'dashscope-token-plan' }
    ]
  }
]

function listItemByText(text: string): HTMLElement {
  const item = screen.getAllByText(text).find((el) => el.closest('[cmdk-item]'))
  if (!item) throw new Error(`list item not found: ${text}`)
  return item.closest('[cmdk-item]') as HTMLElement
}
describe('ChatModelSelector hover params popover', () => {
  it('opens the params popover when hovering a model with capabilities', async () => {
    const onChange = vi.fn()
    const onChangeParams = vi.fn()
    render(<ChatModelSelector groups={groups} onChange={onChange} onChangeParams={onChangeParams} />)
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    fireEvent.mouseEnter(listItemByText('DeepSeek Chat'))
    await waitFor(() => expect(screen.queryByText('参数设置')).not.toBeNull(), { timeout: 1500 })
    expect(onChangeParams).not.toHaveBeenCalled()
  })

  it('changing a param on the popover selects the model and persists the value', async () => {
    const onChange = vi.fn()
    const onChangeParams = vi.fn()
    render(<ChatModelSelector groups={groups} onChange={onChange} onChangeParams={onChangeParams} />)
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    fireEvent.mouseEnter(listItemByText('DeepSeek Chat'))
    const high = await screen.findByText('high')
    fireEvent.click(high)
    expect(onChange).toHaveBeenCalledWith('openai:deepseek-chat')
    expect(onChangeParams).toHaveBeenCalledWith({ reasoningEffort: 'high' })
  })

  it('shows an empty hint popover for a model without capabilities', async () => {
    const onChange = vi.fn()
    const onChangeParams = vi.fn()
    render(<ChatModelSelector groups={groups} onChange={onChange} onChangeParams={onChangeParams} />)
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    fireEvent.mouseEnter(listItemByText('Plain Model'))
    await waitFor(() => expect(screen.queryByText('该模型无可调参数')).not.toBeNull(), { timeout: 1500 })
  })

  it('leaving the list closes the popover', async () => {
    const onChange = vi.fn()
    const onChangeParams = vi.fn()
    render(<ChatModelSelector groups={groups} onChange={onChange} onChangeParams={onChangeParams} />)
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    fireEvent.mouseEnter(listItemByText('DeepSeek Chat'))
    await screen.findByText('参数设置')
    fireEvent.mouseLeave(listItemByText('DeepSeek Chat'))
    await waitFor(() => expect(screen.queryByText('参数设置')).toBeNull(), { timeout: 1500 })
  })

  it('shows the vendor name next to the user-defined display name', async () => {
    const onChange = vi.fn()
    const onChangeParams = vi.fn()
    render(<ChatModelSelector groups={groups} onChange={onChange} onChangeParams={onChangeParams} />)
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    // 厂商分块标题显示厂商名，条目只显示用户定义名
    expect(screen.queryByText('百炼 Token Plan')).not.toBeNull()
    const item = listItemByText('我的百炼')
    expect(item.textContent).toContain('我的百炼')
    expect(item.textContent).not.toContain('百炼 Token Plan')
    // 搜索也能命中厂商名
    fireEvent.change(screen.getByPlaceholderText('搜索模型…'), { target: { value: '百炼' } })
    expect(screen.queryByText('我的百炼')).not.toBeNull()
  })
})
