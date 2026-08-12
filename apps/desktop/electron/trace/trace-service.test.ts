import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentSpan } from '@task-pipeline/core'
import { spansToAgentEvents } from './trace-service.js'

/** payload 为 unknown 类型，断言前收窄为 Record 便于访问属性。 */
function payloadOf(event: AgentEvent): Record<string, unknown> | undefined {
  return event.payload as Record<string, unknown> | undefined
}

function span(partial: Partial<AgentSpan>): AgentSpan {
  return {
    spanId: 'evt-t1-1',
    traceId: 't1',
    type: 'agent.run',
    name: 'Agent',
    status: 'completed',
    startedAt: 1000,
    endedAt: 2000,
    durationMs: 1000,
    sequence: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial
  }
}

describe('spansToAgentEvents（看板执行 Tab 适配）', () => {
  it('task.run 根不产事件（只是执行树锚点），agent.run → status 事件', () => {
    const events = spansToAgentEvents([
      span({ spanId: 's1', type: 'task.run', name: '任务执行', sequence: 1 }),
      span({ spanId: 's2', type: 'agent.run', name: 'Agent implementing', parentSpanId: 's1', sequence: 2 })
    ])
    expect(events.map((e) => e.kind)).toEqual(['status'])
    expect(events[0]!.title).toBe('Agent implementing')
  })

  it('tool.execute → use/result 两条（Timeline 按 toolUseId 配对）', () => {
    const events = spansToAgentEvents([
      span({
        spanId: 's1',
        type: 'tool.execute',
        name: 'bash',
        status: 'completed',
        input: { cmd: 'ls' },
        output: 'file.ts',
        meta: { toolCallId: 'tc1' },
        sequence: 1
      })
    ])
    expect(events).toHaveLength(2)
    expect(events[0]!.payload).toMatchObject({ toolName: 'bash', toolUseId: 'tc1', phase: 'use', input: { cmd: 'ls' } })
    expect(events[1]!.payload).toMatchObject({ toolName: 'bash', toolUseId: 'tc1', phase: 'result', output: 'file.ts' })
  })

  it('tool.execute 失败 → result 带 isError + 无独立 error 事件', () => {
    const events = spansToAgentEvents([
      span({
        spanId: 's1',
        type: 'tool.execute',
        name: 'bash',
        status: 'error',
        error: { message: 'boom' },
        meta: { toolCallId: 'tc1' },
        sequence: 1
      })
    ])
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0)
    expect(payloadOf(events.find((e) => payloadOf(e)?.phase === 'result')!)?.isError).toBe(true)
  })

  it('subtask.run → status 带 subtaskId/parentTaskId/sdkSubtype，其内 llm/tool 继承 parentTaskId', () => {
    const events = spansToAgentEvents([
      span({
        spanId: 's1',
        type: 'subtask.run',
        name: '实现登录',
        status: 'completed',
        meta: { taskId: 'sub1', sdkSubtype: 'task_started', summary: '完成', toolUseId: 'tc-delegate' },
        sequence: 1
      }),
      span({
        spanId: 's2',
        type: 'llm.generate',
        name: 'qwen-max',
        parentSpanId: 's1',
        meta: { source: 'qoder' },
        sequence: 2
      }),
      span({
        spanId: 's3',
        type: 'tool.execute',
        name: 'edit_file',
        parentSpanId: 's1',
        meta: { toolCallId: 'tc1', source: 'qoder' },
        sequence: 3
      })
    ])
    const sub = events.find((e) => payloadOf(e)?.subtaskId === 'sub1')!
    expect(sub.kind).toBe('status')
    expect(payloadOf(sub)?.sdkSubtype).toBe('task_started')
    expect(payloadOf(sub)?.summary).toBe('完成')
    // 委派工具 callId 透传:Timeline 据此把主流程发起调用「吸收」进子任务卡(避免平级)
    expect(payloadOf(sub)?.toolUseId).toBe('tc-delegate')
    const llm = events.find((e) => e.title === 'LLM 调用')!
    expect(payloadOf(llm)?.parentTaskId).toBe('sub1')
    expect(payloadOf(events.find((e) => payloadOf(e)?.toolUseId === 'tc1')!)?.parentTaskId).toBe('sub1')
  })

  it('llm.generate error → message + error 事件', () => {
    const events = spansToAgentEvents([
      span({
        spanId: 's1',
        type: 'llm.generate',
        name: 'gpt-4o',
        status: 'error',
        error: { message: 'boom' },
        output: '半截回复',
        model: 'gpt-4o',
        sequence: 1
      })
    ])
    expect(events.some((e) => e.kind === 'message' && payloadOf(e)?.model === 'gpt-4o')).toBe(true)
    expect(events.some((e) => e.kind === 'error' && e.detail === 'boom')).toBe(true)
  })

  it('agent.run → 阶段容器（自指 parentTaskId，其内无 subtask 祖先的 llm/tool 折叠进阶段卡）', () => {
    const events = spansToAgentEvents([
      span({ spanId: 's1', type: 'task.run', name: '任务执行', sequence: 1 }),
      span({
        spanId: 's2',
        type: 'agent.run',
        name: 'Agent planning',
        status: 'completed',
        parentSpanId: 's1',
        meta: { source: 'qoder', phase: 'planning' },
        sequence: 2
      }),
      span({
        spanId: 's3',
        type: 'llm.generate',
        name: 'qoder-lite',
        parentSpanId: 's2',
        meta: { source: 'qoder' },
        model: 'qoder-lite',
        sequence: 3
      }),
      span({
        spanId: 's4',
        type: 'tool.execute',
        name: 'Grep',
        parentSpanId: 's3',
        meta: { toolCallId: 'tc1', source: 'qoder' },
        sequence: 4
      }),
      // 子任务子树不受阶段容器影响，仍归 subtask 组
      span({
        spanId: 's5',
        type: 'subtask.run',
        name: '探索',
        status: 'completed',
        parentSpanId: 's3',
        meta: { taskId: 'sub1', sdkSubtype: 'task_started', source: 'qoder' },
        sequence: 5
      }),
      span({
        spanId: 's6',
        type: 'tool.execute',
        name: 'Glob',
        parentSpanId: 's5',
        meta: { toolCallId: 'tc2', source: 'qoder' },
        sequence: 6
      })
    ])
    // 阶段容器自身：自指分组 + 阶段名徽章 + 状态（Timeline 据此折叠成卡）
    const stage = events.find((e) => e.title === 'Agent planning')!
    expect(payloadOf(stage)).toMatchObject({
      subtaskId: 's2',
      parentTaskId: 's2',
      taskType: 'planning',
      description: 'Agent planning',
      status: 'completed'
    })
    // 阶段内 llm/tool（无 subtask 祖先）继承阶段 id（llm 事件标题带模型名）
    expect(payloadOf(events.find((e) => e.title === 'LLM 调用 · qoder-lite')!)?.parentTaskId).toBe('s2')
    expect(payloadOf(events.find((e) => payloadOf(e)?.toolUseId === 'tc1')!)?.parentTaskId).toBe('s2')
    // subtask 子树仍归 subtask，不混入阶段卡
    expect(payloadOf(events.find((e) => payloadOf(e)?.subtaskId === 'sub1')!)?.parentTaskId).toBe('sub1')
    expect(payloadOf(events.find((e) => payloadOf(e)?.toolUseId === 'tc2')!)?.parentTaskId).toBe('sub1')
  })

  it('agent.run error → 阶段卡 status 映射为 failed（状态徽章不误判执行中）', () => {
    const events = spansToAgentEvents([
      span({
        spanId: 's1',
        type: 'agent.run',
        name: 'Agent implementing',
        status: 'error',
        error: { message: 'boom' },
        meta: { source: 'qoder', phase: 'implementing' },
        sequence: 1
      })
    ])
    const stage = events.find((e) => e.title === 'Agent implementing')!
    expect(payloadOf(stage)?.status).toBe('failed')
  })

  it('归属重定向：meta.parentToolUseId 把子代理内部 span 归入 subtask 组（parentSpanId 只是当时锚点）', () => {
    const events = spansToAgentEvents([
      span({ spanId: 's1', type: 'task.run', name: '任务执行', sequence: 1 }),
      span({
        spanId: 's2',
        type: 'tool.execute',
        name: 'Agent',
        parentSpanId: 's1',
        input: { description: '探索代码库' },
        meta: { toolCallId: 'call-1', source: 'qoder' },
        sequence: 2
      }),
      span({
        spanId: 's3',
        type: 'subtask.run',
        name: '探索代码库',
        status: 'completed',
        parentSpanId: 's1',
        meta: { taskId: 'sub1', sdkSubtype: 'task_started', toolUseId: 'call-1', source: 'qoder' },
        sequence: 3
      }),
      // 子代理内部 llm：parentSpanId 锚在根上（task_started 滞后），parentToolUseId 指向委派工具
      span({
        spanId: 's4',
        type: 'llm.generate',
        name: 'qoder-lite',
        model: 'qoder-lite',
        parentSpanId: 's1',
        meta: { parentToolUseId: 'call-1', source: 'qoder' },
        sequence: 4
      }),
      span({
        spanId: 's5',
        type: 'tool.execute',
        name: 'Grep',
        parentSpanId: 's1',
        meta: { toolCallId: 'tc9', parentToolUseId: 'call-1', source: 'qoder' },
        sequence: 5
      })
    ])
    // 内部 llm/tool 按 parentToolUseId 重定向进 subtask 组，而不是平铺主流程
    const llm = events.find((e) => e.title === 'LLM 调用 · qoder-lite')!
    expect(payloadOf(llm)?.parentTaskId).toBe('sub1')
    expect(payloadOf(events.find((e) => payloadOf(e)?.toolUseId === 'tc9')!)?.parentTaskId).toBe('sub1')
    // span 来源事件带 spanId 标记（Timeline 去重豁免）
    expect(payloadOf(llm)?.spanId).toBe('s4')
  })

  it('llm 事件标题：meta.traceLabel 语义名优先（关键词提取等辅助调用）', () => {
    const events = spansToAgentEvents([
      span({
        spanId: 's1',
        type: 'llm.generate',
        name: 'deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        meta: { traceLabel: '关键词提取', source: 'qoder' },
        sequence: 1
      })
    ])
    expect(events[0]!.title).toBe('关键词提取')
  })
})
