/**
 * `recordQoderMessage` 的核心契约：必须对"任务不存在"的情况静默早返，
 * 否则上游调用（如 `agents:generate-content` 走 `callQoderReviewer` 哨兵路径）
 * 会被 events 表 FK 约束 / `updateTask` 的 'Task not found' 异常击穿。
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionUsage, TaskStore } from '@coding-agent/core'
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
