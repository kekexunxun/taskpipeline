import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { TraceEntry, TraceSummary } from '@coding-agent/core'
import { TraceDetail } from './components/TraceDetail'
import { TraceList } from './components/TraceList'

describe('TracePage 组件', () => {
  it('TraceDetail 把 TraceEntry 映射为 Timeline 项渲染', () => {
    const entries: TraceEntry[] = [
      {
        id: 'e1',
        traceId: 't1',
        kind: 'task',
        type: 'session_start',
        title: '执行会话开始',
        createdAt: '2025-01-01T00:00:00Z',
        source: 'events'
      },
      {
        id: 'e2',
        traceId: 't1',
        kind: 'task',
        type: 'message',
        title: 'AI',
        detail: '你好',
        createdAt: '2025-01-01T00:00:01Z',
        source: 'events'
      },
      {
        id: 'e3',
        traceId: 't1',
        kind: 'task',
        type: 'tool_call',
        title: '工具 read',
        detail: '{"path":"a.ts"}',
        createdAt: '2025-01-01T00:00:02Z',
        source: 'events'
      },
      {
        id: 'e4',
        traceId: 't1',
        kind: 'task',
        type: 'error',
        title: '执行错误',
        createdAt: '2025-01-01T00:00:03Z',
        source: 'events'
      }
    ]
    render(
      <MemoryRouter>
        <TraceDetail kind="task" traceId="t1" entries={entries} loading={false} onBack={() => undefined} />
      </MemoryRouter>
    )
    expect(screen.getByText('AI')).toBeInTheDocument()
    expect(screen.getByText('工具 read')).toBeInTheDocument()
    expect(screen.getByText('执行错误')).toBeInTheDocument()
    // task 类型详情提供「打开任务」入口
    expect(screen.getByRole('link', { name: /打开任务/ })).toBeInTheDocument()
  })

  it('TraceList 按 kind 过滤并渲染 summary', () => {
    const summaries: TraceSummary[] = [
      {
        traceId: 't1',
        kind: 'task',
        title: '示例任务',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:01Z',
        entryCount: 3
      },
      {
        traceId: 'c1',
        kind: 'chat',
        title: '测试对话',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:01Z',
        entryCount: 2
      }
    ]
    render(
      <MemoryRouter>
        <TraceList summaries={summaries} kind="task" query="" />
      </MemoryRouter>
    )
    expect(screen.getByText('示例任务')).toBeInTheDocument()
    expect(screen.queryByText('测试对话')).not.toBeInTheDocument()
  })

  it('TraceList 支持关键词搜索', () => {
    const summaries: TraceSummary[] = [
      {
        traceId: 't1',
        kind: 'task',
        title: '修复登录',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:01Z',
        entryCount: 1
      },
      {
        traceId: 't2',
        kind: 'task',
        title: '升级依赖',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:01Z',
        entryCount: 1
      }
    ]
    render(
      <MemoryRouter>
        <TraceList summaries={summaries} kind="all" query="登录" />
      </MemoryRouter>
    )
    expect(screen.getByText('修复登录')).toBeInTheDocument()
    expect(screen.queryByText('升级依赖')).not.toBeInTheDocument()
  })
})
