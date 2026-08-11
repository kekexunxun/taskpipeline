/**
 * `recordQoderMessage` 的核心契约：必须对"任务不存在"的情况静默早返，
 * 否则上游调用（如 `agents:generate-content` 走 `callQoderReviewer` 哨兵路径）
 * 会被 events 表 FK 约束 / `updateTask` 的 'Task not found' 异常击穿。
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionUsage, TaskStore } from '@task-pipeline/core'
import type { SDKMessage } from '@qoder-ai/qoder-agent-sdk'
import { recordQoderMessage } from './log.js'

function makeAssistantMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 2 }
    }
  } as unknown as SDKMessage
}

function makeResultMessage(result: string): SDKMessage {
  return {
    type: 'result',
    result,
    duration_ms: 100,
    num_turns: 1
  } as unknown as SDKMessage
}

describe('recordQoderMessage — 哨兵 taskId 防御', () => {
  it('任务不存在时对 assistant 消息静默早返，不触发 addEvent / updateTask / emitPi', () => {
    const addEvent = vi.fn()
    const updateTask = vi.fn()
    const emitPi = vi.fn()
    const store = {
      getTask: () => undefined,
      addEvent,
      updateTask
    } as unknown as TaskStore

    expect(() =>
      recordQoderMessage(store, '__agent_generator__', makeAssistantMessage('hi'), {
        recordText: true,
        addTaskEvent: addEvent as never,
        emitPi: emitPi as never
      })
    ).not.toThrow()

    expect(addEvent).not.toHaveBeenCalled()
    expect(updateTask).not.toHaveBeenCalled()
    expect(emitPi).not.toHaveBeenCalled()
  })

  it("任务不存在时对 result 消息也静默早返（避免 updateTask 'Task not found'）", () => {
    const updateTask = vi.fn()
    const store = {
      getTask: () => undefined,
      addEvent: vi.fn(),
      updateTask
    } as unknown as TaskStore

    expect(() =>
      recordQoderMessage(store, '__agent_generator__', makeResultMessage('{}'), {
        recordText: true,
        addTaskEvent: vi.fn() as never,
        emitPi: vi.fn() as never
      })
    ).not.toThrow()

    expect(updateTask).not.toHaveBeenCalled()
  })

  it('任务存在时仍按原行为调用 addTaskEvent / emitPi（回归保护）', () => {
    const usage: SessionUsage = {
      provider: 'qoder',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: 0,
      turns: 0
    }
    const store = {
      getTask: () => ({ id: 'real-task', sessionUsage: usage }),
      addEvent: vi.fn(),
      updateTask: vi.fn()
    } as unknown as TaskStore

    const addTaskEvent = vi.fn()
    const emitPi = vi.fn()
    recordQoderMessage(store, 'real-task', makeAssistantMessage('hi'), {
      recordText: true,
      addTaskEvent: addTaskEvent as never,
      emitPi: emitPi as never
    })

    expect(addTaskEvent).toHaveBeenCalledTimes(1)
    expect(emitPi).toHaveBeenCalledTimes(1)
    // 真实任务路径必须仍写 sessionUsage —— 不能因为早返而漏掉
    const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
  })
})

/**
 * `recordQoderMessage` 工具调用事件:assistant 消息里的 tool_use block 写一条 kind='tool' 事件,
 * user 消息里的 tool_result block 写另一条 kind='tool' 事件。前端按 toolUseId 配对展示
 * 「执行了什么(input)+ 结果是什么(output)」。这两条事件之前被直接丢,这次回归保护。
 */
