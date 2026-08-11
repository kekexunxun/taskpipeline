import { describe, expect, it, vi } from 'vitest'
import type { TaskStore } from '@task-pipeline/core'

/**
 * 假 ai-sdk streamText:用 `vi.mock` 替换 `ai`,把 `streamText().fullStream` 接到一个可脚本化的
 * AsyncIterable,让测试可以精确驱动 streamText 的 chunk 序列。
 */
type StreamChunk = { type: string; [key: string]: unknown }

type StreamTextOptions = { messages: Array<{ role: string }>; system?: string }

/** 可脚本化的流:noFinish=true 时省略 finish chunk(模拟底层静默中断)。 */
type StreamScript = { chunks: StreamChunk[]; error?: Error; noFinish?: boolean }

vi.mock('ai', () => {
  // 每个测试通过 __pushStreamScript 推入一段 chunk 脚本（可选 error 让 fullStream 中途抛错）
  const scripts: StreamScript[] = []
  // 记录每次 streamText 的调用参数,供测试断言 messages / system 的组装结果
  const streamCalls: StreamTextOptions[] = []
  return {
    streamText: (options: StreamTextOptions) => {
      streamCalls.push(options)
      const script = scripts.shift() ?? { chunks: [] }
      return {
        // 真实 ai-sdk 正常结束时总会产出 finish chunk,这里默认补齐(除 noFinish 场景)。
        fullStream: (async function* () {
          for (const chunk of script.chunks) yield chunk
          if (script.error) throw script.error
          if (!script.noFinish)
            yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }
        })()
      }
    },
    stepCountIs: (n: number) => ({ __stepCount: n }),
    tool: (config: unknown) => config,
    // 暴露给测试用
    __pushStreamScript: (s: { chunks: StreamChunk[]; error?: Error }) => scripts.push(s),
    __streamCalls: streamCalls
  }
})

// 记录每次 chatModel/chat 收到的厂商与真实模型名,供测试断言「value 正确映射到模型名 + 按厂商选包」。
const vendorCalls = vi.hoisted(() => [] as Array<{ vendor: string; model: string }>)

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: () => ({
    chatModel: (model: string) => {
      vendorCalls.push({ vendor: 'openai-compatible', model })
      return { modelId: model }
    }
  })
}))

vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: () => ({
    chat: (model: string) => {
      vendorCalls.push({ vendor: 'deepseek', model })
      return { modelId: model }
    }
  })
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => ({
    chat: (model: string) => {
      vendorCalls.push({ vendor: 'openai', model })
      return { modelId: model }
    }
  })
}))

// 必须在 vi.mock 之后 import driver
const { OpenAIChatDriver } = await import('./openai-chat-driver.js')
const aiMock = (await import('ai')) as unknown as {
  __pushStreamScript: (s: StreamScript) => void
  __streamCalls: StreamTextOptions[]
}

/** 清空 chatModel 调用记录。 */
function resetCalledModels(): void {
  vendorCalls.length = 0
}

function fakeStore(profile?: { baseUrl: string; model: string; displayName?: string; apiKeyEnv?: string }): TaskStore {
  return {
    getSetting: (key: string) => {
      if (key === 'modelProfile' && profile) return JSON.stringify(profile)
      return undefined
    },
    setSetting: () => undefined
  } as unknown as TaskStore
}

function fakeStoreProfiles(
  profiles: Array<{
    id?: string
    vendor?: string
    baseUrl: string
    model: string
    displayName?: string
    isDefault?: boolean
  }>
): TaskStore {
  return {
    getSetting: (key: string) => {
      if (key === 'modelProfiles') return JSON.stringify(profiles)
      return undefined
    },
    setSetting: () => undefined
  } as unknown as TaskStore
}

function driver(
  opts: { profile?: { baseUrl: string; model: string; displayName?: string; apiKeyEnv?: string }; apiKey?: string } = {}
) {
  return new OpenAIChatDriver(fakeStore(opts.profile), () => opts.apiKey)
}

