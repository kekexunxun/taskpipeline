import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '../chat/chat-types.js'
import { chatEntries } from './chat-entries.js'

/** 构造一条带 parts 的 assistant 消息。 */
function message(parts: StoredMessage['parts'], overrides?: Partial<StoredMessage>): StoredMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: '2025-01-01T00:00:00.000Z',
    driverId: 'qoder',
    raw: {},
    ...overrides,
    parts
  }
}

describe('chatEntries', () => {
  it('text / thinking / tool part 传播 parentTaskId(子任务归属)', () => {
    const entries = chatEntries('c1', [
      message([
        { driverId: 'qoder', type: 'text', text: '子任务内文本', parentTaskId: 't-1' },
        { driverId: 'qoder', type: 'qoder.thinking', text: '思考一下', parentTaskId: 't-1' },
        {
          driverId: 'qoder',
          type: 'qoder.tool-use',
          toolCallId: 'c-1',
          name: 'Read',
          input: { file_path: '/a.ts' },
          parentTaskId: 't-1'
        }
      ])
    ])
    expect(entries).toHaveLength(3)
    expect(entries.every((e) => e.parentTaskId === 't-1')).toBe(true)
    expect(entries[0]).toMatchObject({ type: 'message', title: 'AI', detail: '子任务内文本' })
    expect(entries[1]).toMatchObject({ type: 'thinking', title: '思考' })
  })

  it('tool-use / tool-result payload 携带 toolName / input / output(供 ToolCallRow 展示)', () => {
    const entries = chatEntries('c1', [
      message([
        { driverId: 'qoder', type: 'qoder.tool-use', toolCallId: 'c-1', name: 'Read', input: { file_path: '/a.ts' } },
        { driverId: 'qoder', type: 'qoder.tool-result', toolCallId: 'c-1', output: '内容', isError: false }
      ])
    ])
    expect(entries[0]).toMatchObject({
      type: 'tool_call',
      title: '工具 Read',
      payload: { toolCallId: 'c-1', toolName: 'Read', input: { file_path: '/a.ts' } }
    })
    expect(entries[1]).toMatchObject({
      type: 'tool_result',
      payload: { toolCallId: 'c-1', output: '内容', isError: false }
    })
  })

  it('subtask-start / progress / end 三类 part 转换为带 sdkSubtype 的 entry(可折叠)', () => {
    const entries = chatEntries('c1', [
      message([
        {
          driverId: 'qoder',
          type: 'qoder.subtask-start',
          taskId: 't-1',
          parentTaskId: 't-1',
          taskType: 'search',
          description: '查询文档',
          toolUseId: 'toolu_spawn'
        },
        {
          driverId: 'qoder',
          type: 'qoder.subtask-progress',
          taskId: 't-1',
          parentTaskId: 't-1',
          description: '正在搜索',
          lastToolName: 'searchDocs',
          usage: { total_tokens: 10 }
        },
        {
          driverId: 'qoder',
          type: 'qoder.subtask-end',
          taskId: 't-1',
          parentTaskId: 't-1',
          status: 'completed',
          summary: '完成'
        }
      ])
    ])
    expect(entries).toHaveLength(3)
    // task_started:header 识别需要 taskId/parentTaskId 自指 + payload.toolUseId(spawner 吸收)
    expect(entries[0]).toMatchObject({
      type: 'status',
      taskId: 't-1',
      parentTaskId: 't-1',
      sdkSubtype: 'task_started',
      payload: { taskId: 't-1', taskType: 'search', toolUseId: 'toolu_spawn', description: '查询文档' }
    })
    expect(entries[1]).toMatchObject({
      sdkSubtype: 'task_progress',
      payload: { taskId: 't-1', lastToolName: 'searchDocs', description: '正在搜索' }
    })
    expect(entries[2]).toMatchObject({
      sdkSubtype: 'task_notification',
      payload: { taskId: 't-1', status: 'completed', summary: '完成' }
    })
  })

  it('openai tool-call / tool-result 同样转换', () => {
    const entries = chatEntries('c1', [
      message(
        [
          { driverId: 'openai', type: 'openai.tool-call', toolCallId: 'o-1', name: 'search', input: { query: 'q' } },
          { driverId: 'openai', type: 'openai.tool-result', toolCallId: 'o-1', output: 'r' }
        ],
        { driverId: 'openai' }
      )
    ])
    expect(entries[0]).toMatchObject({ type: 'tool_call', payload: { toolCallId: 'o-1', toolName: 'search' } })
    expect(entries[1]).toMatchObject({ type: 'tool_result', payload: { toolCallId: 'o-1', output: 'r' } })
  })

  it('无 parts 的消息按 role 兜底输出 raw 文本', () => {
    const entries = chatEntries('c1', [
      {
        id: 'm0',
        role: 'user',
        createdAt: '2025-01-01T00:00:00.000Z',
        driverId: 'qoder',
        raw: { text: '你好' },
        parts: []
      }
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'message', title: '用户', detail: '你好' })
  })
})
