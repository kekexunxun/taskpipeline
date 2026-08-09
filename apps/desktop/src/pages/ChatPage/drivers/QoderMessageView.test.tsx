import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { QoderMessageView } from './QoderMessageView'
import type { ChatMessage, DriverPart } from '@/api'

function qoderMessage(parts: DriverPart[]): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: new Date().toISOString(),
    driverId: 'qoder',
    raw: { kind: 'assistant', parts },
    parts
  }
}

describe('QoderMessageView', () => {
  it('renders text parts through the shared TextPart renderer', () => {
    render(
      <QoderMessageView message={qoderMessage([{ driverId: 'qoder', type: 'text', text: '你好,这是 Qoder 回复' }])} />
    )
    expect(screen.getByText('你好,这是 Qoder 回复')).toBeInTheDocument()
  })

  it('renders a thinking part as a collapsible with 思考过程 trigger label when not streaming', () => {
    render(
      <QoderMessageView
        message={qoderMessage([{ driverId: 'qoder', type: 'qoder.thinking', text: '推理过程', signature: 'sig-1' }])}
      />
    )
    // 非流式时折叠 trigger 显示"思考过程"(表示推理已完成)
    expect(screen.getByText('思考过程')).toBeInTheDocument()
  })

  it('renders a qoder.session part with a 12-char truncated session id', () => {
    const longId = 'abcdefghijklmnopqrstuvwxyz-1234567890'
    render(
      <QoderMessageView message={qoderMessage([{ driverId: 'qoder', type: 'qoder.session', sessionId: longId }])} />
    )
    // 只取前 12 个字符
    expect(screen.getByText(`session ${longId.slice(0, 12)}`)).toBeInTheDocument()
  })

  it('pairs qoder.tool-use with qoder.tool-result by toolCallId into a ToolCallRow (工具名 + 内联摘要,点击展开输出)', () => {
    render(
      <QoderMessageView
        message={qoderMessage([
          {
            driverId: 'qoder',
            type: 'qoder.tool-use',
            toolCallId: 'tc-1',
            name: 'createJiraIssue',
            input: { projectKey: 'BSADAPT' }
          },
          { driverId: 'qoder', type: 'qoder.tool-result', toolCallId: 'tc-1', output: { key: 'BSADAPT-1' } }
        ])}
      />
    )
    expect(screen.getByText('Tools - createJiraIssue')).toBeInTheDocument()
    // 内联摘要(input JSON)
    expect(screen.getByText(/BSADAPT/)).toBeInTheDocument()
    // result 不单独成行,展开 tool 行后可见输出
    fireEvent.click(screen.getByRole('button', { name: /createJiraIssue/ }))
    expect(screen.getByText('输出')).toBeInTheDocument()
    expect(screen.getByText(/BSADAPT-1/)).toBeInTheDocument()
  })

  it('marks tool-use as running when no result is paired (流式期间转圈)', () => {
    const { container } = render(
      <QoderMessageView
        message={qoderMessage([
          {
            driverId: 'qoder',
            type: 'qoder.tool-use',
            toolCallId: 'tc-2',
            name: 'searchConfluence',
            input: { query: 'jira' }
          }
        ])}
        isAnimating
      />
    )
    expect(screen.getByText('Tools - searchConfluence')).toBeInTheDocument()
    // running 状态:Loader2 转圈图标
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('marks tool-use as error when result is paired and isError (展开后见失败标签)', () => {
    render(
      <QoderMessageView
        message={qoderMessage([
          { driverId: 'qoder', type: 'qoder.tool-use', toolCallId: 'tc-3', name: 'createJiraIssue', input: {} },
          {
            driverId: 'qoder',
            type: 'qoder.tool-result',
            toolCallId: 'tc-3',
            output: { error: 'rate limit' },
            isError: true
          }
        ])}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /createJiraIssue/ }))
    expect(screen.getByText('失败')).toBeInTheDocument()
    expect(screen.getByText(/rate limit/)).toBeInTheDocument()
  })

  it('renders multiple parts in order, including session badge and text', () => {
    render(
      <QoderMessageView
        message={qoderMessage([
          { driverId: 'qoder', type: 'qoder.session', sessionId: 'sess-abcdef123456' },
          { driverId: 'qoder', type: 'qoder.thinking', text: '分析中' },
          { driverId: 'qoder', type: 'text', text: '已为你创建任务' }
        ])}
      />
    )
    // session badge 在多 part 列表里被识别(用 function matcher 兼容可能的文本节点拆分)
    expect(screen.getByText((content) => content.includes('sess-abcdef'))).toBeInTheDocument()
    // thinking 折叠 trigger
    expect(screen.getByText('思考过程')).toBeInTheDocument()
    expect(screen.getByText('已为你创建任务')).toBeInTheDocument()
  })
})