describe('recordQoderMessage — tool_use / tool_result 事件', () => {
  function makeAssistantToolUseMessage(): SDKMessage {
    return {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '下面我读一下文件' },
          {
            type: 'tool_use',
            id: 'toolu_001',
            name: 'Read',
            input: { file_path: '/tmp/x.ts', limit: 100 }
          }
        ]
      }
    } as unknown as SDKMessage
  }

  function makeUserToolResultMessage(): SDKMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_001',
            content: 'file contents here',
            is_error: false
          }
        ]
      }
    } as unknown as SDKMessage
  }

  function makeStore(): { store: TaskStore; addTaskEvent: ReturnType<typeof vi.fn> } {
    const addTaskEvent = vi.fn()
    const store = {
      getTask: () => ({ id: 'real-task', sessionUsage: undefined }),
      addEvent: vi.fn(),
      updateTask: vi.fn()
    } as unknown as TaskStore
    return { store, addTaskEvent }
  }

  it('assistant.tool_use 写 kind=tool / phase=use 事件,input 走 detail', () => {
    const { store, addTaskEvent } = makeStore()
    recordQoderMessage(store, 'real-task', makeAssistantToolUseMessage(), {
      recordText: true,
      addTaskEvent: addTaskEvent as never,
      emitPi: vi.fn() as never
    })
    // text message 事件 + tool_use 事件
    const toolEvent = addTaskEvent.mock.calls.map((c) => c[0]).find((e: { kind?: string }) => e?.kind === 'tool')
    expect(toolEvent).toBeTruthy()
    expect(toolEvent.title).toBe('Read')
    expect(toolEvent.detail).toContain('file_path')
    expect(toolEvent.detail).toContain('/tmp/x.ts')
    expect(toolEvent.payload.toolName).toBe('Read')
    expect(toolEvent.payload.toolUseId).toBe('toolu_001')
    expect(toolEvent.payload.phase).toBe('use')
    expect(toolEvent.payload.input).toEqual({ file_path: '/tmp/x.ts', limit: 100 })
  })

  it('user.tool_result 写 kind=tool / phase=result 事件,output 走 detail', () => {
    const { store, addTaskEvent } = makeStore()
    // 先喂 assistant.tool_use 建立 toolName 映射,再喂 user.tool_result
    recordQoderMessage(store, 'real-task', makeAssistantToolUseMessage(), {
      recordText: true,
      addTaskEvent: addTaskEvent as never,
      emitPi: vi.fn() as never
    })
    addTaskEvent.mockClear()
    recordQoderMessage(store, 'real-task', makeUserToolResultMessage(), {
      recordText: true,
      addTaskEvent: addTaskEvent as never,
      emitPi: vi.fn() as never
    })
    const toolEvent = addTaskEvent.mock.calls.map((c) => c[0]).find((e: { kind?: string }) => e?.kind === 'tool')
    expect(toolEvent).toBeTruthy()
    expect(toolEvent.title).toBe('Read')
    expect(toolEvent.payload.toolName).toBe('Read')
    expect(toolEvent.payload.toolUseId).toBe('toolu_001')
    expect(toolEvent.payload.phase).toBe('result')
    expect(toolEvent.payload.output).toBe('file contents here')
    expect(toolEvent.payload.isError).toBeUndefined()
  })

  it('tool_result 的 is_error=true 会被透传到 payload.isError', () => {
    const { store, addTaskEvent } = makeStore()
    recordQoderMessage(store, 'real-task', makeAssistantToolUseMessage(), {
      recordText: true,
      addTaskEvent: addTaskEvent as never,
      emitPi: vi.fn() as never
    })
    addTaskEvent.mockClear()
    recordQoderMessage(
      store,
      'real-task',
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_001',
              content: 'permission denied',
              is_error: true
            }
          ]
        }
      } as unknown as SDKMessage,
      {
        recordText: true,
        addTaskEvent: addTaskEvent as never,
        emitPi: vi.fn() as never
      }
    )
    const toolEvent = addTaskEvent.mock.calls
      .map((c) => c[0])
      .find((e: { kind?: string; payload?: { phase?: string } }) => e?.payload?.phase === 'result')
    expect(toolEvent?.payload.isError).toBe(true)
  })

  it('tool_use 事件会带父任务归属字段(parentTaskId),让 groupByParentTask 折叠', () => {
    const { store, addTaskEvent } = makeStore()
    // 喂一个 task_started 消息建立 tool_use_id -> task_id 映射,再喂 assistant 子任务里的 tool_use
    recordQoderMessage(
      store,
      'real-task',
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'sub-task-1',
        tool_use_id: 'toolu_parent',
        task_type: 'Explore',
        description: '查找相关代码'
      } as unknown as SDKMessage,
      {
        recordText: false,
        addTaskEvent: addTaskEvent as never,
        emitPi: vi.fn() as never
      }
    )
    addTaskEvent.mockClear()
    // 子任务内的 tool_use,parent_tool_use_id 反查到 sub-task-1
    recordQoderMessage(
      store,
      'real-task',
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_parent',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_child_001',
              name: 'Grep',
              input: { pattern: 'invoice' }
            }
          ]
        }
      } as unknown as SDKMessage,
      {
        recordText: true,
        addTaskEvent: addTaskEvent as never,
        emitPi: vi.fn() as never
      }
    )
    const toolEvent = addTaskEvent.mock.calls.map((c) => c[0]).find((e: { kind?: string }) => e?.kind === 'tool')
    expect(toolEvent?.payload.parentTaskId).toBe('sub-task-1')
  })

  it('task_progress 写 status 事件,payload 带 description + summary + lastToolName', () => {
    // 之前只提 description,但 SDK 实际发的 task_progress 消息可能 description 空、summary 有内容
    // (类似「已读 1 个文件」)。这次回归保护:summary 也要提到 payload,前端兜底用。
    const { store, addTaskEvent } = makeStore()
    recordQoderMessage(
      store,
      'real-task',
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'sub-1',
        description: '',
        summary: '已读 1 个文件',
        last_tool_name: 'Read'
      } as unknown as SDKMessage,
      {
        recordText: false,
        addTaskEvent: addTaskEvent as never,
        emitPi: vi.fn() as never
      }
    )
    const event = addTaskEvent.mock.calls.map((c) => c[0])[0]
    expect(event.kind).toBe('status')
    expect(event.payload.summary).toBe('已读 1 个文件')
    expect(event.payload.lastToolName).toBe('Read')
    // description 是空字符串,readNonEmptyString 过滤后变 undefined
    expect(event.payload.description).toBeUndefined()
  })

  it('edit/write 类工具成功执行额外写一条 kind=diff 事件(B1 文件变更分类)', () => {
    const { store, addTaskEvent } = makeStore()
    // use 阶段:只写 tool 事件,不写 diff
    recordQoderMessage(
      store,
      'real-task',
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'y' } }]
        }
      } as unknown as SDKMessage,
      {
        recordText: true,
        addTaskEvent: addTaskEvent as never,
        emitPi: vi.fn() as never
      }
    )
    expect(addTaskEvent.mock.calls.map((c) => c[0]).some((e: { kind?: string }) => e?.kind === 'diff')).toBe(false)
    addTaskEvent.mockClear()
    // result 阶段:成功 → diff 事件带 filePath;失败 → 不写 diff
    recordQoderMessage(
      store,
      'real-task',
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'done', is_error: false }]
        }
      } as unknown as SDKMessage,
      {
        recordText: true,
        addTaskEvent: addTaskEvent as never,
        emitPi: vi.fn() as never
      }
    )
    const diffEvent = addTaskEvent.mock.calls.map((c) => c[0]).find((e: { kind?: string }) => e?.kind === 'diff')
    expect(diffEvent).toBeTruthy()
    expect(diffEvent.title).toBe('edit /tmp/a.ts')
    expect(diffEvent.detail).toBe('/tmp/a.ts')
    expect(diffEvent.payload.toolName).toBe('Edit')
    expect(diffEvent.payload.filePath).toBe('/tmp/a.ts')
    addTaskEvent.mockClear()
    // 失败结果:不落 diff
    recordQoderMessage(
      store,
      'real-task',
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'permission denied', is_error: true }]
        }
      } as unknown as SDKMessage,
      {
        recordText: true,
        addTaskEvent: addTaskEvent as never,
        emitPi: vi.fn() as never
      }
    )
    expect(addTaskEvent.mock.calls.map((c) => c[0]).some((e: { kind?: string }) => e?.kind === 'diff')).toBe(false)
  })

  it('只读工具(read/grep)不写 diff 事件', () => {
    const { store, addTaskEvent } = makeStore()
    recordQoderMessage(
      store,
      'real-task',
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'ok', is_error: false }]
        }
      } as unknown as SDKMessage,
      {
        recordText: true,
        addTaskEvent: addTaskEvent as never,
        emitPi: vi.fn() as never
      }
    )
    expect(addTaskEvent.mock.calls.map((c) => c[0]).some((e: { kind?: string }) => e?.kind === 'diff')).toBe(false)
  })
})
