import { describe, expect, it } from 'vitest'
import { buildSpanOwnershipIndex, delegateToolIdOf, isDelegateToolSpan, ownerSubtaskOf } from './span-ownership.js'
import { agentStageLabel } from './stage-label.js'
import type { AgentSpan } from './types.js'

function span(partial: Partial<AgentSpan>): AgentSpan {
  return {
    spanId: 's1',
    traceId: 't1',
    type: 'llm.generate',
    name: 'span',
    status: 'completed',
    startedAt: 1000,
    sequence: 1,
    createdAt: new Date(1000).toISOString(),
    ...partial
  }
}

/** 典型新数据：委派工具 + subtask + 子代理内部 span（parentSpanId 是"当时的锚点"，真实归属在 meta）。 */
function newDataSpans(): AgentSpan[] {
  return [
    span({ spanId: 'root', type: 'task.run', name: '任务执行' }),
    span({
      spanId: 'delegate',
      type: 'tool.execute',
      name: 'Agent',
      parentSpanId: 'root',
      input: { description: '探索代码库' },
      meta: { toolCallId: 'call-1' }
    }),
    span({
      spanId: 'sub',
      type: 'subtask.run',
      name: '探索代码库',
      parentSpanId: 'root',
      meta: { toolUseId: 'call-1' }
    }),
    // 内部 span 的 parentSpanId 锚在 root 上（task_started 滞后），parentToolUseId 才指向委派工具
    span({ spanId: 'inner-llm', type: 'llm.generate', parentSpanId: 'root', meta: { parentToolUseId: 'call-1' } }),
    span({
      spanId: 'inner-tool',
      type: 'tool.execute',
      name: 'grep',
      parentSpanId: 'inner-llm',
      meta: { parentToolUseId: 'call-1' }
    })
  ]
}

