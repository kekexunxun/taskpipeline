import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentSpan, TraceSummary } from '@task-pipeline/core'
import { TraceDetail } from './components/TraceDetail'
import { TraceList } from './components/TraceList'
import { Waterfall } from './components/Waterfall'
import { PayloadInspector } from './components/PayloadInspector'

const resolveTitle = (s: TraceSummary) => s.title

function span(partial: Partial<AgentSpan>): AgentSpan {
  return {
    spanId: 'evt-t1-1',
    traceId: 't1',
    type: 'llm.generate',
    name: 'gpt-4o',
    status: 'completed',
    startedAt: 1000,
    endedAt: 3000,
    durationMs: 2000,
    sequence: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial
  }
}

const summary: TraceSummary = {
  traceId: 't1',
  kind: 'chat',
  title: '测试提问',
  status: 'ended',
  startedAt: '2026-01-01T00:00:00.000Z',
  spanCount: 2,
  errorCount: 0,
  updatedAt: '2026-01-01T00:00:03.000Z'
}

describe('TracePage 组件（v2）', () => {
  it('TraceDetail 渲染头部统计与瀑布图', () => {
    const spans = [
      span({
        spanId: 's1',
        type: 'session.start',
        name: '会话',
        startedAt: 1000,
        endedAt: 5000,
        durationMs: 4000,
        sequence: 1
      }),
      span({
        spanId: 's2',
        type: 'llm.generate',
        name: 'gpt-4o',
        startedAt: 1000,
        endedAt: 3000,
        durationMs: 2000,
        sequence: 2
      })
    ]
    render(
      <TraceDetail
        traceId="t1"
        spans={spans}
        loading={false}
        summary={summary}
        resolveTitle={resolveTitle}
        onBack={vi.fn()}
      />
    )
    expect(screen.getByText('测试提问')).toBeTruthy()
    expect(screen.getByText('gpt-4o')).toBeTruthy()
    // 两态状态徽章：已结束（无"失败"态）
    expect(screen.getByText('已结束')).toBeTruthy()
  })

  it('TraceDetail 头部：错误计数标记 + interrupted 异常中断提示', () => {
    render(
      <TraceDetail
        traceId="t1"
        spans={[span({ spanId: 's1' })]}
        loading={false}
        summary={{ ...summary, errorCount: 3, interrupted: true }}
        resolveTitle={resolveTitle}
        onBack={vi.fn()}
      />
    )
    expect(screen.getByText('已结束')).toBeTruthy()
    expect(screen.getByText('3 个错误步骤')).toBeTruthy()
    expect(screen.getByText('异常中断')).toBeTruthy()
  })

  it('TraceDetail 头部：进行中显示 running 徽章，无错误计数标记', () => {
    render(
      <TraceDetail
        traceId="t1"
        spans={[span({ spanId: 's1' })]}
        loading={false}
        summary={{ ...summary, status: 'running' }}
        resolveTitle={resolveTitle}
        onBack={vi.fn()}
      />
    )
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.queryByText('已结束')).toBeNull()
    expect(screen.queryByText(/个错误步骤/)).toBeNull()
  })

  it('Waterfall 渲染父子缩进与错误角标', () => {
    const spans = [
      span({
        spanId: 's1',
        type: 'agent.run',
        name: 'implementing',
        startedAt: 1000,
        endedAt: 5000,
        durationMs: 4000,
        sequence: 1
      }),
      span({
        spanId: 's2',
        type: 'tool.execute',
        name: 'bash',
        parentSpanId: 's1',
        startedAt: 2000,
        endedAt: 2500,
        durationMs: 500,
        status: 'error',
        sequence: 2
      })
    ]
    const onSelect = vi.fn()
    render(<Waterfall spans={spans} onSelect={onSelect} />)
    // 错误子 span 名称可见
    expect(screen.getByText('bash')).toBeTruthy()
    // 错误计数角标（子树错误数 1）
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('TraceList 「含错误」过滤按 errorCount > 0（两态模型：状态不表达失败），点击可选中', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <TraceList
        summaries={[summary, { ...summary, traceId: 't2', title: '报错任务', errorCount: 2 }]}
        timeRange="all"
        status="error"
        agent=""
        query=""
        resolveTitle={resolveTitle}
        onSelect={onSelect}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByText('报错任务')).toBeTruthy()
    expect(screen.queryByText('测试提问')).toBeNull()
    // 错误计数红色小标记
    expect(screen.getByText('2 个错误步骤')).toBeTruthy()
    await user.click(screen.getByText('报错任务'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ traceId: 't2' }))
  })

  it('TraceList 两态状态列：进行中 / 已结束（存量 success/error 摘要按已结束展示）', () => {
    render(
      <TraceList
        summaries={[
          { ...summary, traceId: 't-run', title: '进行中任务', status: 'running' },
          { ...summary, traceId: 't-end', title: '已结束任务' },
          // 存量旧摘要（类型之外的运行时数据）：非 running 即已结束
          { ...summary, traceId: 't-legacy', title: '存量任务', status: 'error' as TraceSummary['status'] }
        ]}
        timeRange="all"
        status="all"
        agent=""
        query=""
        resolveTitle={resolveTitle}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByText('进行中')).toBeTruthy()
    // 已结束 + 存量 error 各显示一个「已结束」
    expect(screen.getAllByText('已结束')).toHaveLength(2)
    expect(screen.queryByText('失败')).toBeNull()
  })

  it('TraceList 按「进行中 / 已结束」状态过滤', () => {
    const { rerender } = render(
      <TraceList
        summaries={[
          { ...summary, traceId: 't-run', title: '进行中任务', status: 'running' },
          { ...summary, traceId: 't-end', title: '已结束任务' }
        ]}
        timeRange="all"
        status="running"
        agent=""
        query=""
        resolveTitle={resolveTitle}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByText('进行中任务')).toBeTruthy()
    expect(screen.queryByText('已结束任务')).toBeNull()
    rerender(
      <TraceList
        summaries={[
          { ...summary, traceId: 't-run', title: '进行中任务', status: 'running' },
          { ...summary, traceId: 't-end', title: '已结束任务' }
        ]}
        timeRange="all"
        status="ended"
        agent=""
        query=""
        resolveTitle={resolveTitle}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.queryByText('进行中任务')).toBeNull()
    expect(screen.getByText('已结束任务')).toBeTruthy()
  })

  it('TraceList 删除需确认，确认后回调 onDelete', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(
      <TraceList
        summaries={[summary]}
        timeRange="all"
        status="all"
        agent=""
        query=""
        resolveTitle={resolveTitle}
        onSelect={vi.fn()}
        onDelete={onDelete}
      />
    )
    // 打开确认对话框
    await user.click(screen.getByLabelText('删除 Trace 测试提问'))
    expect(screen.getByText('删除 Trace？')).toBeTruthy()
    // 确认删除
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ traceId: 't1' }))
  })

  it('Waterfall 根拍平：session.start/task.run 根不渲染行，子项提升为顶层且可点击选中', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <Waterfall
        spans={[
          span({
            spanId: 's1',
            type: 'session.start',
            name: '会话根',
            startedAt: 1000,
            endedAt: 5000,
            durationMs: 4000,
            sequence: 1
          }),
          span({
            spanId: 's2',
            type: 'llm.generate',
            name: 'gpt-4o',
            parentSpanId: 's1',
            startedAt: 1000,
            endedAt: 3000,
            durationMs: 2000,
            sequence: 2
          })
        ]}
        onSelect={onSelect}
      />
    )
    // 根行不渲染（数据保留、仅展示拍平）
    expect(screen.queryByText('会话根')).toBeNull()
    // 子项提升为顶层（depth 0 → paddingLeft 8）
    const llmPad = screen.getByText('gpt-4o').parentElement!.style.paddingLeft
    expect(parseInt(llmPad, 10)).toBe(8)
    await user.click(screen.getByText('gpt-4o'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ spanId: 's2' }))
  })

  it('Waterfall 委派子 Agent 工具行按 Agent 展示（description + 徽章 + 子项缩进）', () => {
    render(
      <Waterfall
        spans={[
          span({
            spanId: 'root',
            type: 'task.run',
            name: '任务',
            startedAt: 1000,
            endedAt: 5000,
            durationMs: 4000,
            sequence: 1
          }),
          span({
            spanId: 'delegate',
            type: 'tool.execute',
            name: 'Agent',
            parentSpanId: 'root',
            input: { description: '探索代码结构', prompt: '...', subagent_type: 'Explore' },
            startedAt: 1000,
            endedAt: 4000,
            durationMs: 3000,
            sequence: 2
          }),
          span({
            spanId: 'inner',
            type: 'llm.generate',
            name: 'qoder-lite',
            parentSpanId: 'delegate',
            startedAt: 1000,
            endedAt: 2000,
            durationMs: 1000,
            sequence: 3
          })
        ]}
        onSelect={vi.fn()}
      />
    )
    // 类型标签为 Agent 而非工具；名称展示 description；附带 subagent_type 徽章
    expect(screen.getByText('Agent')).toBeTruthy()
    expect(screen.queryByText('工具')).toBeNull()
    expect(screen.getByText('探索代码结构')).toBeTruthy()
    expect(screen.getByText('Explore')).toBeTruthy()
    // 子项缩进：内部 llm 行比委派 Agent 行多一级（18px/级）；task.run 根拍平后层级从 8 起
    const delegatePad = screen.getByText('探索代码结构').parentElement!.style.paddingLeft
    const innerPad = screen.getByText('qoder-lite').parentElement!.style.paddingLeft
    expect(parseInt(delegatePad, 10)).toBe(8) // depth 0（根拍平后顶层）
    expect(parseInt(innerPad, 10)).toBe(26) // depth 1
  })

  it('Waterfall 普通工具带 description 不误判为 Agent（Bash 等保持工具行）', () => {
    render(
      <Waterfall
        spans={[
          span({
            spanId: 'root',
            type: 'task.run',
            name: '任务',
            startedAt: 1000,
            endedAt: 5000,
            durationMs: 4000,
            sequence: 1
          }),
          span({
            spanId: 'bash',
            type: 'tool.execute',
            name: 'Bash',
            parentSpanId: 'root',
            input: { command: 'ls -la', description: '列出目录文件' },
            startedAt: 1000,
            endedAt: 2000,
            durationMs: 1000,
            sequence: 2
          })
        ]}
        onSelect={vi.fn()}
      />
    )
    // Bash 行保持工具语义：类型标签「工具」+ 工具名，不渲染 Agent 类型与 description
    expect(screen.getByText('工具')).toBeTruthy()
    expect(screen.queryByText('Agent')).toBeNull()
    expect(screen.getByText('Bash')).toBeTruthy()
    expect(screen.queryByText('列出目录文件')).toBeNull()
  })

  it('Waterfall 过滤空壳 llm（0ms 无输出）并把其子项上提到有效父级', () => {
    render(
      <Waterfall
        spans={[
          span({
            spanId: 'root',
            type: 'task.run',
            name: '任务',
            startedAt: 1000,
            endedAt: 5000,
            durationMs: 4000,
            sequence: 1
          }),
          span({
            spanId: 'vacant',
            type: 'llm.generate',
            name: 'qoder',
            parentSpanId: 'root',
            startedAt: 1000,
            endedAt: 1000,
            durationMs: 0,
            sequence: 2
          }),
          span({
            spanId: 'tool1',
            type: 'tool.execute',
            name: 'Grep',
            parentSpanId: 'vacant',
            startedAt: 1000,
            endedAt: 2000,
            durationMs: 1000,
            sequence: 3
          })
        ]}
        onSelect={vi.fn()}
      />
    )
    // 空壳 llm 自身不渲染，其下工具子项上提到有效父级（root 也拍平 → 顶层）
    expect(screen.queryByText('qoder')).toBeNull()
    expect(screen.getByText('Grep')).toBeTruthy()
    const toolPad = screen.getByText('Grep').parentElement!.style.paddingLeft
    expect(parseInt(toolPad, 10)).toBe(8) // 上提后 depth 0
  })

  it('Waterfall 委派 Agent 行下 LLM → 工具嵌套缩进（逐级 18px）', () => {
    render(
      <Waterfall
        spans={[
          span({
            spanId: 'root',
            type: 'task.run',
            name: '任务',
            startedAt: 1000,
            endedAt: 6000,
            durationMs: 5000,
            sequence: 1
          }),
          span({
            spanId: 'delegate',
            type: 'tool.execute',
            name: 'Agent',
            parentSpanId: 'root',
            input: { description: '实现功能', subagent_type: 'Implement' },
            startedAt: 1000,
            endedAt: 5000,
            durationMs: 4000,
            sequence: 2
          }),
          span({
            spanId: 'inner-llm',
            type: 'llm.generate',
            name: 'qoder-lite',
            parentSpanId: 'delegate',
            output: '计划完成',
            startedAt: 1000,
            endedAt: 2000,
            durationMs: 1000,
            sequence: 3
          }),
          span({
            spanId: 'inner-tool',
            type: 'tool.execute',
            name: 'Grep',
            parentSpanId: 'inner-llm',
            startedAt: 2000,
            endedAt: 3000,
            durationMs: 1000,
            sequence: 4
          })
        ]}
        onSelect={vi.fn()}
      />
    )
    // Agent → LLM → 工具 三级缩进：8 / 26 / 44 px（18px/级，根拍平后顶层从 8 起）
    const agentPad = screen.getByText('实现功能').parentElement!.style.paddingLeft
    const llmPad = screen.getByText('qoder-lite').parentElement!.style.paddingLeft
    const toolPad = screen.getByText('Grep').parentElement!.style.paddingLeft
    expect(parseInt(agentPad, 10)).toBe(8) // depth 0
    expect(parseInt(llmPad, 10)).toBe(26) // depth 1
    expect(parseInt(toolPad, 10)).toBe(44) // depth 2
  })

  it('Waterfall 阶段标签：agent.run 类型列按 meta.phase/trigger 显示阶段名', () => {
    render(
      <Waterfall
        spans={[
          span({
            spanId: 'root',
            type: 'task.run',
            name: '任务',
            startedAt: 1000,
            endedAt: 9000,
            durationMs: 8000,
            sequence: 1
          }),
          span({
            spanId: 'st1',
            type: 'agent.run',
            name: 'Agent planning',
            parentSpanId: 'root',
            meta: { phase: 'planning' },
            startedAt: 1000,
            endedAt: 3000,
            durationMs: 2000,
            sequence: 2
          }),
          span({
            spanId: 'st2',
            type: 'agent.run',
            name: 'Agent implementing',
            parentSpanId: 'root',
            meta: { phase: 'implementation', trigger: 'resume' },
            startedAt: 3000,
            endedAt: 6000,
            durationMs: 3000,
            sequence: 3
          }),
          span({
            spanId: 'st3',
            type: 'agent.run',
            name: 'Agent reviewing',
            parentSpanId: 'root',
            meta: { phase: 'review' },
            startedAt: 6000,
            endedAt: 8000,
            durationMs: 2000,
            sequence: 4
          })
        ]}
        onSelect={vi.fn()}
      />
    )
    // 类型列显示阶段名而非笼统的 Agent
    expect(screen.getByText('Plan')).toBeTruthy()
    expect(screen.getByText('执行（续接）')).toBeTruthy()
    expect(screen.getByText('CodeReview')).toBeTruthy()
    expect(screen.queryByText('Agent')).toBeNull()
  })

  it('Waterfall cancelled span 弱化展示（灰色虚框，不伪装成正常长条）', () => {
    const { container } = render(
      <Waterfall
        spans={[
          span({
            spanId: 'ok',
            type: 'tool.execute',
            name: 'Grep',
            startedAt: 1000,
            endedAt: 2000,
            durationMs: 1000,
            sequence: 1
          }),
          span({
            spanId: 'hung',
            type: 'tool.execute',
            name: 'Read',
            status: 'cancelled',
            startedAt: 2000,
            endedAt: 2500,
            durationMs: 500,
            sequence: 2
          })
        ]}
        onSelect={vi.fn()}
      />
    )
    // cancelled 行的色块带虚框弱化 class，正常行不带
    const bars = container.querySelectorAll('.border-dashed')
    expect(bars.length).toBe(1)
  })

  it('Waterfall 归属重定向：meta.parentToolUseId 把子代理内部 span 挂到委派工具行下', () => {
    render(
      <Waterfall
        spans={[
          span({
            spanId: 'root',
            type: 'task.run',
            name: '任务',
            startedAt: 1000,
            endedAt: 9000,
            durationMs: 8000,
            sequence: 1
          }),
          span({
            spanId: 'delegate',
            type: 'tool.execute',
            name: 'Agent',
            parentSpanId: 'root',
            input: { description: '探索代码库' },
            meta: { toolCallId: 'call-1' },
            startedAt: 1000,
            endedAt: 8000,
            durationMs: 7000,
            sequence: 2
          }),
          span({
            spanId: 'sub',
            type: 'subtask.run',
            name: '探索代码库',
            parentSpanId: 'root',
            meta: { taskId: 'sub1', toolUseId: 'call-1' },
            startedAt: 2000,
            endedAt: 7000,
            durationMs: 5000,
            sequence: 3
          }),
          // 内部 llm：parentSpanId 锚在根上（task_started 滞后），真实归属在 meta.parentToolUseId
          span({
            spanId: 'inner',
            type: 'llm.generate',
            name: 'qoder-lite',
            parentSpanId: 'root',
            meta: { parentToolUseId: 'call-1' },
            startedAt: 2000,
            endedAt: 4000,
            durationMs: 2000,
            sequence: 4
          })
        ]}
        onSelect={vi.fn()}
      />
    )
    // 内部 llm 被重定向到委派工具行下（depth 1），不是顶层（depth 0）
    const innerPad = screen.getByText('qoder-lite').parentElement!.style.paddingLeft
    expect(parseInt(innerPad, 10)).toBe(26)
  })

  it('PayloadInspector 展示 LLM 输入输出与成本标签', () => {
    render(
      <PayloadInspector
        span={span({
          type: 'llm.generate',
          input: { prompt: 'hello' },
          output: 'world',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.001 },
          model: 'gpt-4o'
        })}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Prompt（发送给模型）')).toBeTruthy()
    expect(screen.getByText('hello', { exact: false })).toBeTruthy()
    // Completions 默认展开：有 input 时结果也直接可见（此前默认收起导致工具结果看不到）
    expect(screen.getByText('world', { exact: false })).toBeTruthy()
    expect(screen.getByText(/\$0\.001/)).toBeTruthy()
  })

  it('空 span 显示空态', () => {
    render(<Waterfall spans={[]} onSelect={vi.fn()} />)
    expect(screen.getByText('该 Trace 尚未产生 span 数据')).toBeTruthy()
  })
})
