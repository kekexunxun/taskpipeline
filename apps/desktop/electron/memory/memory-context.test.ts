import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatConversation } from '../chat/chat-types.js'

/**
 * consolidateChatMemory 增量游标 + 超长尾部截断的回归测试。
 * 用 stub driver 捕获 streamChat 实际收到的整理文本，不触真实 LLM。
 */
const { initMemoryContext, consolidateChatMemory } = await import('./memory-context.js')

const captured: Array<{ text: string }> = []

function stubDeps(consolidateMemoriesCalls: number[][] = []) {
  const driver = {
    deserializeMessage: (record: unknown) => {
      const raw = (record as { raw?: { text?: string } }).raw ?? {}
      return { parts: [{ type: 'text', text: raw.text ?? '' }] }
    },
    serializeUserMessage: (message: { id: string; text: string; createdAt: string }) => ({
      id: message.id,
      role: 'user',
      createdAt: message.createdAt,
      driverId: 'qoder',
      raw: { kind: 'user', text: message.text }
    }),
    // 收集 user prompt 正文（prompt 头部固定，尾部为待整理记录），然后无输出结束。
    streamChat: (input: { userInput: { text: string } }): AsyncGenerator<never> => {
      captured.push({ text: input.userInput.text })
      return (async function* () {
        // 无输出：parseExtractedMemories 返回空，但提取尝试已完成（游标推进）
      })()
    },
    closeSession: () => undefined
  }
  const deps = {
    store: {
      getTask: () => undefined,
      listTaskRepositories: () => [],
      listEvents: () => [],
      getSetting: () => undefined,
      listRepositoryProfiles: () => []
    },
    memoryService: {
      search: async () => ({ memories: [], wikiDocs: [], keywords: [] }),
      ensureUserId: () => 'u-test',
      consolidateMemories: (memories: unknown[]) => {
        consolidateMemoriesCalls.push([memories.length])
        return 0
      },
      verifyTaskMemories: () => 0
    },
    chatDriverRegistry: { tryGet: () => driver },
    agentService: { resolveRuntime: () => ({}) },
    tracePipeline: {
      isActive: () => false,
      beginTrace: () => undefined,
      ensureRootSpan: () => undefined,
      startSpan: () => ({}),
      endSpan: () => undefined,
      endTrace: () => undefined
    },
    addTaskEvent: () => undefined,
    runtimeProvider: () => 'qoder',
    modelProvider: () => 'qoder',
    resolveOpenAIModelValue: () => 'openai:gpt',
    syncSystemDefaultModel: () => undefined,
    isModelValueAvailable: () => true,
    resolveLiteModel: async () => 'lite',
    startTaskStageSpan: () => undefined
  }
  return deps as unknown as Parameters<typeof initMemoryContext>[0]
}

function conversation(id: string, texts: string[]): ChatConversation {
  return {
    id,
    messages: texts.map((text, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      createdAt: '2026-01-01T00:00:00Z',
      driverId: 'qoder',
      raw: { text }
    }))
  } as unknown as ChatConversation
}

beforeEach(() => {
  captured.length = 0
  initMemoryContext(stubDeps())
})

describe('对话整理增量游标', () => {
  it('第二次整理只带游标之后的新消息', async () => {
    const conv = conversation('c-inc', ['第一条 早先内容 inc-first', '第二条 早先回复 inc-second'])
    await consolidateChatMemory({
      conversation: conv,
      signal: new AbortController().signal,
      driverId: 'qoder',
      model: 'm'
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]!.text).toContain('inc-first')

    conv.messages.push({
      id: 'm-2',
      role: 'user',
      createdAt: '2026-01-01T00:01:00Z',
      driverId: 'qoder',
      raw: { text: '第三条 新结论 inc-third' }
    } as never)
    await consolidateChatMemory({
      conversation: conv,
      signal: new AbortController().signal,
      driverId: 'qoder',
      model: 'm'
    })
    expect(captured).toHaveLength(2)
    expect(captured[1]!.text).toContain('inc-third')
    expect(captured[1]!.text).not.toContain('inc-first')
  })

  it('无新消息时不再调用 LLM', async () => {
    const conv = conversation('c-none', ['已有内容 no-new-marker'])
    await consolidateChatMemory({
      conversation: conv,
      signal: new AbortController().signal,
      driverId: 'qoder',
      model: 'm'
    })
    expect(captured).toHaveLength(1)
    await consolidateChatMemory({
      conversation: conv,
      signal: new AbortController().signal,
      driverId: 'qoder',
      model: 'm'
    })
    expect(captured).toHaveLength(1)
  })

  it('消息回退（编辑/重生成）时重置游标重新全量提取', async () => {
    const conv = conversation('c-rollback', ['原始第一条 rb-one', '原始第二条 rb-two'])
    await consolidateChatMemory({
      conversation: conv,
      signal: new AbortController().signal,
      driverId: 'qoder',
      model: 'm'
    })
    conv.messages = conv.messages.slice(0, 1)
    conv.messages.push({
      id: 'm-1b',
      role: 'assistant',
      createdAt: '2026-01-01T00:02:00Z',
      driverId: 'qoder',
      raw: { text: '重新生成的回复 rb-regen' }
    } as never)
    await consolidateChatMemory({
      conversation: conv,
      signal: new AbortController().signal,
      driverId: 'qoder',
      model: 'm'
    })
    expect(captured).toHaveLength(2)
    expect(captured[1]!.text).toContain('rb-one')
    expect(captured[1]!.text).toContain('rb-regen')
  })
})

describe('超长记录尾部截断', () => {
  it('超过上限时保留最新内容而非开头', async () => {
    const head = 'HEADSIDE-老内容-'.padEnd(14_000, 'x')
    const conv = conversation('c-tail', [`${head} 对话尾部最新结论 TAILMARK`])
    await consolidateChatMemory({
      conversation: conv,
      signal: new AbortController().signal,
      driverId: 'qoder',
      model: 'm'
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]!.text).toContain('TAILMARK')
    expect(captured[0]!.text).not.toContain('HEADSIDE')
  })
})
