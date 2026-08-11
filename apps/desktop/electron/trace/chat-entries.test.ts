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

  it('openai.thinking part 映射为 thinking 条目(修复:openai 思考/消耗此前完全不展示)', () => {
    const entries = chatEntries('c1', [
      message(
        [
          { driverId: 'openai', type: 'openai.thinking', text: '思考中…' },
          { driverId: 'openai', type: 'text', text: '用 openai 回复你' }
        ],
        { driverId: 'openai' }
      )
    ])
    const thinking = entries.find((e) => e.type === 'thinking')
    expect(thinking).toBeDefined()
    expect(thinking!.detail).toBe('思考中…')
  })

  it('流式碎片合并:相邻 text 拼接、相邻 thinking 合并(修复:Qoder 消息按 delta 分块)', () => {
    const entries = chatEntries('c1', [
      message([
        { driverId: 'qoder', type: 'qoder.thinking', text: '思考行1' },
        { driverId: 'qoder', type: 'qoder.thinking', text: '思考行2' },
        { driverId: 'qoder', type: 'text', text: '正文片段1' },
        { driverId: 'qoder', type: 'text', text: '正文片段2' },
        { driverId: 'qoder', type: 'text', text: '正文片段3' }
      ])
    ])
    // 93 碎片场景的缩样:5 个碎片 → 1 条 message + 1 条 thinking
    expect(entries.filter((e) => e.type === 'message')).toHaveLength(1)
    expect(entries.filter((e) => e.type === 'thinking')).toHaveLength(1)
    expect(entries.find((e) => e.type === 'message')?.detail).toBe('正文片段1正文片段2正文片段3')
    // qoder thinking 按行推送,用 \n 分隔(与 ChatPage PartRenderer 一致)
    expect(entries.find((e) => e.type === 'thinking')?.detail).toBe('思考行1\n思考行2')
  })

  it('碎片合并不跨消息、不跨 parentTaskId', () => {
    const entries = chatEntries('c1', [
      message([{ driverId: 'qoder', type: 'text', text: '第一条' }]),
      message([{ driverId: 'qoder', type: 'text', text: '第二条' }]),
      message([
        { driverId: 'qoder', type: 'text', text: '主流程', parentTaskId: 't1' },
        { driverId: 'qoder', type: 'text', text: '子任务', parentTaskId: 't2' }
      ])
    ])
    expect(entries.filter((e) => e.type === 'message')).toHaveLength(4)
    expect(entries.map((e) => e.detail)).toEqual(['第一条', '第二条', '主流程', '子任务'])
  })

  it('混合会话(qoder + openai):openai 消息 usage 进 message entry payload,消耗可展示', () => {
    const entries = chatEntries('c1', [
      message(
        [{ driverId: 'qoder', type: 'text', text: '好的，我来写。' }],
        { driverId: 'qoder' }
      ),
      message(
        [
          { driverId: 'openai', type: 'openai.thinking', text: '思考中…' },
          { driverId: 'openai', type: 'text', text: '用 openai 回复你' }
        ],
        {
          driverId: 'openai',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.002 }
        }
      )
    ])
    expect(entries).toHaveLength(3)
    const openaiMsg = entries.find((e) => e.type === 'message' && e.detail === '用 openai 回复你')
    expect(openaiMsg?.payload).toMatchObject({ usage: { input: 100, output: 50, cost: 0.002 } })
    // 两条思考(qoder + openai)都在
    expect(entries.filter((e) => e.type === 'thinking')).toHaveLength(1)
    expect(entries.some((e) => e.type === 'thinking' && e.detail === '思考中…')).toBe(true)
  })
})