describe('span-ownership（渲染层归属重定向）', () => {
  it('新数据：按 meta.parentToolUseId 一步解析到所属 subtask.run', () => {
    const spans = newDataSpans()
    const index = buildSpanOwnershipIndex(spans)
    const sub = spans.find((s) => s.spanId === 'sub')!
    for (const inner of ['inner-llm', 'inner-tool']) {
      expect(ownerSubtaskOf(spans.find((s) => s.spanId === inner)!, index)?.spanId).toBe(sub.spanId)
    }
  })

  it('新数据：嵌套子代理沿链逐级（内层 span 解析到最内层 subtask）', () => {
    const spans = [
      ...newDataSpans(),
      // 内层委派工具本身是外层子代理的内部 span
      span({
        spanId: 'delegate-2',
        type: 'tool.execute',
        name: 'Agent',
        parentSpanId: 'sub',
        input: { description: '二层子代理' },
        meta: { toolCallId: 'call-2', parentToolUseId: 'call-1' }
      }),
      span({
        spanId: 'sub-2',
        type: 'subtask.run',
        name: '二层子代理',
        parentSpanId: 'sub',
        meta: { toolUseId: 'call-2', parentToolUseId: 'call-1' }
      }),
      span({
        spanId: 'inner-2',
        type: 'llm.generate',
        parentSpanId: 'sub',
        meta: { parentToolUseId: 'call-2' }
      })
    ]
    const index = buildSpanOwnershipIndex(spans)
    // 最内层 span → 最内层 subtask
    expect(ownerSubtaskOf(spans.find((s) => s.spanId === 'inner-2')!, index)?.spanId).toBe('sub-2')
    // 内层委派工具/subtask 自身 → 外层 subtask
    expect(ownerSubtaskOf(spans.find((s) => s.spanId === 'delegate-2')!, index)?.spanId).toBe('sub')
    expect(ownerSubtaskOf(spans.find((s) => s.spanId === 'sub-2')!, index)?.spanId).toBe('sub')
  })

  it('旧数据兼容：parentSpanId 被改写为 subtask.run 时沿链走查命中', () => {
    const spans = [
      span({ spanId: 'root', type: 'task.run', name: '任务执行' }),
      span({
        spanId: 'delegate',
        type: 'tool.execute',
        name: 'Agent',
        parentSpanId: 'sub',
        input: { description: '探索' },
        meta: { toolCallId: 'call-1' }
      }),
      span({ spanId: 'sub', type: 'subtask.run', name: '探索', parentSpanId: 'root', meta: { toolUseId: 'call-1' } }),
      // 旧埋点把内部 span 的 parentSpanId 直接改写为 subtask.run，且无 parentToolUseId
      span({ spanId: 'inner-llm', type: 'llm.generate', parentSpanId: 'sub' })
    ]
    const index = buildSpanOwnershipIndex(spans)
    expect(ownerSubtaskOf(spans.find((s) => s.spanId === 'inner-llm')!, index)?.spanId).toBe('sub')
  })

  it('主流程 span 返回 undefined', () => {
    const spans = newDataSpans()
    const index = buildSpanOwnershipIndex(spans)
    expect(ownerSubtaskOf(spans.find((s) => s.spanId === 'root')!, index)).toBeUndefined()
    expect(ownerSubtaskOf(spans.find((s) => s.spanId === 'delegate')!, index)).toBeUndefined()
  })

  it('delegateToolIdOf：新数据按 meta.toolUseId 反查，旧数据回退 legacy 映射', () => {
    const spans = newDataSpans()
    const index = buildSpanOwnershipIndex(spans)
    const sub = spans.find((s) => s.spanId === 'sub')!
    expect(delegateToolIdOf(sub, index)).toBe('delegate')

    // 旧数据：subtask 无 meta.toolUseId，委派工具 parentSpanId 直指 subtask
    const legacySpans = [
      span({ spanId: 'sub', type: 'subtask.run', name: '探索', parentSpanId: 'root' }),
      span({
        spanId: 'delegate',
        type: 'tool.execute',
        name: 'Agent',
        parentSpanId: 'sub',
        input: { description: '探索' }
      })
    ]
    const legacyIndex = buildSpanOwnershipIndex(legacySpans)
    expect(delegateToolIdOf(legacySpans[0]!, legacyIndex)).toBe('delegate')
  })

  it('isDelegateToolSpan：Bash 等普通工具的 description 不误判为委派调用', () => {
    expect(
      isDelegateToolSpan(span({ type: 'tool.execute', name: 'Agent', input: { description: '探索代码库' } }))
    ).toBe(true)
    expect(
      isDelegateToolSpan(
        span({ type: 'tool.execute', name: 'Bash', input: { description: '运行测试', command: 'npm test' } })
      )
    ).toBe(false)
    expect(isDelegateToolSpan(span({ type: 'tool.execute', name: 'Agent', input: {} }))).toBe(false)
    expect(isDelegateToolSpan(span({ type: 'llm.generate', name: 'Agent' }))).toBe(false)
  })
})

describe('agentStageLabel（阶段显示名）', () => {
  const stage = (meta: AgentSpan['meta']) => span({ type: 'agent.run', meta })

  it('各 phase 映射为阶段语义名', () => {
    expect(agentStageLabel(stage({ phase: 'keyword' }))).toBe('关键词提取并注入')
    expect(agentStageLabel(stage({ phase: 'planning' }))).toBe('计划生成')
    expect(agentStageLabel(stage({ phase: 'implementation' }))).toBe('代码实现')
    expect(agentStageLabel(stage({ phase: 'review' }))).toBe('代码审查')
    expect(agentStageLabel(stage({ phase: 'test_generation' }))).toBe('测试生成')
    expect(agentStageLabel(stage({ phase: 'finish' }))).toBe('完成')
    expect(agentStageLabel(stage({ phase: 'memory' }))).toBe('记忆整理')
  })

  it('implementation：round ≥ 1 → 重新执行 #n；trigger 标记恢复/续接', () => {
    expect(agentStageLabel(stage({ phase: 'implementation', round: 2 }))).toBe('重新执行 #2')
    expect(agentStageLabel(stage({ phase: 'implementation', trigger: 'resume' }))).toBe('执行（续接）')
    expect(agentStageLabel(stage({ phase: 'implementation', trigger: 'followup' }))).toBe('执行（追加指令）')
  })

  it('非 agent.run / 无 phase 返回 undefined；未知 phase 原样透出', () => {
    expect(agentStageLabel(span({ type: 'llm.generate', meta: { phase: 'keyword' } }))).toBeUndefined()
    expect(agentStageLabel(stage(undefined))).toBeUndefined()
    expect(agentStageLabel(stage({ phase: 'custom' }))).toBe('custom')
  })
})