function driverWithProfiles(
  opts: {
    profiles: Array<{
      id?: string
      vendor?: string
      baseUrl: string
      model: string
      displayName?: string
      isDefault?: boolean
    }>
    apiKeyFor?: (profile?: { id?: string; isDefault?: boolean }) => string | undefined
  } = { profiles: [] }
) {
  return new OpenAIChatDriver(fakeStoreProfiles(opts.profiles), opts.apiKeyFor ?? (() => 'key'))
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of gen) out.push(x)
  return out
}

describe('OpenAIChatDriver', () => {
  it('emits text parts in order from fullStream', async () => {
    resetCalledModels()
    aiMock.__pushStreamScript({
      chunks: [
        { type: 'text-delta', text: 'Hello' },
        { type: 'text-delta', text: ' world' }
      ]
    })
    const events = await collect(
      driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } }).streamChat({
        conversationId: 'c',
        model: 'openai:default',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const parts = events.flatMap((e) => (e.type === 'part' ? [e.part] : []))
    expect(parts.map((p) => p.type)).toEqual(['text', 'text'])
    expect(parts.map((p) => (p.type === 'text' ? p.text : ''))).toEqual(['Hello', ' world'])
    const done = events.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    // 历史占位 value `openai:default` 应映射到 profile 里配置的真实模型名
    expect(vendorCalls).toEqual([{ vendor: 'openai-compatible', model: 'gpt-5' }])
  })

  it('maps `openai:<model>` value to the real model name', async () => {
    resetCalledModels()
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    await collect(
      driver({ profile: { baseUrl: 'https://api.example.com', model: 'DeepSeek-V4-Flash' } }).streamChat({
        conversationId: 'c',
        model: 'openai:DeepSeek-V4-Flash',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(vendorCalls).toEqual([{ vendor: 'openai-compatible', model: 'DeepSeek-V4-Flash' }])
  })

  it('emits openai.thinking parts from reasoning-delta chunks', async () => {
    aiMock.__pushStreamScript({
      chunks: [
        { type: 'reasoning-delta', id: 'r1', text: '先分析' },
        { type: 'reasoning-delta', id: 'r1', text: '再动手' },
        { type: 'text-delta', text: '结果' }
      ]
    })
    const events = await collect(
      driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } }).streamChat({
        conversationId: 'c',
        model: 'openai:gpt-5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const parts = events.flatMap((e) => (e.type === 'part' ? [e.part] : []))
    const thinking = parts.filter((p) => p.type === 'openai.thinking')
    expect(thinking).toHaveLength(2)
    expect(thinking.map((p) => (p.type === 'openai.thinking' ? p.text : ''))).toEqual(['先分析', '再动手'])
    expect(parts.map((p) => p.type)).toEqual(['openai.thinking', 'openai.thinking', 'text'])
  })

  it('rethrows mid-stream errors even after partial output (no silent swallow)', async () => {
    aiMock.__pushStreamScript({
      chunks: [{ type: 'text-delta', text: 'partial' }],
      error: new Error('network dropped')
    })
    // 已有部分输出时发生错误也必须上抛（否则 UI 显示不完整回答且无错误提示）。
    await expect(async () => {
      for await (const _ of driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } }).streamChat({
        conversationId: 'c',
        model: 'openai:gpt-5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })) {
        void _
      }
    }).rejects.toThrow('network dropped')
  })

  it('throws on an error chunk (TextStreamErrorPart) from the fullStream', async () => {
    // ai-sdk 对「不终止流的错误」（如 finish_reason:error 前的网络抖动）产出 error chunk，
    // 不会让 fullStream 抛异常；不处理会被静默吞掉导致界面显示半截回复且无提示。
    aiMock.__pushStreamScript({
      chunks: [
        { type: 'text-delta', text: 'partial' },
        { type: 'error', error: new Error('stream aborted by upstream') }
      ]
    })
    await expect(async () => {
      for await (const _ of driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } }).streamChat({
        conversationId: 'c',
        model: 'openai:gpt-5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })) {
        void _
      }
    }).rejects.toThrow('stream aborted by upstream')
  })

  it('throws when the stream ends without a finish chunk (silent mid-stream drop)', async () => {
    // 底层连接静默断开时 fullStream 既不抛错也不产 finish chunk,for-await 直接结束;
    // 必须上抛,否则界面显示半截回复且假装完成。
    aiMock.__pushStreamScript({
      chunks: [{ type: 'text-delta', text: 'partial' }],
      noFinish: true
    })
    await expect(async () => {
      for await (const _ of driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } }).streamChat({
        conversationId: 'c',
        model: 'openai:gpt-5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })) {
        void _
      }
    }).rejects.toThrow(/未收到完成标记/)
  })

  it('throws when the finish chunk reports finishReason=error', async () => {
    // DeepSeek 等兼容端点会以 finish_reason:error 正常结束流而不抛异常，同样必须上抛。
    aiMock.__pushStreamScript({
      chunks: [
        { type: 'text-delta', text: 'partial' },
        { type: 'finish', finishReason: 'error', usage: { inputTokens: 1, outputTokens: 1 } }
      ]
    })
    await expect(async () => {
      for await (const _ of driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } }).streamChat({
        conversationId: 'c',
        model: 'openai:gpt-5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })) {
        void _
      }
    }).rejects.toThrow(/finish_reason: error/)
  })

  it('merges adjacent text/thinking deltas into full parts on serialize', () => {
    const d = driver()
    const record = d.serializeAssistantMessage({
      id: 'a1',
      createdAt: 't',
      parts: [
        { driverId: 'openai', type: 'text', text: 'Deep' },
        { driverId: 'openai', type: 'text', text: '/Se' },
        { driverId: 'openai', type: 'openai.thinking', text: '先' },
        { driverId: 'openai', type: 'openai.thinking', text: '思考' },
        { driverId: 'openai', type: 'openai.tool-call', toolCallId: 'tc-1', name: 'x', input: {} },
        { driverId: 'openai', type: 'text', text: '后续文本' }
      ]
    })
    const parts = d.deserializeMessage(record).parts
    expect(parts.map((p) => p.type)).toEqual(['text', 'openai.thinking', 'openai.tool-call', 'text'])
    expect(parts[0]?.type === 'text' ? parts[0].text : '').toBe('Deep/Se')
    expect(parts[1]?.type === 'openai.thinking' ? parts[1].text : '').toBe('先思考')
    // 工具调用打断的相邻 text 不跨段合并
    expect(parts[3]?.type === 'text' ? parts[3].text : '').toBe('后续文本')
  })

  it('emits openai.tool-call when streamText reports a tool-call chunk', async () => {
    aiMock.__pushStreamScript({
      chunks: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'createJiraIssue', input: { projectKey: 'BSADAPT' } }]
    })
    const events = await collect(
      driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } }).streamChat({
        conversationId: 'c',
        model: 'openai:default',
        history: [],
        userInput: { id: 'u1', text: 'create', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    const parts = events.flatMap((e) => (e.type === 'part' ? [e.part] : []))
    const toolCallPart = parts.find((p) => p.type === 'openai.tool-call')
    expect(toolCallPart).toBeDefined()
    if (toolCallPart?.type === 'openai.tool-call') {
      expect(toolCallPart.name).toBe('createJiraIssue')
      expect(toolCallPart.toolCallId).toBe('tc-1')
    }
  })

  it('emits openai.tool-result and a task-created chunk when tool source describes the output', async () => {
    aiMock.__pushStreamScript({
      chunks: [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'createJiraIssue', input: { projectKey: 'BSADAPT' } },
        { type: 'tool-result', toolCallId: 'tc-1', output: { key: 'BSADAPT-99' } }
      ]
    })
    const events = await collect(
      driver({
        profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' }
      }).streamChat({
        conversationId: 'c',
        model: 'openai:default',
        history: [],
        userInput: { id: 'u1', text: 'create', createdAt: new Date().toISOString() },
        signal: new AbortController().signal,
        toolSource: {
          id: 'jira',
          displayName: 'Jira',
          systemPrompt: () => '',
          tools: () => [],
          describeResult: (output: unknown) => {
            if (output && typeof output === 'object' && 'key' in (output as Record<string, unknown>)) {
              const o = output as { key: string }
              return {
                backend: 'jira',
                externalKey: o.key,
                summary: 'from tool',
                projectKey: 'BSADAPT',
                issueType: '任务'
              }
            }
            return undefined
          },
          close: () => undefined
        }
      })
    )
    const parts = events.flatMap((e) => (e.type === 'part' ? [e.part] : []))
    expect(parts.some((p) => p.type === 'openai.tool-call')).toBe(true)
    expect(parts.some((p) => p.type === 'openai.tool-result')).toBe(true)
    const taskCreated = events.find((e) => e.type === 'task-created')
    expect(taskCreated?.type).toBe('task-created')
    if (taskCreated?.type === 'task-created') {
      expect(taskCreated.result.externalKey).toBe('BSADAPT-99')
    }
  })

  it('moves system content from history and cwd into the system option (ai-sdk 7 requirement)', async () => {
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    const d = driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } })
    // 用 deserializeMessage 构造历史消息（与 ChatService 注入 memoryContext 后的真实路径一致）
    const systemHistory = d.deserializeMessage({
      id: 's1',
      role: 'system',
      createdAt: 't',
      driverId: 'openai',
      raw: { kind: 'system', text: '记忆上下文: 用户偏好简洁回答' }
    })
    const userHistory = d.deserializeMessage({
      id: 'u0',
      role: 'user',
      createdAt: 't',
      driverId: 'openai',
      raw: { kind: 'user', text: '上一轮问题' }
    })
    await collect(
      d.streamChat({
        conversationId: 'c',
        model: 'openai:default',
        history: [systemHistory, userHistory],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal,
        cwd: '/Users/robin/proj'
      })
    )
    const opts = aiMock.__streamCalls.at(-1)!
    // messages 里不允许 system 角色,全部收敛到 system 选项
    expect(opts.messages.map((m) => m.role)).toEqual(['user', 'user'])
    expect(opts.system).toContain('当前工作目录: /Users/robin/proj')
    expect(opts.system).toContain('记忆上下文: 用户偏好简洁回答')
  })

  it('merges task source system prompt into the system option', async () => {
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    await collect(
      driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } }).streamChat({
        conversationId: 'c',
        model: 'openai:default',
        history: [],
        userInput: { id: 'u1', text: 'create', createdAt: new Date().toISOString() },
        signal: new AbortController().signal,
        toolSource: {
          id: 'jira',
          displayName: 'Jira',
          systemPrompt: () => '你是 Jira 创建 Agent',
          tools: () => [],
          describeResult: () => undefined,
          close: () => undefined
        }
      })
    )
    const opts = aiMock.__streamCalls.at(-1)!
    expect(opts.system).toContain('你是 Jira 创建 Agent')
    expect(opts.messages.some((m) => m.role === 'system')).toBe(false)
  })

  it('returns no model when profile is missing', async () => {
    const d = driver()
    expect(await d.listModels()).toEqual([])
  })

  it('returns the configured model when profile is set', async () => {
    const models = await driver({
      profile: { baseUrl: 'https://api.example.com', model: 'gpt-5', displayName: 'GPT-5' }
    }).listModels()
    // value 携带真实模型名（`openai:<model>`），displayName 保持用户配置的展示名
    expect(models).toEqual([{ value: 'openai:gpt-5', displayName: 'GPT-5', isDefault: true }])
  })

  it('lists every configured profile as a model, marking the default one', async () => {
    const models = await driverWithProfiles({
      profiles: [
        {
          id: 'p1',
          baseUrl: 'https://a.example.com',
          model: 'DeepSeek-V4-Flash',
          displayName: 'HammerCloud',
          isDefault: true
        },
        { id: 'p2', baseUrl: 'https://b.example.com', model: 'gpt-4o', displayName: '公司网关' }
      ]
    }).listModels()
    expect(models).toEqual([
      { value: 'openai:DeepSeek-V4-Flash', displayName: 'HammerCloud', isDefault: true },
      { value: 'openai:gpt-4o', displayName: '公司网关', isDefault: false }
    ])
  })

  it('disambiguates duplicate model names across profiles with @id suffix', async () => {
    const models = await driverWithProfiles({
      profiles: [
        { id: 'p1', baseUrl: 'https://a.example.com', model: 'gpt-4o', isDefault: true },
        { id: 'p2', baseUrl: 'https://b.example.com', model: 'gpt-4o' }
      ]
    }).listModels()
    expect(models.map((m) => m.value).sort()).toEqual(['openai:gpt-4o@p1', 'openai:gpt-4o@p2'])
    expect(models.find((m) => m.value === 'openai:gpt-4o@p1')?.isDefault).toBe(true)
  })

  it('streams with the profile selected by @id and passes its api key', async () => {
    resetCalledModels()
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    const apiKeys: Array<string | undefined> = []
    const d = driverWithProfiles({
      profiles: [
        { id: 'p1', baseUrl: 'https://a.example.com', model: 'gpt-4o', isDefault: true },
        { id: 'p2', baseUrl: 'https://b.example.com', model: 'gpt-4o' }
      ],
      apiKeyFor: (profile) => {
        apiKeys.push(profile?.id)
        return 'key'
      }
    })
    await collect(
      d.streamChat({
        conversationId: 'c',
        model: 'openai:gpt-4o@p2',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(vendorCalls).toEqual([{ vendor: 'openai-compatible', model: 'gpt-4o' }])
    expect(apiKeys).toEqual(['p2'])
  })

  it('throws when streamChat is called without a profile', async () => {
    await expect(async () => {
      for await (const _ of driver().streamChat({
        conversationId: 'c',
        model: 'openai:default',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })) {
        void _
      }
    }).rejects.toThrow(/未配置/)
  })

  it('rejects a non-openai model value', async () => {
    await expect(async () => {
      for await (const _ of driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } }).streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })) {
        void _
      }
    }).rejects.toThrow(/未知的 OpenAI 模型/)
  })

  it('routes official DeepSeek baseUrl to @ai-sdk/deepseek', async () => {
    resetCalledModels()
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    await collect(
      driverWithProfiles({
        profiles: [{ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', isDefault: true }]
      }).streamChat({
        conversationId: 'c',
        model: 'openai:deepseek-chat',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(vendorCalls).toEqual([{ vendor: 'deepseek', model: 'deepseek-chat' }])
  })

  it('routes official OpenAI baseUrl to @ai-sdk/openai', async () => {
    resetCalledModels()
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    await collect(
      driverWithProfiles({
        profiles: [{ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', isDefault: true }]
      }).streamChat({
        conversationId: 'c',
        model: 'openai:gpt-5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(vendorCalls).toEqual([{ vendor: 'openai', model: 'gpt-5' }])
  })

  it('honors explicit vendor over baseUrl detection', async () => {
    // 第三方网关 baseUrl + 显式 vendor=deepseek → 仍走 @ai-sdk/deepseek（用户确认网关兼容官方协议）
    resetCalledModels()
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    await collect(
      driverWithProfiles({
        profiles: [
          { baseUrl: 'https://gateway.example.com/v1', vendor: 'deepseek', model: 'deepseek-chat', isDefault: true }
        ]
      }).streamChat({
        conversationId: 'c',
        model: 'openai:deepseek-chat',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(vendorCalls).toEqual([{ vendor: 'deepseek', model: 'deepseek-chat' }])
  })

  it('forces openai-compatible factory when vendor is explicit even on official baseUrl', async () => {
    resetCalledModels()
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    await collect(
      driverWithProfiles({
        profiles: [
          { baseUrl: 'https://api.deepseek.com', vendor: 'openai-compatible', model: 'deepseek-chat', isDefault: true }
        ]
      }).streamChat({
        conversationId: 'c',
        model: 'openai:deepseek-chat',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(vendorCalls).toEqual([{ vendor: 'openai-compatible', model: 'deepseek-chat' }])
  })

  it('deserializeMessage returns text parts for user/system and pass-through parts for assistant', () => {
    const d = driver()
    const userMsg = d.deserializeMessage({
      id: 'u1',
      role: 'user',
      createdAt: 't',
      driverId: 'openai',
      raw: { kind: 'user', text: 'hi' }
    })
    expect(userMsg.parts[0]?.type).toBe('text')
    if (userMsg.parts[0]?.type === 'text') {
      expect(userMsg.parts[0].text).toBe('hi')
    }

    const assistantMsg = d.deserializeMessage({
      id: 'a1',
      role: 'assistant',
      createdAt: 't',
      driverId: 'openai',
      raw: { kind: 'assistant', parts: [{ driverId: 'openai', type: 'text', text: 'hi' }] }
    })
    expect(assistantMsg.parts[0]?.type).toBe('text')
  })
})
