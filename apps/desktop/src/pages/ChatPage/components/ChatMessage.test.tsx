import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '@/api'

describe('ChatMessageView task creation action', () => {
  it('executes the structured Jira key instead of parsing assistant text', async () => {
    const onExecuteJira = vi.fn(async () => undefined)
    const message: ChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      driverId: 'qoder',
      createdAt: new Date().toISOString(),
      raw: { kind: 'assistant', parts: [] },
      metadata: {
        createdAt: new Date().toISOString(),
        status: 'done',
        taskCreation: {
          backend: 'jira',
          externalKey: 'BSADAPT344-42',
          summary: 'Agent',
          projectKey: 'BSADAPT344',
          issueType: '任务'
        }
      },
      parts: [{ driverId: 'qoder', type: 'text', text: '回复中没有 Jira Key' }]
    }
    render(<ChatMessageView message={message} onExecuteJira={onExecuteJira} />)
    fireEvent.click(screen.getByRole('button', { name: '立即执行' }))
    await waitFor(() => expect(onExecuteJira).toHaveBeenCalledWith('BSADAPT344-42'))
  })

  it('supports task creation metadata persisted with the legacy Jira field', async () => {
    const onExecuteJira = vi.fn(async () => undefined)
    const message: ChatMessage = {
      id: 'assistant-legacy',
      role: 'assistant',
      driverId: 'qoder',
      createdAt: new Date().toISOString(),
      raw: { kind: 'assistant', parts: [] },
      metadata: {
        createdAt: new Date().toISOString(),
        status: 'done',
        taskCreation: {
          backend: 'jira',
          externalKey: 'LEGACY-7',
          summary: 'Legacy',
          projectKey: 'LEGACY',
          issueType: '任务'
        }
      },
      parts: [{ driverId: 'qoder', type: 'text', text: '历史消息' }]
    }
    render(<ChatMessageView message={message} onExecuteJira={onExecuteJira} />)
    fireEvent.click(screen.getByRole('button', { name: '立即执行' }))
    await waitFor(() => expect(onExecuteJira).toHaveBeenCalledWith('LEGACY-7'))
  })
})

describe('ChatMessageView error display', () => {
  it('renders a red error block from in-flight metadata.errorMessage', () => {
    const message: ChatMessage = {
      id: 'assistant-err',
      role: 'assistant',
      driverId: 'openai',
      createdAt: new Date().toISOString(),
      raw: { kind: 'assistant', parts: [] },
      metadata: {
        createdAt: new Date().toISOString(),
        status: 'error',
        errorMessage: '401 Invalid API key'
      },
      parts: []
    }
    render(<ChatMessageView message={message} />)
    expect(screen.getByText('401 Invalid API key')).toBeTruthy()
    expect(screen.getByText('失败')).toBeTruthy()
  })

  it('renders a red error block from persisted errorMessage without metadata', () => {
    const message: ChatMessage = {
      id: 'assistant-err-persisted',
      role: 'assistant',
      driverId: 'openai',
      createdAt: new Date().toISOString(),
      raw: { kind: 'assistant', parts: [] },
      errorMessage: 'connection refused',
      parts: []
    }
    render(<ChatMessageView message={message} />)
    expect(screen.getByText('connection refused')).toBeTruthy()
    expect(screen.getByText('失败')).toBeTruthy()
  })

  it('renders produced parts and the error block together (错误不再替换已产出正文)', () => {
    // Qoder 中途失败:流式已产出的正文照常渲染,错误块追加在下方,两者共存。
    const message: ChatMessage = {
      id: 'assistant-err-with-parts',
      role: 'assistant',
      driverId: 'qoder',
      createdAt: new Date().toISOString(),
      raw: { kind: 'assistant', parts: [] },
      metadata: {
        createdAt: new Date().toISOString(),
        status: 'error',
        errorMessage: '会话中断'
      },
      parts: [{ driverId: 'qoder', type: 'text', text: '失败前已经产出的正文' }]
    }
    render(<ChatMessageView message={message} />)
    expect(screen.getByText('失败前已经产出的正文')).toBeTruthy()
    expect(screen.getByText('会话中断')).toBeTruthy()
    expect(screen.getByText('失败')).toBeTruthy()
  })
})
