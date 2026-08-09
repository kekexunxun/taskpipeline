import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { TraceEntry, TraceSummary } from '@task-pipeline/core'
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
    // tool_call 渲染成 ToolCallRow:标题剥掉「工具 」前缀,统一带「Tools - 」类别前缀
    expect(screen.getByText('Tools - read')).toBeInTheDocument()
    expect(screen.getByText('执行错误')).toBeInTheDocument()
    // task 类型详情提供「打开任务」入口
    expect(screen.getByRole('link', { name: /打开任务/ })).toBeInTheDocument()
  })

  it('TraceDetail 子任务卡锚定真实时间点,工具双源去重 + MetaBadges,发起调用被吸收', () => {
    const entries: TraceEntry[] = [
      // 主流程消息
      {
        id: 'e1',
        traceId: 't1',
        kind: 'task',
        type: 'message',
        title: 'AI',
        detail: '主流程前文',
        createdAt: '2025-01-01T00:00:00Z',
        source: 'events'
      },
      // events 源:发起子任务的工具调用(use)
      {
        id: 'e2',
        traceId: 't1',
        kind: 'task',
        type: 'tool_call',
        title: 'Task',
        createdAt: '2025-01-01T00:00:01Z',
        source: 'events',
        payload: { toolName: 'Task', toolUseId: 'toolu_spawn', phase: 'use', input: { description: '查文档' } }
      },
      // 子任务起点(qoder 源,toolUseId 指向发起调用)
      {
        id: 'e3',
        traceId: 't1',
        kind: 'task',
        type: 'status',
        title: '子任务启动',
        detail: '查文档',
        createdAt: '2025-01-01T00:00:02Z',
        source: 'qoder',
        taskId: 'sub-1',
        parentTaskId: 'sub-1',
        sdkSubtype: 'task_started',
        payload: {
          taskId: 'sub-1',
          taskType: 'local_agent',
          subagentType: 'Explore',
          toolUseId: 'toolu_spawn',
          description: '查文档'
        }
      },
      // 子任务内工具(events 源 use + result)
      {
        id: 'e4',
        traceId: 't1',
        kind: 'task',
        type: 'tool_call',
        title: 'Read',
        createdAt: '2025-01-01T00:00:03Z',
        source: 'events',
        parentTaskId: 'sub-1',
        payload: { toolName: 'Read', toolUseId: 'toolu_r', phase: 'use', input: { file_path: '/tmp/a.ts' } }
      },
      {
        id: 'e5',
        traceId: 't1',
        kind: 'task',
        type: 'tool_call',
        title: 'Read',
        createdAt: '2025-01-01T00:00:04Z',
        source: 'events',
        parentTaskId: 'sub-1',
        payload: { toolName: 'Read', toolUseId: 'toolu_r', phase: 'result', output: '内容' }
      },
      // qoder 源同一调用的已配对条目(双源重复,带 usage → MetaBadges)
      {
        id: 'e6',
        traceId: 't1',
        kind: 'task',
        type: 'tool_call',
        title: '工具 Read',
        createdAt: '2025-01-01T00:00:04.500Z',
        source: 'qoder',
        parentTaskId: 'sub-1',
        payload: {
          toolCallId: 'toolu_r',
          toolName: 'Read',
          input: { file_path: '/tmp/a.ts' },
          result: '内容',
          isError: false,
          usage: { input: 12, output: 3 }
        }
      },
      // 发起调用 result(events 源)
      {
        id: 'e7',
        traceId: 't1',
        kind: 'task',
        type: 'tool_call',
        title: 'Task',
        createdAt: '2025-01-01T00:00:05Z',
        source: 'events',
        payload: { toolName: 'Task', toolUseId: 'toolu_spawn', phase: 'result', output: '子任务完整输出' }
      },
      // 子任务收尾
      {
        id: 'e8',
        traceId: 't1',
        kind: 'task',
        type: 'status',
        title: '子任务收尾',
        createdAt: '2025-01-01T00:00:06Z',
        source: 'qoder',
        taskId: 'sub-1',
        parentTaskId: 'sub-1',
        sdkSubtype: 'task_notification',
        payload: { taskId: 'sub-1', status: 'completed', summary: '找到文档' }
      },
      // 主流程后文
      {
        id: 'e9',
        traceId: 't1',
        kind: 'task',
        type: 'message',
        title: 'AI',
        detail: '主流程后文',
        createdAt: '2025-01-01T00:00:07Z',
        source: 'events'
      }
    ]
    render(
      <MemoryRouter>
        <TraceDetail kind="task" traceId="t1" entries={entries} loading={false} onBack={() => undefined} />
      </MemoryRouter>
    )

    // 发起调用(Task)被吸收:主流程不出现 Task 工具行
    expect(screen.queryByRole('button', { name: /Task/ })).not.toBeInTheDocument()

    // 子任务卡锚定在真实时间点:位于主流程前文与后文之间
    const headerTrigger = document.querySelector<HTMLElement>('[data-subtask-id="sub-1"]')!
    expect(headerTrigger).toBeInTheDocument()
    // header:description + task_type / subagent_type 徽章 + 整体状态徽章
    expect(screen.getByText('查文档')).toBeInTheDocument()
    expect(screen.getByText('local_agent')).toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
    const before = screen.getByText('主流程前文')
    const after = screen.getByText('主流程后文')
    expect(before.compareDocumentPosition(headerTrigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(headerTrigger.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // 展开卡片:子任务内工具双源合并为一行(Read 只出现一次)
    fireEvent.click(headerTrigger)
    expect(screen.getAllByText('Tools - Read')).toHaveLength(1)
    // MetaBadges(qoder 源带 usage)
    expect(screen.getByText('↑12 ↓3')).toBeInTheDocument()
    // task_notification 内容不展示(只驱动状态徽章);被吸收调用的 result 进「输出」段
    expect(screen.queryByText('找到文档')).toBeNull()
    expect(screen.getByText('子任务完整输出')).toBeInTheDocument()
  })

  /**
   * 历史数据回归:老版 log.ts 写 events 表时 payload 整列留空,title=`Qoder task_*`、
   * detail 是整包 SDK 消息 JSON。这些条目必须经 subtaskMetaOf 兑底入组 —— 否则会出现
   * 「task_started / task_progress 平铺大 JSON + 子任务卡只有空壳」的重复展示。
   */
  it('历史数据:title=Qoder task_* 且 payload 空的 events 条目兑底入组,不再平铺 JSON', () => {
    const entries: TraceEntry[] = [
      {
        id: 'h1',
        traceId: 't1',
        kind: 'task',
        type: 'message',
        title: 'AI',
        detail: '主流程前文',
        createdAt: '2025-01-01T00:00:00Z',
        source: 'events'
      },
      // qoder 源发起调用(pairToolCalls 已把 result 合入 payload)
      {
        id: 'h2',
        traceId: 't1',
        kind: 'task',
        type: 'tool_call',
        title: '工具 Agent',
        createdAt: '2025-01-01T00:00:01Z',
        source: 'qoder',
        payload: {
          toolCallId: 'call_1',
          toolName: 'Agent',
          input: { description: '查找发票推送相关代码' },
          result: '子任务报告'
        }
      },
      // events 源历史 task_started:payload 空,detail 是整包 JSON
      {
        id: 'h3',
        traceId: 't1',
        kind: 'task',
        type: 'status',
        title: 'Qoder task_started',
        detail: JSON.stringify({
          type: 'system',
          subtype: 'task_started',
          task_id: 'sub-his',
          tool_use_id: 'call_1',
          task_type: 'local_agent',
          subagent_type: 'Explore',
          description: '查找发票推送相关代码'
        }),
        createdAt: '2025-01-01T00:00:02Z',
        source: 'events'
      },
      {
        id: 'h4',
        traceId: 't1',
        kind: 'task',
        type: 'status',
        title: 'Qoder task_progress',
        detail: JSON.stringify({
          type: 'system',
          subtype: 'task_progress',
          task_id: 'sub-his',
          last_tool_name: 'Glob',
          description: '扫文件'
        }),
        createdAt: '2025-01-01T00:00:03Z',
        source: 'events'
      },
      {
        id: 'h5',
        traceId: 't1',
        kind: 'task',
        type: 'status',
        title: 'Qoder task_notification',
        detail: JSON.stringify({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'sub-his',
          status: 'completed',
          summary: '查完了'
        }),
        createdAt: '2025-01-01T00:00:04Z',
        source: 'events'
      },
      {
        id: 'h6',
        traceId: 't1',
        kind: 'task',
        type: 'message',
        title: 'AI',
        detail: '主流程后文',
        createdAt: '2025-01-01T00:00:05Z',
        source: 'events'
      }
    ]
    render(
      <MemoryRouter>
        <TraceDetail kind="task" traceId="t1" entries={entries} loading={false} onBack={() => undefined} />
      </MemoryRouter>
    )

    // task_* 条目不再平铺:原始 JSON 与 title 都不出现在主流程
    expect(screen.queryByText(/Qoder task_started/)).toBeNull()
    expect(screen.queryByText(/"subtype":"task_started"/)).toBeNull()
    // 发起调用(Agent)被吸收:主流程不出现该工具行
    expect(screen.queryByRole('button', { name: /Agent/ })).toBeNull()

    // 子任务卡:description + task_type / subagent_type 徽章 + 整体状态徽章(全部从 detail JSON 反解)
    const headerTrigger = document.querySelector<HTMLElement>('[data-subtask-id="sub-his"]')!
    expect(headerTrigger).toBeInTheDocument()
    expect(screen.getByText('查找发票推送相关代码')).toBeInTheDocument()
    expect(screen.getByText('local_agent')).toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()

    // 展开:progress 聚合成统计行;被吸收调用的 result 进「输出」段;notification summary 不展示
    fireEvent.click(headerTrigger)
    expect(screen.getByText('过程态 1 次')).toBeInTheDocument()
    expect(screen.getByText('最后工具: Glob')).toBeInTheDocument()
    expect(screen.getByText('子任务报告')).toBeInTheDocument()
    expect(screen.queryByText('查完了')).toBeNull()
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
