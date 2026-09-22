import { describe, expect, it } from 'vitest'
import { aggregateTaskToolParts } from './aggregateTaskParts'
import type { DriverPart } from '@/api'

/**
 * aggregateTaskToolParts 纯函数单测:
 * Chat 落盘的原始任务工具 part(qoder.tool-use / qoder.tool-result)应被折叠为
 * 一张 qoder.task-list 清单卡,且对已聚合形态幂等(执行 Tab 复用安全)。
 */

function toolUse(name: string, input: unknown, toolCallId: string, parentTaskId?: string): DriverPart {
  return {
    driverId: 'qoder',
    type: 'qoder.tool-use',
    name,
    input,
    toolCallId,
    ...(parentTaskId ? { parentTaskId } : {})
  }
}

function toolResult(toolCallId: string, output: unknown): DriverPart {
  return { driverId: 'qoder', type: 'qoder.tool-result', toolCallId, output }
}

function textPart(text: string): DriverPart {
  return { driverId: 'qoder', type: 'text', text }
}

function createdResult(taskId: number, subject: string): string {
  return `Task #${taskId} created successfully: ${subject}`
}

describe('aggregateTaskToolParts', () => {
  it('无任务工具 part 时原样返回(引用相等)', () => {
    const parts: DriverPart[] = [textPart('hi'), toolUse('Read', { file_path: '/a' }, 'tc-r'), toolResult('tc-r', 'ok')]
    expect(aggregateTaskToolParts(parts)).toBe(parts)
  })

  it('TaskCreate×4 聚合为单张清单卡并移除原始工具行', () => {
    const parts: DriverPart[] = [
      textPart('我来拆解任务'),
      toolUse('TaskCreate', { subject: '占位A' }, 'tc-1'),
      toolResult('tc-1', createdResult(11, '实现登录页')),
      toolUse('TaskCreate', { subject: '占位B' }, 'tc-2'),
      toolResult('tc-2', createdResult(12, '补充单测')),
      toolUse('TaskCreate', { subject: '占位C' }, 'tc-3'),
      toolResult('tc-3', createdResult(13, '联调接口')),
      toolUse('TaskCreate', { subject: '占位D' }, 'tc-4'),
      toolResult('tc-4', createdResult(14, '发布验证')),
      textPart('已加入待办')
    ]
    const out = aggregateTaskToolParts(parts)
    const cards = out.filter((p) => p.type === 'qoder.task-list')
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card?.type === 'qoder.task-list' && card.header).toBe('添加待办')
    expect(card?.type === 'qoder.task-list' && card.items).toEqual([
      { taskId: '11', subject: '实现登录页', completed: false },
      { taskId: '12', subject: '补充单测', completed: false },
      { taskId: '13', subject: '联调接口', completed: false },
      { taskId: '14', subject: '发布验证', completed: false }
    ])
    // 原始任务工具行全部移除,普通 part 保序保留。
    expect(out.some((p) => p.type === 'qoder.tool-use' || p.type === 'qoder.tool-result')).toBe(false)
    expect(out.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : ''))).toEqual([
      '我来拆解任务',
      '已加入待办'
    ])
    // 卡片置于首个任务工具处(在两段文本之间)。
    expect(out.map((p) => p.type)).toEqual(['text', 'qoder.task-list', 'text'])
  })

  it('TaskUpdate completed 标记条目完成,其余任务工具只清噪音行', () => {
    const parts: DriverPart[] = [
      toolUse('TaskCreate', {}, 'tc-1', 'parent-1'),
      toolResult('tc-1', createdResult(21, '写文档')),
      toolUse('TaskUpdate', { taskId: 21, status: 'completed' }, 'tc-2'),
      toolResult('tc-2', 'Updated task #21 status to completed'),
      toolUse('TaskList', {}, 'tc-3'),
      toolResult('tc-3', '#21 写文档 (completed)')
    ]
    const out = aggregateTaskToolParts(parts)
    expect(out).toHaveLength(1)
    const card = out[0]
    expect(card?.type === 'qoder.task-list' && card.items).toEqual([
      { taskId: '21', subject: '写文档', completed: true }
    ])
    expect(card?.type === 'qoder.task-list' && card.parentTaskId).toBe('parent-1')
  })

  it('流式早期 result 未到:退化为顺序号 + input.subject 占位', () => {
    const parts: DriverPart[] = [
      toolUse('TaskCreate', { subject: '先建一半' }, 'tc-1'),
      toolResult('tc-1', createdResult(31, '先建一半')),
      toolUse('TaskCreate', { subject: '还没回' }, 'tc-2')
    ]
    const out = aggregateTaskToolParts(parts)
    const card = out.find((p) => p.type === 'qoder.task-list')
    expect(card?.type === 'qoder.task-list' && card.items).toEqual([
      { taskId: '31', subject: '先建一半', completed: false },
      { taskId: '2', subject: '还没回', completed: false }
    ])
  })

  it('幂等:已聚合的执行 Tab parts 原样返回', () => {
    const parts: DriverPart[] = [
      textPart('进度'),
      {
        driverId: 'qoder',
        type: 'qoder.task-list',
        header: '添加待办',
        items: [{ taskId: '1', subject: 'A', completed: true }]
      }
    ]
    expect(aggregateTaskToolParts(parts)).toBe(parts)
  })
})
