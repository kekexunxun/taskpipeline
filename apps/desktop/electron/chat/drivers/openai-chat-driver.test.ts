import { describe, expect, it, vi } from 'vitest'
import type { TaskStore } from '@task-pipeline/core'
import type { TracePipeline } from '../../trace/bus/trace-pipeline'

/**
 * 假 ai-sdk streamText:用 `vi.mock` 替换 `ai`,把 `streamText().fullStream` 接到一个可脚本化的
 * AsyncIterable,让测试可以精确驱动 streamText 的 chunk 序列。
 */
type StreamChunk = { type: string; [key: string]: unknown }

type StreamTextOptions = {
  messages: Array<{ role: string }>
  system?: string
  providerOptions?: Record<string, Record<string, unknown>>
}

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
    capabilities?: string[]
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
      capabilities?: string[]
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

  it('falls back to the default profile when the model value is unknown', async () => {
    // 失效 value（如其它 driver 的值 / 已删除的 profile）不再抛错，回落默认 profile 的模型。
    resetCalledModels()
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    await collect(
      driver({ profile: { baseUrl: 'https://api.example.com', model: 'gpt-5' } }).streamChat({
        conversationId: 'c',
        model: 'qoder:claude-sonnet-4.5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(vendorCalls).toEqual([{ vendor: 'openai-compatible', model: 'gpt-5' }])
  })

  it('listModels declares capabilities by vendor and honors explicit override', async () => {
    const models = await driverWithProfiles({
      profiles: [
        { id: 'ds', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
        { id: 'oai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
        { id: 'compat', baseUrl: 'https://api.example.com', model: 'glm-4' },
        { id: 'manual', baseUrl: 'https://api.example.com', model: 'kimi', capabilities: ['maxOutputTokens'] }
      ]
    }).listModels()
    const byValue = new Map(models.map((m) => [m.value, m]))
    // deepseek：自动推断推理力度 + 思考开关
    expect(byValue.get('openai:deepseek-chat')?.capabilities).toEqual([
      { key: 'reasoningEffort', kind: 'enum', options: ['low', 'medium', 'high'] },
      { key: 'thinking', kind: 'toggle' }
    ])
    // openai 官方：自动推断推理力度 + 最大输出 Token
    expect(byValue.get('openai:gpt-5')?.capabilities).toEqual([
      { key: 'reasoningEffort', kind: 'enum', options: ['low', 'medium', 'high'] },
      { key: 'maxOutputTokens', kind: 'number' }
    ])
    // 兼容端点：不声明任何能力（避免假开关）
    expect(byValue.get('openai:glm-4')?.capabilities).toBeUndefined()
    // 显式配置覆盖自动推断
    expect(byValue.get('openai:kimi')?.capabilities).toEqual([{ key: 'maxOutputTokens', kind: 'number' }])
  })

  it('passes modelParams as vendor-scoped providerOptions to streamText', async () => {
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    await collect(
      driverWithProfiles({
        profiles: [{ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', isDefault: true }]
      }).streamChat({
        conversationId: 'c',
        model: 'openai:gpt-5',
        modelParams: { reasoningEffort: 'high', maxOutputTokens: 4096 },
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(aiMock.__streamCalls.at(-1)?.providerOptions).toEqual({
      openai: { reasoningEffort: 'high', maxCompletionTokens: 4096 }
    })
  })

  it('maps thinking toggle to deepseek providerOptions', async () => {
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    await collect(
      driverWithProfiles({
        profiles: [{ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', isDefault: true }]
      }).streamChat({
        conversationId: 'c',
        model: 'openai:deepseek-chat',
        modelParams: { reasoningEffort: 'low', thinking: true },
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(aiMock.__streamCalls.at(-1)?.providerOptions).toEqual({
      deepseek: { reasoningEffort: 'low', thinking: { type: 'enabled' } }
    })
  })

  it('omits providerOptions for openai-compatible endpoints', async () => {
    aiMock.__pushStreamScript({ chunks: [{ type: 'text-delta', text: 'hi' }] })
    await collect(
      driverWithProfiles({
        profiles: [{ baseUrl: 'https://api.example.com', model: 'glm-4', isDefault: true }]
      }).streamChat({
        conversationId: 'c',
        model: 'openai:glm-4',
        modelParams: { reasoningEffort: 'high' },
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )
    expect(aiMock.__streamCalls.at(-1)?.providerOptions).toBeUndefined()
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

  it('trace：llm span 按 step 边界切分，同批工具显式平级挂当前 step（不互嵌）', async () => {
    // 记录 pipeline 调用的最小替身：startSpan 返内存 span（status: 'started' 供 finally 兜底判断）。
    const started: Array<{
      spanId: string
      type: string
      name?: string
      parentSpanId?: string
      stepIndex?: unknown
      traceLabel?: unknown
      hasInput: boolean
    }> = []
    const ended: Array<{ spanId: string; patch: { status?: string; usage?: { inputTokens?: number } } }> = []
    let seq = 0
    let endTraceCount = 0
    const pipeline = {
      beginTrace: () => undefined,
      ensureActive: () => undefined,
      startSpan: (
        _traceId: string,
        init: { type: string; name?: string; parentSpanId?: string; input?: unknown; meta?: Record<string, unknown> }
      ) => {
        seq += 1
        const span = { spanId: `span-${seq}`, status: 'started' as const, type: init.type }
        started.push({
          spanId: span.spanId,
          type: init.type,
          name: init.name,
          parentSpanId: init.parentSpanId,
          stepIndex: init.meta?.stepIndex,
          traceLabel: init.meta?.traceLabel,
          hasInput: init.input !== undefined
        })
        return span
      },
      endSpan: (
        _traceId: string,
        span: { spanId: string },
        patch: { status?: string; usage?: { inputTokens?: number } }
      ) => {
        ended.push({ spanId: span.spanId, patch })
      },
      endTrace: () => {
        endTraceCount += 1
      }
    } as unknown as TracePipeline

    // 两步工具循环：step0 产出两个并发工具调用，step1 给最终回答；finish chunk 由 mock 自动补齐。
    aiMock.__pushStreamScript({
      chunks: [
        { type: 'start-step' },
        { type: 'text-delta', text: '先查一下' },
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'list_dir', input: { path: '.' } },
        { type: 'tool-call', toolCallId: 'tc-2', toolName: 'grep', input: { pattern: 'foo' } },
        { type: 'tool-result', toolCallId: 'tc-1', output: ['a.ts'] },
        { type: 'tool-result', toolCallId: 'tc-2', output: ['a.ts:1'] },
        { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 5 } },
        { type: 'start-step' },
        { type: 'text-delta', text: '结果如下' },
        { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 8 } }
      ]
    })
    const d = new OpenAIChatDriver(
      fakeStore({ baseUrl: 'https://api.example.com', model: 'gpt-5' }),
      () => 'key',
      pipeline
    )
    await collect(
      d.streamChat({
        conversationId: 'c',
        model: 'openai:gpt-5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })
    )

    const llmSpans = started.filter((s) => s.type === 'llm.generate')
    const toolSpans = started.filter((s) => s.type === 'tool.execute')
    // 每个 step 一个 llm span（不再是一个覆盖全程的巨 span），尾部 finish chunk 不再建 span
    expect(llmSpans).toHaveLength(2)
    expect(llmSpans.map((s) => s.stepIndex)).toEqual([0, 1])
    // 首步记录完整 input；后续步省略（tool-result 回填内容不重复落库）
    expect(llmSpans[0]!.hasInput).toBe(true)
    expect(llmSpans[1]!.hasInput).toBe(false)
    // 同批并发工具显式挂同一 step llm span：平级，不逐个互嵌
    expect(toolSpans).toHaveLength(2)
    expect(toolSpans.map((s) => s.parentSpanId)).toEqual([llmSpans[0]!.spanId, llmSpans[0]!.spanId])
    // usage 取 finish-step 的单步用量，收尾状态 completed
    const llmEnd0 = ended.find((e) => e.spanId === llmSpans[0]!.spanId)
    const llmEnd1 = ended.find((e) => e.spanId === llmSpans[1]!.spanId)
    expect(llmEnd0?.patch.usage?.inputTokens).toBe(10)
    expect(llmEnd0?.patch.status).toBe('completed')
    expect(llmEnd1?.patch.usage?.inputTokens).toBe(20)
    // 非 join 模式：driver 负责 endTrace
    expect(endTraceCount).toBe(1)
  })

  it('trace：traceLabel 语义名写入 llm span 的 name 与 meta.traceLabel', async () => {
    // 最小 pipeline 替身：只关心 startSpan 的 name/meta。
    const started: Array<{ name?: string; traceLabel?: unknown }> = []
    const pipeline = {
      beginTrace: () => undefined,
      startSpan: (_traceId: string, init: { name?: string; meta?: Record<string, unknown> }) => {
        started.push({ name: init.name, traceLabel: init.meta?.traceLabel })
        return { spanId: `span-${started.length}`, status: 'started' as const }
      },
      endSpan: () => undefined,
      endTrace: () => undefined
    } as unknown as TracePipeline

    aiMock.__pushStreamScript({
      chunks: [
        { type: 'start-step' },
        { type: 'text-delta', text: '{"keywords":["a"]}' },
        { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1 } }
      ]
    })
    const d = new OpenAIChatDriver(
      fakeStore({ baseUrl: 'https://api.example.com', model: 'gpt-5' }),
      () => 'key',
      pipeline
    )
    await collect(
      d.streamChat({
        conversationId: 'memory-keyword-extract-x',
        model: 'openai:gpt-5',
        history: [],
        userInput: { id: 'u1', text: 'hi', createdAt: new Date().toISOString() },
        signal: new AbortController().signal,
        traceLabel: '关键词提取'
      })
    )
    const llm = started.find((s) => s.name !== undefined && s.name !== '对话')
    // span.name 与 meta.traceLabel 双写：读时转换按 meta.traceLabel 出标题，缺它会回退成模型名
    expect(llm?.name).toBe('关键词提取')
    expect(llm?.traceLabel).toBe('关键词提取')
  })
})
