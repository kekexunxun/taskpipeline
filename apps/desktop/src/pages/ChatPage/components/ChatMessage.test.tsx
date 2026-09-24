import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageView } from './ChatMessage'
import { api, type ChatMessage } from '@/api'

afterEach(() => vi.restoreAllMocks())

describe('用户消息附件', () => {
  const file = {
    type: 'file' as const,
    localPath: '/cache/chat/image.png',
    mediaType: 'image/png',
    filename: '截图.png'
  }
  const imageUrl = 'data:image/png;base64,aW1hZ2U='
  const message = (driverId: 'qoder' | 'openai', text = '调整技能列表布局'): ChatMessage => ({
    id: 'user-image',
    role: 'user',
    driverId,
    createdAt: '2026-09-23T02:56:32.223Z',
    raw: { kind: 'user', text, files: [file] },
    parts: [
      { driverId, type: 'text', text },
      { driverId, ...file }
    ]
  })

  it.each(['qoder', 'openai'] as const)('展示 %s 历史消息的图片，并支持打开与关闭预览', async (driverId) => {
    const preview = vi.spyOn(api, 'previewChatImage').mockResolvedValue(imageUrl)
    render(<ChatMessageView message={message(driverId)} />)
    expect(screen.getByText('调整技能列表布局')).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: '截图.png' })).toHaveAttribute('src', imageUrl)
    expect(preview).toHaveBeenCalledWith(file.localPath, file.mediaType)
    fireEvent.click(screen.getByRole('button', { name: '预览图片：截图.png' }))
    expect(screen.getByRole('dialog', { name: '截图.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('纯图片消息仍显示附件，不显示空文本复制按钮', async () => {
    vi.spyOn(api, 'previewChatImage').mockResolvedValue(imageUrl)
    render(<ChatMessageView message={message('qoder', '')} />)
    expect(await screen.findByRole('img')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制消息' })).toBeNull()
  })

  it('缓存缺失显示提示并保留文字', async () => {
    vi.spyOn(api, 'previewChatImage').mockResolvedValue(undefined)
    render(<ChatMessageView message={message('qoder')} />)
    expect(await screen.findByText('图片文件已不存在')).toBeInTheDocument()
    expect(screen.getByText('调整技能列表布局')).toBeInTheDocument()
    expect(screen.getByText('截图.png')).toBeInTheDocument()
  })

  it('预览读取失败与图片解码失败均显示占位', async () => {
    const preview = vi
      .spyOn(api, 'previewChatImage')
      .mockRejectedValueOnce(new Error('无法读取'))
      .mockResolvedValue(imageUrl)
    const { rerender } = render(<ChatMessageView message={message('qoder')} />)
    expect(await screen.findByText('图片无法预览')).toBeInTheDocument()
    rerender(<ChatMessageView key="second" message={message('qoder')} />)
    fireEvent.error(await screen.findByRole('img'))
    expect(await screen.findByText('图片无法预览')).toBeInTheDocument()
    expect(preview).toHaveBeenCalledTimes(2)
  })

  it('普通文件显示名称，不尝试读取为图片', () => {
    const preview = vi.spyOn(api, 'previewChatImage')
    const value = message('qoder')
    value.parts = [{ ...file, driverId: 'qoder', mediaType: 'text/plain', filename: '需求.txt' }]
    render(<ChatMessageView message={value} />)
    expect(screen.getByText('需求.txt')).toBeInTheDocument()
    expect(preview).not.toHaveBeenCalled()
  })
})

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

describe('ChatMessageView copy action', () => {
  it('copies adjacent text parts concatenated (no separator) to match display', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const message: ChatMessage = {
      id: 'assistant-copy',
      role: 'assistant',
      driverId: 'qoder',
      createdAt: new Date().toISOString(),
      raw: { kind: 'assistant', parts: [] },
      metadata: { createdAt: new Date().toISOString(), status: 'done' },
      parts: [
        { driverId: 'qoder', type: 'text', text: '第一段' },
        { driverId: 'qoder', type: 'text', text: '第二段' }
      ]
    }
    render(<ChatMessageView message={message} />)
    fireEvent.click(screen.getByRole('button', { name: '复制消息' }))
    // 相邻 text part 直接拼接,与 PartRenderer 合并行为一致
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('第一段第二段'))
  })

  it('copies text parts separated by tool parts with double newline', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const message: ChatMessage = {
      id: 'assistant-copy-separated',
      role: 'assistant',
      driverId: 'qoder',
      createdAt: new Date().toISOString(),
      raw: { kind: 'assistant', parts: [] },
      metadata: { createdAt: new Date().toISOString(), status: 'done' },
      parts: [
        { driverId: 'qoder', type: 'text', text: '工具前的文字' },
        { driverId: 'qoder', type: 'qoder.tool-use', toolCallId: 'tc-1', name: 'Read', input: {} },
        { driverId: 'qoder', type: 'qoder.tool-result', toolCallId: 'tc-1', output: 'file content' },
        { driverId: 'qoder', type: 'text', text: '工具后的文字' }
      ]
    }
    render(<ChatMessageView message={message} />)
    fireEvent.click(screen.getByRole('button', { name: '复制消息' }))
    // 被 tool part 隔开的段落用双换行分隔
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('工具前的文字\n\n工具后的文字'))
  })

  it('does not render a copy button when the message has no text parts', () => {
    const message: ChatMessage = {
      id: 'assistant-tool-only',
      role: 'assistant',
      driverId: 'qoder',
      createdAt: new Date().toISOString(),
      raw: { kind: 'assistant', parts: [] },
      metadata: { createdAt: new Date().toISOString(), status: 'done' },
      parts: [
        { driverId: 'qoder', type: 'qoder.tool-use', toolCallId: 'tc-1', name: 'glob', input: {} },
        { driverId: 'qoder', type: 'qoder.tool-result', toolCallId: 'tc-1', output: [] }
      ]
    }
    render(<ChatMessageView message={message} />)
    expect(screen.queryByRole('button', { name: '复制消息' })).toBeNull()
  })
})
