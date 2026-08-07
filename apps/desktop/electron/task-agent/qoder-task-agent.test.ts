import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task, TaskRepository, TaskStore } from '@coding-agent/core'
import type { SDKMessage } from '@qoder-ai/qoder-agent-sdk'

/**
 * 假 SDK:用 `vi.mock` 替换 `@qoder-ai/qoder-agent-sdk`,让 `query()` 返回一个可脚本化的
 * AsyncIterable。测试通过 __pushQueryScript 推入一段 SDKMessage 序列,精确驱动 driver。
 */
type SdkMessage = Record<string, unknown> & {
  type?: string
  session_id?: string
  message?: {
    content?: Array<{ type: string; text?: string }>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  result?: unknown
  duration_ms?: number
  num_turns?: number
  total_cost_usd?: number
  modelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      costUSD: number
    }
  >
}

vi.mock('@qoder-ai/qoder-agent-sdk', () => {
  const scripts: { messages: SdkMessage[]; throwAfter?: number; throwWith?: unknown }[] = []
  const queryCalls: unknown[] = []
  return {
    accessToken: (token: string) => ({ token }),
    query: (options: unknown) => {
      queryCalls.push(options)
      const script = scripts.shift() ?? { messages: [] }
      return {
        [Symbol.asyncIterator]() {
          let index = 0
          return {
            async next() {
              if (script.throwAfter !== undefined && index >= script.throwAfter) {
                if (script.throwWith) throw script.throwWith
              }
              if (index < script.messages.length) return { value: script.messages[index++] as SdkMessage, done: false }
              return { value: undefined as unknown as SdkMessage, done: true }
            },
            async return() {
              return { value: undefined as unknown as SdkMessage, done: true }
            },
            async throw(error: unknown) {
              throw error
            },
            async close() {
              /* noop */
            },
            async interrupt() {
              /* noop */
            }
          }
        }
      }
    },
    QoderCliProcessError: class QoderCliProcessError extends Error {
      readonly code = 'QODER_CLI_PROCESS_ERROR' as const
      readonly exitCode: number | null
      readonly signal: NodeJS.Signals | null
      readonly stderr: string
      constructor(
        message: string,
        options?: { exitCode?: number | null; signal?: NodeJS.Signals | null; stderr?: string }
      ) {
        super(message)
        this.exitCode = options?.exitCode ?? null
        this.signal = options?.signal ?? null
        this.stderr = options?.stderr ?? ''
        this.name = 'QoderCliProcessError'
      }
    },
    __pushQueryScript: (s: { messages: SdkMessage[]; throwAfter?: number; throwWith?: unknown }) => scripts.push(s),
    __queryCalls: queryCalls
  }
})

// 必须在 vi.mock 之后 import driver
const { QoderTaskAgentDriver, stripQoderModelPrefix } = await import('./qoder-task-agent.js')
const sdkMock = (await import('@qoder-ai/qoder-agent-sdk')) as unknown as {
  __pushQueryScript: (s: { messages: SdkMessage[]; throwAfter?: number; throwWith?: unknown }) => void
  __queryCalls: unknown[]
}

function assistantMsg(text: string, sessionId?: string): SdkMessage {
  return { type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text }] } }
}

function resultMsg(result: string, sessionId?: string): SdkMessage {
  return { type: 'result', session_id: sessionId, result }
}

function fakeStore(): TaskStore {
  return {
    getTask: () => undefined,
    updateTask: () => undefined,
    addEvent: () => undefined,
    getSetting: () => undefined,
    setSetting: () => undefined
  } as unknown as TaskStore
}

