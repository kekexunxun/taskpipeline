import { describe, expect, it } from 'vitest'
import type { ChatDriver } from '../chat/drivers/chat-driver'
import type { ChatStreamChunk } from '../chat/chat-types'
import { extractMemories, parseExtractedMemories } from './memory-extractor'

/** 记录 streamChat 入参 + closeSession 调用的 fake driver（会话隔离断言用）。 */
function createFakeDriver(replyText: string) {
  const calls: Array<{ conversationId: string; traceId?: string; traceLabel?: string }> = []
  const closed: string[] = []
  const driver: ChatDriver = {
    id: 'qoder',
    displayName: 'Fake',
    async listModels() {
      return []
    },
    deserializeMessage(record) {
      return { ...record, parts: [] }
    },
    serializeUserMessage(input) {
      return { id: input.id, role: 'user', createdAt: input.createdAt, driverId: 'qoder', raw: { text: input.text } }
    },
    serializeAssistantMessage(input) {
      return { id: input.id, role: 'assistant', createdAt: input.createdAt, driverId: 'qoder', raw: {} }
    },
    async *streamChat(input) {
      calls.push({ conversationId: input.conversationId, traceId: input.traceId, traceLabel: input.traceLabel })
      yield { type: 'part', part: { driverId: 'qoder', type: 'text', text: replyText } }
    },
    closeSession(id) {
      closed.push(id)
    },
    dispose() {}
  }
  return { driver, calls, closed }
}

const MEMORY_JSON =
  '{"memories":[{"scope":"user","title":"偏好中文回复","content":"用户要求所有回复使用中文。","tags":["偏好"]}]}'

describe('parseExtractedMemories', () => {
  it('解析合法 memories JSON', () => {
    const drafts = parseExtractedMemories(MEMORY_JSON, ['user', 'repo', 'conversation'])
    expect(drafts).toEqual([
      { scope: 'user', title: '偏好中文回复', content: '用户要求所有回复使用中文。', tags: ['偏好'] }
    ])
  })

  it('scope 不在允许列表时丢弃', () => {
    const drafts = parseExtractedMemories(MEMORY_JSON, ['repo'])
    expect(drafts).toEqual([])
  })

  it('非法 JSON / 缺字段返回空', () => {
    expect(parseExtractedMemories('不是 JSON', ['user'])).toEqual([])
    expect(parseExtractedMemories('{"memories":[{"scope":"user"}]}', ['user'])).toEqual([])
    expect(parseExtractedMemories('{}', ['user'])).toEqual([])
  })
})

describe('extractMemories 会话隔离', () => {
  const baseInput = {
    driverId: 'qoder' as const,
    model: 'lite',
    text: '对话正文……',
    context: 'chat' as const,
    allowedScopes: ['user', 'repo', 'conversation'] as Array<'user' | 'repo' | 'conversation'>
  }

  it('两次调用使用不同的一次性 conversationId，且每次结束后 closeSession', async () => {
    const { driver, calls, closed } = createFakeDriver(MEMORY_JSON)

    const first = await extractMemories({ ...baseInput, driver })
    const second = await extractMemories({ ...baseInput, driver })

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.conversationId).toMatch(/^memory-extract-chat-/)
    expect(calls[1]!.conversationId).toMatch(/^memory-extract-chat-/)
    expect(calls[0]!.conversationId).not.toBe(calls[1]!.conversationId)
    expect(closed).toEqual([calls[0]!.conversationId, calls[1]!.conversationId])
  })

  it('一次性 conversationId 带 context 前缀（task）', async () => {
    const { driver, calls, closed } = createFakeDriver(MEMORY_JSON)
    await extractMemories({ ...baseInput, driver, context: 'task' })
    expect(calls[0]!.conversationId).toMatch(/^memory-extract-task-/)
    expect(closed).toEqual([calls[0]!.conversationId])
  })

  it('traceId 透传给 driver（join 调用方执行树），traceLabel 为语义名', async () => {
    const { driver, calls } = createFakeDriver(MEMORY_JSON)
    await extractMemories({ ...baseInput, driver, traceId: 'trace-caller-9' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.traceId).toBe('trace-caller-9')
    expect(calls[0]!.traceLabel).toBe('记忆整理')
  })

  it('driver 抛错时仍 closeSession 并返回空数组', async () => {
    const { driver, closed } = createFakeDriver('')
    const failing: ChatDriver = {
      ...driver,
      async *streamChat(): AsyncGenerator<ChatStreamChunk> {
        yield* []
        throw new Error('llm down')
      }
    }
    const drafts = await extractMemories({ ...baseInput, driver: failing })
    expect(drafts).toEqual([])
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatch(/^memory-extract-chat-/)
  })
})
