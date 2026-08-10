import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task, TaskRepository, TaskStore } from '@task-pipeline/core'
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
  const scripts: Array<{ messages: SdkMessage[]; throwAfter?: number; throwWith?: unknown; cursor: number }> = []
  const scriptWaiters: Array<() => void> = []
  const queryCalls: unknown[] = []
  const userMessages: string[] = []
  let generation = 0
  const wake = () => {
    for (const w of scriptWaiters.splice(0)) w()
  }
  return {
    accessToken: (token: string) => ({ token }),
    query: (args: unknown) => {
      queryCalls.push(args)
      // closed 按 query 实例隔离:一次 close 只结束自己的会话,不影响新会话。
      let queryClosed = false
      const { prompt } = (args ?? {}) as { prompt?: unknown }
      // 消费输入流:记录每个回合的用户消息文本(现在用户输入走异步消息流,不再拼接进 query.prompt)。
      if (prompt && typeof (prompt as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
        void (async () => {
          try {
            for await (const m of prompt as AsyncIterable<{ message?: { content?: Array<{ type?: string; text?: string }> } }>) {
              const text = (m.message?.content ?? [])
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join('')
              if (text) userMessages.push(text)
            }
          } catch {
            /* input stream closed */
          }
        })()
      }
      return {
        [Symbol.asyncIterator]() {
          const myGen = generation
          return {
            async next() {
              while (true) {
                // 旧测试残留的 consume 直接退出,不能抢新测试的脚本。
                if (myGen !== generation || queryClosed) return { value: undefined as unknown as SdkMessage, done: true }
                const script = scripts[0]
                // throw 脚本:在消费任意消息之前按 throwAfter 触发(可对空脚本用)。
                if (
                  script &&
                  script.throwAfter !== undefined &&
                  script.throwWith !== undefined &&
                  script.cursor >= script.throwAfter
                ) {
                  script.cursor++
                  throw script.throwWith
                }
                if (script && script.cursor < script.messages.length) {
                  return { value: script.messages[script.cursor++] as SdkMessage, done: false }
                }
                // 当前脚本耗尽:换下一个(若有);否则挂起等待新脚本 / close。
                if (scripts.length > 1) {
                  scripts.shift()
                  continue
                }
                await new Promise<void>((resolve) => scriptWaiters.push(resolve))
              }
            },
            async return() {
              queryClosed = true
              wake()
              return { value: undefined as unknown as SdkMessage, done: true }
            },
            async throw(error: unknown) {
              throw error
            }
          }
        },
        async close() {
          queryClosed = true
          wake()
        },
        async interrupt() {
          /* noop */
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
    __pushQueryScript: (s: { messages: SdkMessage[]; throwAfter?: number; throwWith?: unknown }) => {
      scripts.push({ ...s, cursor: 0 })
      wake()
    },
    __queryCalls: queryCalls,
    __getUserMessages: () => [...userMessages],
    __resetMock: () => {
      queryCalls.length = 0
      scripts.length = 0
      userMessages.length = 0
      generation++
      wake()
    }
  }
})

// 必须在 vi.mock 之后 import driver
const { QoderTaskAgentDriver, stripQoderModelPrefix } = await import('./qoder-task-agent.js')
const sdkMock = (await import('@qoder-ai/qoder-agent-sdk')) as unknown as {
  __pushQueryScript: (s: { messages: SdkMessage[]; throwAfter?: number; throwWith?: unknown }) => void
  __queryCalls: unknown[]
  __getUserMessages: () => string[]
  __resetMock: () => void
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

function fakeTask(overrides: Partial<Task> = {}): Task {
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
    updatedAt: new Date().toISOString(),
    ...overrides
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
    savedLog = process.env.TASK_PIPELINE_QODER_LOG
    delete process.env.TASK_PIPELINE_QODER_LOG
    sdkMock.__resetMock()
  })

  afterEach(() => {
    if (savedLog === undefined) delete process.env.TASK_PIPELINE_QODER_LOG
    else process.env.TASK_PIPELINE_QODER_LOG = savedLog
  })

  it('emits agent_start/agent_end and merges text deltas into paragraph-level agent_text', async () => {
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('Hello', 'sess-1'), assistantMsg('World', 'sess-1'), resultMsg('Final', 'sess-1')]
    })
    const { driver: d, events } = driver()
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('agent_start')
    expect(types[types.length - 1]).toBe('agent_end')
    const textEvents = events.filter((e) => e.type === 'agent_text')
    // 连续文本(无工具调用/无空行边界)在回合结束时合并成一段,不再每条 delta 一条碎片。
    expect(textEvents.length).toBe(1)
    expect(textEvents[0]?.text).toContain('Hello')
    expect(textEvents[0]?.text).toContain('World')
    expect(textEvents[0]?.text).toContain('Final')
    const result = d.collectResult('task-1', 'plan')
    expect(result.responseTexts).toContain('Hello')
    expect(result.responseTexts).toContain('World')
    expect(result.sessionId).toBe('sess-1')
  })

  it('flushes agent_text at markdown paragraph boundaries and tool calls', async () => {
    sdkMock.__pushQueryScript({
      messages: [
        assistantMsg('第一段正文', 'sess-1'),
        assistantMsg('\n\n第二段正文', 'sess-1'),
        assistantMsg(' 后跟工具调用', 'sess-1'),
        resultMsg('完毕', 'sess-1')
      ]
    })
    const { driver: d, events } = driver()
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    const textEvents = events.filter((e) => e.type === 'agent_text')
    // 空行 → 段落边界:至少两段(第一段 + 剩余部分);不会出现逐 delta 的碎片。
    expect(textEvents.length).toBeGreaterThanOrEqual(2)
    for (const event of textEvents) {
      expect(String(event.text ?? '')).not.toBe('')
    }
  })

  it('runImplementation collects responseTexts and forwards sessionId', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('Implementing', 'impl-sess'), resultMsg('Done', 'impl-sess')] })
    const { driver: d } = driver()
    await d.runImplementation({ task: fakeTask(), repos: fakeRepos() })
    const result = d.collectResult('task-1', 'implementation')
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
    const result = d.collectResult('task-1', 'implementation')
    expect(result.sessionId).toBe('resume-sess')
    expect(result.responseTexts).toContain('Resumed')
  })

  it('reuses the resident session across plan/implementation (三阶段共享会话)', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('plan output', 'sess-1'), resultMsg('{}', 'sess-1')] })
    const { driver: d } = driver()
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    // implementation 复用 plan 会话:query 只创建一次(上下文由 Qoder 会话端管理,不重建)。
    sdkMock.__pushQueryScript({ messages: [resultMsg('implemented', 'sess-1')] })
    await d.runImplementation({ task: fakeTask(), repos: fakeRepos() })
    expect(sdkMock.__queryCalls.length).toBe(1)
    const implResult = d.collectResult('task-1', 'implementation')
    expect(implResult.responseTexts.some((t) => t.includes('implemented'))).toBe(true)
    expect(implResult.sessionId).toBe('sess-1')
  })

  it('closeSession releases the resident session and clears phase buffers', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('plan output', 'sess-1'), resultMsg('{}', 'sess-1')] })
    const { driver: d } = driver()
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    expect(d.collectResult('task-1', 'plan').responseTexts.length).toBeGreaterThan(0)
    d.closeSession('task-1')
    // 会话与阶段产物都被释放:collectResult 回退为空。
    expect(d.collectResult('task-1', 'plan').responseTexts).toEqual([])
    // 释放后重新执行会重建全新会话(不残留旧上下文)。
    sdkMock.__pushQueryScript({ messages: [assistantMsg('second plan', 'sess-2'), resultMsg('{}', 'sess-2')] })
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    expect(d.collectResult('task-1', 'plan').responseTexts.some((t) => t.includes('second plan'))).toBe(true)
    // 会话重建:query 新建(sessionId 变化)。
    expect(d.collectResult('task-1', 'plan').sessionId).toBe('sess-2')
  })

  it('reuses the plan session when revising with feedback (revise 追加消息,不走 Qoder Init)', async () => {
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('第一版计划', 'sess-1'), resultMsg('{"outcome":"changes_required","plan":"第一版"}', 'sess-1')]
    })
    const { driver: d } = driver()
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    expect(sdkMock.__queryCalls.length).toBe(1)
    // 计划调整(带 feedback):复用已存在会话,追加"调整意见"消息,不新建 query。
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('第二版计划', 'sess-1'), resultMsg('{"outcome":"changes_required","plan":"第二版"}', 'sess-1')]
    })
    await d.runPlan({ task: fakeTask(), repos: fakeRepos(), feedback: '第二版要更详细' })
    expect(sdkMock.__queryCalls.length).toBe(1)
    const texts = sdkMock.__getUserMessages()
    expect(texts.some((t) => t.includes('调整意见') && t.includes('第二版要更详细'))).toBe(true)
  })

  it('keeps appending to the resident session even without feedback (重新生成也追加消息)', async () => {
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('第一版计划', 'sess-1'), resultMsg('{"outcome":"changes_required","plan":"第一版"}', 'sess-1')]
    })
    const { driver: d } = driver()
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    expect(sdkMock.__queryCalls.length).toBe(1)
    // 无 feedback 的"重新生成"同样复用会话追加消息,不走 Qoder Init。
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('第二版计划', 'sess-1'), resultMsg('{"outcome":"changes_required","plan":"第二版"}', 'sess-1')]
    })
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    expect(sdkMock.__queryCalls.length).toBe(1)
  })

  it('resumes the saved session when no active session exists (应用重启后 resume)', async () => {
    // 无活跃会话,但 task.qoderSessionId 已持久化 → 创建会话时 resume,不丢上下文。
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('恢复后计划', 'saved-sess'), resultMsg('{"outcome":"changes_required","plan":"恢复后"}', 'saved-sess')]
    })
    const { driver: d } = driver()
    await d.runPlan({ task: fakeTask({ qoderSessionId: 'saved-sess' }), repos: fakeRepos() })
    const options = sdkMock.__queryCalls[0] as { options?: { resume?: string } }
    expect(options?.options?.resume).toBe('saved-sess')
  })

  it('emits agent_session with taskId for session persistence', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('计划分析', 'sess-1'), resultMsg('{}', 'sess-1')] })
    const { driver: d, events } = driver()
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    const sessionEvent = events.find((e) => e.type === 'agent_session') as
      | { type: 'agent_session'; taskId?: string; sessionId?: string }
      | undefined
    expect(sessionEvent).toBeDefined()
    expect(sessionEvent?.taskId).toBe('task-1')
    expect(sessionEvent?.sessionId).toBe('sess-1')
  })

  it('runTestGeneration collects test response texts', async () => {
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('{"files":["a_test.ts"]}', 'test-sess'), resultMsg('Done', 'test-sess')]
    })
    const { driver: d } = driver()
    await d.runTestGeneration({ task: fakeTask(), repos: fakeRepos() })
    const result = d.collectResult('task-1', 'test')
    expect(result.responseTexts.some((t) => t.includes('a_test.ts'))).toBe(true)
    expect(result.sessionId).toBe('test-sess')
  })

  it('runPlan prepends agent context sections to the prompt', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('分析中', 'p-sess'), resultMsg('{}', 'p-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo（repo）\n遵循项目约定'] })
    })
    await d.runPlan({ task: fakeTask(), repos: fakeRepos() })
    // 用户输入走异步消息流:首回合消息应包含注入的 Agent 指引。
    const texts = sdkMock.__getUserMessages()
    expect(texts[0]).toContain('## Agent 指引 — 仓库 repo')
    expect(texts[0]).toContain('遵循项目约定')
  })

  it('runImplementation prepends agent context sections to the prompt', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('Done', 'i-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo\n遵循项目约定'] })
    })
    await d.runImplementation({ task: fakeTask(), repos: fakeRepos() })
    const texts = sdkMock.__getUserMessages()
    expect(texts[0]).toContain('## Agent 指引')
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
    const texts = sdkMock.__getUserMessages()
    expect(texts[0]).not.toContain('## Agent 指引')
    expect(texts[0]).toContain('继续完成')
  })

  it('runTestGeneration prepends agent context sections to the prompt', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('{"files":[]}', 't-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo\n遵循项目约定'] })
    })
    await d.runTestGeneration({ task: fakeTask(), repos: fakeRepos() })
    const texts = sdkMock.__getUserMessages()
    expect(texts[0]).toContain('## Agent 指引')
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
    const result = d.collectResult('task-1', 'invalid-phase' as never)
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
    const { driver: d, events } = driver()
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
    // 失败路径也必须配对收尾:agent_start 之后必有 agent_end(agent_session 无 sessionId 可不发)。
    expect(events.some((e) => e.type === 'agent_start')).toBe(true)
    expect(events.some((e) => e.type === 'agent_end')).toBe(true)
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