function fakeTask(): Task {
  return {
    id: 'task-1',
    source: 'local',
    title: 'Test',
    description: 'Description',
    keywords: [],
    acceptanceCriteria: ['AC1'],
    state: 'draft',
    reviewStatus: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

function fakeRepos(): TaskRepository[] {
  return [
    {
      id: 'repo-1',
      taskId: 'task-1',
      repositoryId: 'r1',
      name: 'repo',
      localPath: '/tmp/repo',
      baseBranch: 'main',
      deliveryStatus: 'pending'
    }
  ]
}

type CapturedEvent = { type: string; [key: string]: unknown }

function driver(extra: Partial<ConstructorParameters<typeof QoderTaskAgentDriver>[0]> = {}) {
  const events: CapturedEvent[] = []
  const addTaskEvent = () => undefined
  const emitPi = (_e: { type: 'qoder_event'; taskId: string; message: SDKMessage }) => undefined
  const d = new QoderTaskAgentDriver({
    store: fakeStore(),
    qoderTokenProvider: () => 'test-token',
    dataDir: tmpdir(),
    addTaskEvent,
    emitPi,
    emit: (e) => events.push(e as CapturedEvent),
    ...extra
  })
  return { driver: d, events }
}

describe('QoderTaskAgentDriver', () => {
  let savedLog: string | undefined

  beforeEach(() => {
    savedLog = process.env.CODING_AGENT_QODER_LOG
    delete process.env.CODING_AGENT_QODER_LOG
    sdkMock.__queryCalls.length = 0
  })

  afterEach(() => {
    if (savedLog === undefined) delete process.env.CODING_AGENT_QODER_LOG
    else process.env.CODING_AGENT_QODER_LOG = savedLog
  })

  it('emits agent_start/agent_end and a single agent_text per assistant message', async () => {
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('Hello', 'sess-1'), assistantMsg('World', 'sess-1'), resultMsg('Final', 'sess-1')]
    })
    const { driver: d, events } = driver()
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('agent_start')
    expect(types[types.length - 1]).toBe('agent_end')
    const textEvents = events.filter((e) => e.type === 'agent_text')
    expect(textEvents.length).toBeGreaterThanOrEqual(2)
    const result = d.collectResult('plan')
    expect(result.responseTexts).toContain('Hello')
    expect(result.responseTexts).toContain('World')
    expect(result.sessionId).toBe('sess-1')
  })

  it('runImplementation collects responseTexts and forwards sessionId', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('Implementing', 'impl-sess'), resultMsg('Done', 'impl-sess')] })
    const { driver: d } = driver()
    await d.runImplementation({ task: fakeTask(), repos: fakeRepos() })
    const result = d.collectResult('implementation')
    expect(result.responseTexts).toContain('Implementing')
    expect(result.sessionId).toBe('impl-sess')
  })

  it('runImplementation with resumeSessionId threads session through', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('Resumed', 'resume-sess')] })
    const { driver: d } = driver()
    await d.runImplementation({
      task: fakeTask(),
      repos: fakeRepos(),
      resumeSessionId: 'resume-sess',
      extraPrompt: '继续'
    })
    const result = d.collectResult('implementation')
    expect(result.sessionId).toBe('resume-sess')
    expect(result.responseTexts).toContain('Resumed')
  })

  it('runTestGeneration collects test response texts', async () => {
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('{"files":["a_test.ts"]}', 'test-sess'), resultMsg('Done', 'test-sess')]
    })
    const { driver: d } = driver()
    await d.runTestGeneration({ task: fakeTask(), repos: fakeRepos() })
    const result = d.collectResult('test')
    expect(result.responseTexts.some((t) => t.includes('a_test.ts'))).toBe(true)
    expect(result.sessionId).toBe('test-sess')
  })

  it('runPlan prepends agent context sections to the prompt', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('分析中', 'p-sess'), resultMsg('{}', 'p-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo（repo）\n遵循项目约定'] })
    })
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    const prompt = String((sdkMock.__queryCalls[0] as { prompt?: unknown } | undefined)?.prompt ?? '')
    expect(prompt).toContain('## Agent 指引 — 仓库 repo')
    expect(prompt).toContain('遵循项目约定')
  })

  it('runImplementation prepends agent context sections to the prompt', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('Done', 'i-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo\n遵循项目约定'] })
    })
    await d.runImplementation({ task: fakeTask(), repos: fakeRepos() })
    const prompt = String((sdkMock.__queryCalls[0] as { prompt?: unknown } | undefined)?.prompt ?? '')
    expect(prompt).toContain('## Agent 指引')
  })

  it('runImplementation with resumeSessionId skips agent context re-injection', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('Resumed', 'r-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo\n遵循项目约定'] })
    })
    await d.runImplementation({
      task: fakeTask(),
      repos: fakeRepos(),
      resumeSessionId: 'r-sess',
      extraPrompt: '继续完成'
    })
    const prompt = String((sdkMock.__queryCalls[0] as { prompt?: unknown } | undefined)?.prompt ?? '')
    expect(prompt).not.toContain('## Agent 指引')
    expect(prompt).toContain('继续完成')
  })

  it('runTestGeneration prepends agent context sections to the prompt', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('{"files":[]}', 't-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo\n遵循项目约定'] })
    })
    await d.runTestGeneration({ task: fakeTask(), repos: fakeRepos() })
    const prompt = String((sdkMock.__queryCalls[0] as { prompt?: unknown } | undefined)?.prompt ?? '')
    expect(prompt).toContain('## Agent 指引')
  })

  it('forwards resolveModel result as the query model', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('Done', 'm-sess')] })
    const { driver: d } = driver({
      resolveModel: () => 'claude-sonnet-4.5'
    })
    await d.runImplementation({ task: fakeTask(), repos: fakeRepos() })
    expect((sdkMock.__queryCalls[0] as { options?: { model?: unknown } } | undefined)?.options?.model).toBe(
      'claude-sonnet-4.5'
    )
  })

  it('throws when no token is configured', async () => {
    const d = new QoderTaskAgentDriver({
      store: fakeStore(),
      qoderTokenProvider: () => undefined,
      dataDir: tmpdir(),
      addTaskEvent: () => undefined,
      emitPi: () => undefined,
      emit: () => undefined
    })
    await expect(d.runPlan({ task: fakeTask(), repos: fakeRepos() })).rejects.toThrow(/Qoder Token/)
  })

  it('throws when no repositories are associated with the task', async () => {
    const { driver: d } = driver()
    await expect(d.runPlan({ task: fakeTask(), repos: [] })).rejects.toThrow(/未关联代码仓库/)
  })

  it('rejects an unknown collectResult phase gracefully (returns empty)', () => {
    const { driver: d } = driver()
    // @ts-expect-error 故意传入错误 phase 验证 driver 不抛
    const result = d.collectResult('invalid-phase')
    expect(result.responseTexts).toEqual([])
  })

  it('runPlan 阶段 SDK 抛 QoderCliProcessError(exit 42) 时,把 stderr 拼到错误 message 一起上抛', async () => {
    // mock 的 query iterator 第二次 next 时模拟 qodercli 进程非 0 退出
    const stderrTail = 'Error: plan mode not allowed for this model\n  at /qoder/cli/index.js:1:1\n'
    const { QoderCliProcessError: QPE } = await import('@qoder-ai/qoder-agent-sdk')
    const sdkError = new QPE('Qoder CLI process exited with code 42', {
      exitCode: 42,
      signal: null,
      stderr: stderrTail
    })
    sdkMock.__pushQueryScript({ messages: [], throwAfter: 0, throwWith: sdkError })
    const { driver: d } = driver()
    let caught: Error | undefined
    try {
      await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toContain('Qoder CLI process exited with code 42')
    expect(caught!.message).toContain('plan mode not allowed for this model')
    // 保留 cause 链,方便上层 instanceof QoderCliProcessError 仍然命中
    expect((caught as Error & { cause?: unknown }).cause).toBe(sdkError)
  })

  it('runPlan 阶段 SDK 抛非 QoderCliProcessError 时,原样上抛不附加 stderr', async () => {
    const plainError = new Error('boom')
    sdkMock.__pushQueryScript({ messages: [], throwAfter: 0, throwWith: plainError })
    const { driver: d } = driver()
    let caught: Error | undefined
    try {
      await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBe(plainError)
  })

  describe('stripQoderModelPrefix', () => {
    it('去掉 model value 上的 qoder: 前缀', () => {
      expect(stripQoderModelPrefix('qoder:claude-sonnet-4.5')).toBe('claude-sonnet-4.5')
    })

    it('没有前缀时原样返回', () => {
      expect(stripQoderModelPrefix('claude-sonnet-4.5')).toBe('claude-sonnet-4.5')
    })

    it('undefined 返回 undefined（让 qodercli 走 auto）', () => {
      expect(stripQoderModelPrefix(undefined)).toBeUndefined()
    })
  })

  it('resolveModel 返回 qoder: 前缀的 model 时,SDK 收到的是剥掉前缀的短名', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('Done', 'mp-sess')] })
    const { driver: d } = driver({
      resolveModel: () => 'qoder:claude-sonnet-4.5'
    })
    await d.runImplementation({ task: fakeTask(), repos: fakeRepos() })
    const options = (sdkMock.__queryCalls[0] as { options?: { model?: unknown } } | undefined)?.options
    expect(options?.model).toBe('claude-sonnet-4.5')
  })
})
