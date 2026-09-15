import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task, TaskRepository, TaskStore } from '@task-pipeline/core'
import type { SDKMessage } from '@qoder-ai/qoder-agent-sdk'
import { sha256Hex } from '../../task/stage-artifacts.js'

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
  /** 假会话条目树（`getSessionMessages` 产出）：阶段间 fork 的 anchor 算法读它。 */
  const transcript: Array<{ type: string; uuid: string }> = []
  let generation = 0
  const wake = () => {
    for (const w of scriptWaiters.splice(0)) w()
  }
  return {
    // 会话创建时读它判定 transport（诊断字段）；mock 不补会抛「export is not defined」。
    DEFAULT_RUNTIME_TRANSPORT: 'worker',
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
            for await (const m of prompt as AsyncIterable<{
              message?: { content?: Array<{ type?: string; text?: string }> }
            }>) {
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
                if (myGen !== generation || queryClosed)
                  return { value: undefined as unknown as SdkMessage, done: true }
                const script = scripts[0]
                // throw 脚本:在消费任意消息之前按 throwAfter 触发(可对空脚本用)。
                if (
                  script &&
                  script.throwAfter !== undefined &&
                  script.throwWith !== undefined &&
                  script.cursor >= script.throwAfter
                ) {
                  script.cursor++
                  // throwOnce:抛出后丢弃本脚本,让下一个会话（降级重试）能拿到后面的脚本。
                  if ((script as { throwOnce?: boolean }).throwOnce) scripts.shift()
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
    /** 会话条目读取（fork anchor 算法）：默认空 = 「磁盘上没有这个会话」→ 降级为全量重放。 */
    getSessionMessages: async () => [...transcript],
    __setTranscript: (entries: Array<{ type: string; uuid: string }>) => {
      transcript.length = 0
      transcript.push(...entries)
    },
    __pushQueryScript: (s: {
      messages: SdkMessage[]
      throwAfter?: number
      throwWith?: unknown
      throwOnce?: boolean
    }) => {
      scripts.push({ ...s, cursor: 0 })
      wake()
    },
    __queryCalls: queryCalls,
    __getUserMessages: () => [...userMessages],
    __resetMock: () => {
      queryCalls.length = 0
      scripts.length = 0
      userMessages.length = 0
      transcript.length = 0
      generation++
      wake()
    }
  }
})

// 必须在 vi.mock 之后 import driver
const { QoderTaskAgentDriver, stripQoderModelPrefix } = await import('../../pi-extension/qoder/qoder-task-agent.js')
const sdkMock = (await import('@qoder-ai/qoder-agent-sdk')) as unknown as {
  __pushQueryScript: (s: {
    messages: SdkMessage[]
    throwAfter?: number
    throwWith?: unknown
    throwOnce?: boolean
  }) => void
  __setTranscript: (entries: Array<{ type: string; uuid: string }>) => void
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

/** 带上下文占用比的 `result` 消息（V7：ratio 是唯一能用的预算信号）。 */
function resultMsgWithRatio(contextUsageRatio: number, result: string, sessionId?: string): SdkMessage {
  return { type: 'result', session_id: sessionId, result, usage: { context_usage_ratio: contextUsageRatio } }
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

/**
 * 三段齐全的计划正文（§4.3）：只有契约完整才允许拆 Plan / Exec 边界。
 * 存量任务（旧计划没这三段）走另一条预期路径，见下方 plan_schema_incomplete 用例。
 */
const COMPLETE_PLAN = [
  '## 实施步骤',
  '',
  '第 1 步：改 a.ts',
  '',
  '## 已定位文件与依据',
  '',
  '- a.ts：唯一引用点',
  '',
  '## 已否决方案与理由',
  '',
  '- 新建包装层：改动面更大',
  '',
  '## 验证方式',
  '',
  '- 跑单测'
].join('\n')

/** 每个用例一个空 dataDir：产物按 (taskId, revision) 寻址，复用会让上一例的 md 参到本例的对账里。 */
const tempDataDirs: string[] = []

function driver(extra: Partial<ConstructorParameters<typeof QoderTaskAgentDriver>[0]> = {}) {
  const events: CapturedEvent[] = []
  const addTaskEvent = () => undefined
  const emitPi = (_e: { type: 'qoder_event'; taskId: string; message: SDKMessage }) => undefined
  const dataDir = mkdtempSync(join(tmpdir(), 'qoder-task-agent-'))
  tempDataDirs.push(dataDir)
  const d = new QoderTaskAgentDriver({
    store: fakeStore(),
    qoderTokenProvider: () => 'test-token',
    dataDir,
    addTaskEvent,
    emitPi,
    emit: (e) => events.push(e as CapturedEvent),
    ...extra
  })
  return { driver: d, events, dataDir }
}

describe('QoderTaskAgentDriver', () => {
  let savedLog: string | undefined

  afterAll(() => {
    for (const dir of tempDataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

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
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('agent_start')
    expect(types[types.length - 1]).toBe('agent_end')
    const textEvents = events.filter((e) => e.type === 'agent_text')
    // 连续文本(无工具调用/无空行边界)在回合结束时合并成一段,不再每条 delta 一条碎片。
    expect(textEvents.length).toBe(1)
    expect(textEvents[0]?.text).toContain('Hello')
    expect(textEvents[0]?.text).toContain('World')
    expect(textEvents[0]?.text).toContain('Final')
    const result = d.collectResult('task-1', 'planning')
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
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    const textEvents = events.filter((e) => e.type === 'agent_text')
    // 空行 → 段落边界:至少两段(第一段 + 剩余部分);不会出现逐 delta 的碎片。
    expect(textEvents.length).toBeGreaterThanOrEqual(2)
    for (const event of textEvents) {
      expect(String(event.text ?? '')).not.toBe('')
    }
  })

  it('runStage(implementation) collects responseTexts and forwards sessionId', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('Implementing', 'impl-sess'), resultMsg('Done', 'impl-sess')] })
    const { driver: d } = driver()
    await d.runStage({ phase: 'implementation', task: fakeTask(), repos: fakeRepos() })
    const result = d.collectResult('task-1', 'implementation')
    expect(result.responseTexts).toContain('Implementing')
    expect(result.sessionId).toBe('impl-sess')
  })

  it('runStage(implementation) with resumeSessionId threads session through', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('Resumed', 'resume-sess')] })
    const { driver: d } = driver()
    await d.runStage({
      phase: 'implementation',
      task: fakeTask(),
      repos: fakeRepos(),
      resumeSessionId: 'resume-sess',
      extraPrompt: '继续'
    })
    const result = d.collectResult('task-1', 'implementation')
    expect(result.sessionId).toBe('resume-sess')
    expect(result.responseTexts).toContain('Resumed')
  })

  it('Plan → Exec 拆为两个阶段实例：父会话在盘上时走 fork（不再共享会话）', async () => {
    // 会话条目树：两个完整 turn。anchor 必须是「最后一个 turn 的最后一条 entry」。
    sdkMock.__setTranscript([
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' },
      { type: 'user', uuid: 'u2' },
      { type: 'assistant', uuid: 'a2' }
    ])
    const task = fakeTask({ planContent: COMPLETE_PLAN })
    sdkMock.__pushQueryScript({ messages: [assistantMsg('plan output', 'sess-1'), resultMsg('{}', 'sess-1')] })
    const { driver: d, dataDir } = driver()
    await d.runStage({ phase: 'planning', task, repos: fakeRepos() })
    // 阶段边界 = 会话边界：implementation 不再复用 plan 会话，而是 fork 出一个新会话。
    sdkMock.__pushQueryScript({ messages: [resultMsg('implemented', 'sess-2')] })
    await d.runStage({ phase: 'implementation', task, repos: fakeRepos() })
    expect(sdkMock.__queryCalls.length).toBe(2)
    const implOptions = (sdkMock.__queryCalls[1] as { options?: Record<string, unknown> }).options
    expect(implOptions?.resume).toBe('sess-1')
    expect(implOptions?.forkSession).toBe(true)
    // 指到 user 条目会被 CLI 判为「丢弃范围不以该 turn 的 prompt 开头」而 exit 42 → 取尾部 a2。
    expect(implOptions?.resumeSessionAt).toBe('a2')
    const implResult = d.collectResult('task-1', 'implementation')
    expect(implResult.responseTexts.some((t) => t.includes('implemented'))).toBe(true)
    expect(implResult.sessionId).toBe('sess-2')
    // 已批准的计划正文必须出现在 Exec 输入里（人在 EditPlanDialog 改的条目不能被静默丢弃）。
    const execPrompt = sdkMock.__getUserMessages().at(-1) ?? ''
    expect(execPrompt).toContain('第 1 步：改 a.ts')
    // 产物契约：导出视图的路径要能在 Exec 输入里看到（模型需要细节时可 Read）。
    expect(execPrompt).toContain(join('tasks', 'task-1', 'plan.v0.md'))
    // 阶段输入快照落盘（序号按任务单调递增：plan=1、exec=2），文件名里的 `:` 已安全化。
    expect(existsSync(join(dataDir, 'tasks', 'task-1', 'stages', 'task-1_implementation_2.json'))).toBe(true)
  })

  it('存量计划缺三段时不拆 Exec：沿旧会话但换用实现阶段权限', async () => {
    sdkMock.__setTranscript([
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' }
    ])
    const task = fakeTask({ planContent: '第 1 步：改 a.ts' })
    sdkMock.__pushQueryScript({ messages: [assistantMsg('plan output', 'sess-1'), resultMsg('{}', 'sess-1')] })
    const { driver: d, dataDir } = driver()
    await d.runStage({ phase: 'planning', task, repos: fakeRepos() })
    sdkMock.__pushQueryScript({ messages: [resultMsg('implemented', 'sess-1')] })
    await d.runStage({ phase: 'implementation', task, repos: fakeRepos() })
    // 不拆边界 = 不新建阶段实例，但 P4 后不能沿旧会话的只读边界：
    // 活着的 plan 会话被关掉、按同一 sessionId resume，所以多了一次 query。
    expect(sdkMock.__queryCalls.length).toBe(2)
    const implOptions = (sdkMock.__queryCalls[1] as { options?: Record<string, unknown> }).options
    expect(implOptions?.resume).toBe('sess-1')
    expect(implOptions?.forkSession).toBeUndefined()
    expect(implOptions?.disallowedTools).toBeUndefined()
    expect(implOptions?.permissionMode).toBe('acceptEdits')
    const snapshot = JSON.parse(
      readFileSync(join(dataDir, 'tasks', 'task-1', 'stages', 'task-1_planning_1.json'), 'utf8')
    ) as { fallback?: string; sessionMode?: string }
    expect(snapshot.fallback).toBe('plan_schema_incomplete')
    expect(snapshot.sessionMode).toBe('resume')
  })

  it('阶段权限在会话创建时就定死：Plan 禁写工具、Exec / Test 可写', async () => {
    sdkMock.__setTranscript([
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' }
    ])
    const task = fakeTask({ planContent: COMPLETE_PLAN })
    const { driver: d } = driver()
    sdkMock.__pushQueryScript({ messages: [assistantMsg('plan output', 'sess-1'), resultMsg('{}', 'sess-1')] })
    await d.runStage({ phase: 'planning', task, repos: fakeRepos() })
    sdkMock.__pushQueryScript({ messages: [resultMsg('implemented', 'sess-2')] })
    await d.runStage({ phase: 'implementation', task, repos: fakeRepos() })
    const planOptions = (sdkMock.__queryCalls[0] as { options?: Record<string, unknown> }).options
    const implOptions = (sdkMock.__queryCalls[1] as { options?: Record<string, unknown> }).options
    // 名字取自 V10 实测的 init tools；写错不会报错只会静默不禁，所以这里锁到数组形态。
    expect(planOptions?.permissionMode).toBe('default')
    expect(planOptions?.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit'])
    expect(implOptions?.permissionMode).toBe('acceptEdits')
    expect(implOptions?.disallowedTools).toBeUndefined()
  })

  it('父会话上下文超预算 → 不再 fork，改全量重建并落事件（降级不能静默）', async () => {
    sdkMock.__setTranscript([
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' }
    ])
    const task = fakeTask({ planContent: COMPLETE_PLAN })
    const events: CapturedEvent[] = []
    const { driver: d } = driver({
      addTaskEvent: (event) => events.push(event as unknown as CapturedEvent)
    })
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('plan output', 'sess-1'), resultMsgWithRatio(0.9, '{}', 'sess-1')]
    })
    await d.runStage({ phase: 'planning', task, repos: fakeRepos() })
    sdkMock.__pushQueryScript({ messages: [resultMsg('implemented', 'sess-2')] })
    await d.runStage({ phase: 'implementation', task, repos: fakeRepos() })
    const implOptions = (sdkMock.__queryCalls[1] as { options?: Record<string, unknown> }).options
    // fork 会连同那份膨胀一起继承（V8：不自动压缩）→ 宁重不继承。
    expect(implOptions?.forkSession).toBeUndefined()
    expect(implOptions?.resume).toBeUndefined()
    expect(events.some((e) => String(e.title).includes('上下文超预算'))).toBe(true)
    const snapshot = JSON.parse(
      readFileSync(join(tempDataDirs.at(-1)!, 'tasks', 'task-1', 'stages', 'task-1_implementation_2.json'), 'utf8')
    ) as { fallback?: string }
    expect(snapshot.fallback).toBe('context-budget')
  })

  it('计划产物 sha 与 DB 不一致时拒绝启动 Exec（不允许静默取其一）', async () => {
    sdkMock.__setTranscript([{ type: 'user', uuid: 'u1' }])
    const task = fakeTask({ planContent: COMPLETE_PLAN, planRevision: 3 })
    const { driver: d, dataDir } = driver()
    const dir = join(dataDir, 'tasks', 'task-1')
    mkdirSync(dir, { recursive: true })
    // 旧版写盘未完成 / 被外部改过：md 与元信息都是另一份内容。
    writeFileSync(join(dir, 'plan.v3.md'), '## 旧计划\n\n完全不同的内容\n', 'utf8')
    writeFileSync(
      join(dir, 'plan.v3.json'),
      JSON.stringify({
        revision: 3,
        sha256: sha256Hex('## 旧计划\n\n完全不同的内容\n'),
        editedBy: 'agent',
        planPath: 'x'
      }),
      'utf8'
    )
    await expect(d.runStage({ phase: 'implementation', task, repos: fakeRepos() })).rejects.toThrow(
      /计划产物与数据库不一致/
    )
    // 对账失败不能先拉起的会话：一个 query 都没发。
    expect(sdkMock.__queryCalls.length).toBe(0)
  })

  it('Exec → Test 也拆实例：Test 从实现会话 fork，输入是改动摘要', async () => {
    sdkMock.__setTranscript([
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' }
    ])
    const task = fakeTask({ planContent: COMPLETE_PLAN })
    const repos = [{ ...fakeRepos()[0]!, changeSummary: 'a.ts: 改返回值' }]
    const { driver: d, dataDir } = driver()
    sdkMock.__pushQueryScript({ messages: [assistantMsg('plan output', 'sess-1'), resultMsg('{}', 'sess-1')] })
    await d.runStage({ phase: 'planning', task, repos })
    sdkMock.__pushQueryScript({ messages: [assistantMsg('implemented', 'sess-2'), resultMsg('{}', 'sess-2')] })
    await d.runStage({ phase: 'implementation', task, repos })
    // 实现收尾写好的交接产物（生产链路由 finishImplementation 写入）。
    writeFileSync(join(dataDir, 'tasks', 'task-1', 'exec.summary.md'), '## 实现结论\n\n已改 a.ts\n', 'utf8')
    sdkMock.__pushQueryScript({ messages: [resultMsg('{"files":[]}', 'sess-3')] })
    await d.runStage({ phase: 'test_generation', task, repos })
    expect(sdkMock.__queryCalls.length).toBe(3)
    const testOptions = (sdkMock.__queryCalls[2] as { options?: Record<string, unknown> }).options
    expect(testOptions?.resume).toBe('sess-2')
    expect(testOptions?.forkSession).toBe(true)
    const testPrompt = sdkMock.__getUserMessages().at(-1) ?? ''
    expect(testPrompt).toContain('已改 a.ts')
    expect(testPrompt).toContain('a.ts: 改返回值')
    // 测试阶段不能再把计划正文当输入（它需要的是「改了什么」）。
    expect(testPrompt).not.toContain('第 1 步')
  })

  it('父会话不在磁盘上时降级为全量 prompt 重放（parent-session-missing）', async () => {
    // transcript 默认空 = 读不到会话条目 → fork 不可用。
    const task = fakeTask({ planContent: COMPLETE_PLAN })
    sdkMock.__pushQueryScript({ messages: [assistantMsg('plan output', 'sess-1'), resultMsg('{}', 'sess-1')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo'] })
    })
    await d.runStage({ phase: 'planning', task, repos: fakeRepos() })
    sdkMock.__pushQueryScript({ messages: [resultMsg('implemented', 'sess-2')] })
    await d.runStage({ phase: 'implementation', task, repos: fakeRepos() })
    expect(sdkMock.__queryCalls.length).toBe(2)
    const implOptions = (sdkMock.__queryCalls[1] as { options?: Record<string, unknown> }).options
    expect(implOptions?.forkSession).toBeUndefined()
    expect(implOptions?.resume).toBeUndefined()
    // 无上下文可继承 → 任务上下文必须重新拼进去。
    const lastUserText = sdkMock.__getUserMessages().at(-1) ?? ''
    expect(lastUserText).toContain('## Agent 指引 — 仓库 repo')
    expect(lastUserText).toContain('Approved implementation plan')
  })

  it('fork 被 CLI 拒绝(exit 42)且零输出时降级为「无 anchor 的 fork」', async () => {
    sdkMock.__setTranscript([
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' }
    ])
    const { QoderCliProcessError: QPE } = await import('@qoder-ai/qoder-agent-sdk')
    const task = fakeTask({ planContent: COMPLETE_PLAN })
    sdkMock.__pushQueryScript({ messages: [assistantMsg('plan output', 'sess-1'), resultMsg('{}', 'sess-1')] })
    const { driver: d } = driver()
    await d.runStage({ phase: 'planning', task, repos: fakeRepos() })
    sdkMock.__pushQueryScript({
      messages: [],
      throwAfter: 0,
      throwOnce: true,
      throwWith: new QPE('Qoder CLI process exited with code 42', {
        exitCode: 42,
        signal: null,
        stderr: 'Resume rejected by --resume-drops-turn: range does not start with the declared turn prompt'
      })
    })
    sdkMock.__pushQueryScript({ messages: [resultMsg('implemented', 'sess-2')] })
    await d.runStage({ phase: 'implementation', task, repos: fakeRepos() })
    // 一次尝试 + 一次降级重试 + plan = 3 个 query。
    expect(sdkMock.__queryCalls.length).toBe(3)
    const retryOptions = (sdkMock.__queryCalls[2] as { options?: Record<string, unknown> }).options
    expect(retryOptions?.forkSession).toBe(true)
    expect(retryOptions?.resumeSessionAt).toBeUndefined()
    expect(d.collectResult('task-1', 'implementation').sessionId).toBe('sess-2')
  })

  it('closeSession releases the resident session and clears phase buffers', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('plan output', 'sess-1'), resultMsg('{}', 'sess-1')] })
    const { driver: d } = driver()
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    expect(d.collectResult('task-1', 'planning').responseTexts.length).toBeGreaterThan(0)
    d.closeSession('task-1')
    // 会话与阶段产物都被释放:collectResult 回退为空。
    expect(d.collectResult('task-1', 'planning').responseTexts).toEqual([])
    // 释放后重新执行会重建全新会话(不残留旧上下文)。
    sdkMock.__pushQueryScript({ messages: [assistantMsg('second plan', 'sess-2'), resultMsg('{}', 'sess-2')] })
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    expect(d.collectResult('task-1', 'planning').responseTexts.some((t) => t.includes('second plan'))).toBe(true)
    // 会话重建:query 新建(sessionId 变化)。
    expect(d.collectResult('task-1', 'planning').sessionId).toBe('sess-2')
  })

  it('reuses the plan session when revising with feedback (revise 追加消息,不走 Qoder Init)', async () => {
    sdkMock.__pushQueryScript({
      messages: [
        assistantMsg('第一版计划', 'sess-1'),
        resultMsg('{"outcome":"changes_required","plan":"第一版"}', 'sess-1')
      ]
    })
    const { driver: d } = driver()
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    expect(sdkMock.__queryCalls.length).toBe(1)
    // 计划调整(带 feedback):复用已存在会话,追加"调整意见"消息,不新建 query。
    sdkMock.__pushQueryScript({
      messages: [
        assistantMsg('第二版计划', 'sess-1'),
        resultMsg('{"outcome":"changes_required","plan":"第二版"}', 'sess-1')
      ]
    })
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos(), feedback: '第二版要更详细' })
    expect(sdkMock.__queryCalls.length).toBe(1)
    const texts = sdkMock.__getUserMessages()
    expect(texts.some((t) => t.includes('调整意见') && t.includes('第二版要更详细'))).toBe(true)
  })

  it('second plan run resets the phase buffer (collectResult 只含本回合文本)', async () => {
    // 回归：缓冲此前跨回合累积，第二次 plan 解析「旧+新」拼接文本，
    // 兜底正则先匹配旧计划 → 两版计划内容完全相同。
    sdkMock.__pushQueryScript({
      messages: [
        assistantMsg('第一版计划', 'sess-1'),
        resultMsg('{"outcome":"changes_required","plan":"v1"}', 'sess-1')
      ]
    })
    const { driver: d } = driver()
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    expect(d.collectResult('task-1', 'planning').responseTexts.some((t) => t.includes('第一版计划'))).toBe(true)
    sdkMock.__pushQueryScript({
      messages: [
        assistantMsg('第二版计划', 'sess-1'),
        resultMsg('{"outcome":"changes_required","plan":"v2"}', 'sess-1')
      ]
    })
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos(), feedback: '更详细' })
    const texts = d.collectResult('task-1', 'planning').responseTexts
    expect(texts.some((t) => t.includes('第二版计划'))).toBe(true)
    expect(texts.some((t) => t.includes('第一版计划'))).toBe(false)
  })

  it('keeps appending to the resident session even without feedback (重新生成也追加消息)', async () => {
    sdkMock.__pushQueryScript({
      messages: [
        assistantMsg('第一版计划', 'sess-1'),
        resultMsg('{"outcome":"changes_required","plan":"第一版"}', 'sess-1')
      ]
    })
    const { driver: d } = driver()
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    expect(sdkMock.__queryCalls.length).toBe(1)
    // 无 feedback 的"重新生成"同样复用会话追加消息,不走 Qoder Init。
    sdkMock.__pushQueryScript({
      messages: [
        assistantMsg('第二版计划', 'sess-1'),
        resultMsg('{"outcome":"changes_required","plan":"第二版"}', 'sess-1')
      ]
    })
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    expect(sdkMock.__queryCalls.length).toBe(1)
  })

  it('resumes the saved session when no active session exists (应用重启后 resume)', async () => {
    // 无活跃会话,但 task.qoderSessionId 已持久化 → 创建会话时 resume,不丢上下文。
    sdkMock.__pushQueryScript({
      messages: [
        assistantMsg('恢复后计划', 'saved-sess'),
        resultMsg('{"outcome":"changes_required","plan":"恢复后"}', 'saved-sess')
      ]
    })
    const { driver: d } = driver()
    await d.runStage({ phase: 'planning', task: fakeTask({ qoderSessionId: 'saved-sess' }), repos: fakeRepos() })
    const options = sdkMock.__queryCalls[0] as { options?: { resume?: string } }
    expect(options?.options?.resume).toBe('saved-sess')
  })

  it('emits agent_session with taskId for session persistence', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('计划分析', 'sess-1'), resultMsg('{}', 'sess-1')] })
    const { driver: d, events } = driver()
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    const sessionEvent = events.find((e) => e.type === 'agent_session') as
      | { type: 'agent_session'; taskId?: string; sessionId?: string }
      | undefined
    expect(sessionEvent).toBeDefined()
    expect(sessionEvent?.taskId).toBe('task-1')
    expect(sessionEvent?.sessionId).toBe('sess-1')
  })

  it('runStage(test_generation) collects test response texts', async () => {
    sdkMock.__pushQueryScript({
      messages: [assistantMsg('{"files":["a_test.ts"]}', 'test-sess'), resultMsg('Done', 'test-sess')]
    })
    const { driver: d } = driver()
    await d.runStage({ phase: 'test_generation', task: fakeTask(), repos: fakeRepos() })
    const result = d.collectResult('task-1', 'test_generation')
    expect(result.responseTexts.some((t) => t.includes('a_test.ts'))).toBe(true)
    expect(result.sessionId).toBe('test-sess')
  })

  it('runStage(planning) prepends agent context sections to the prompt', async () => {
    sdkMock.__pushQueryScript({ messages: [assistantMsg('分析中', 'p-sess'), resultMsg('{}', 'p-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo（repo）\n遵循项目约定'] })
    })
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    // 用户输入走异步消息流:首回合消息应包含注入的 Agent 指引。
    const texts = sdkMock.__getUserMessages()
    expect(texts[0]).toContain('## Agent 指引 — 仓库 repo')
    expect(texts[0]).toContain('遵循项目约定')
  })

  it('任务上下文提取注入每任务只做一次：续接阶段不重拼上下文', async () => {
    let memoryCalls = 0
    let agentCalls = 0
    sdkMock.__pushQueryScript({ messages: [assistantMsg('分析中', 'p-sess'), resultMsg('{}', 'p-sess')] })
    const { driver: d } = driver({
      resolveMemoryContext: async () => {
        memoryCalls += 1
        return '记忆上下文'
      },
      resolveAgentContext: async () => {
        agentCalls += 1
        return { sections: ['## Agent 指引'] }
      }
    })
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    expect(memoryCalls).toBe(1)
    expect(agentCalls).toBe(1)
    sdkMock.__pushQueryScript({ messages: [assistantMsg('再分析', 'p-sess'), resultMsg('{}', 'p-sess')] })
    await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
    // 第二次 runStage(planning) 走同一阶段实例续接：上下文已在会话前缀里，记忆与 Agent 指引都不再重拼。
    expect(memoryCalls).toBe(1)
    expect(agentCalls).toBe(1)
  })

  it('runStage(implementation) prepends agent context sections to the prompt', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('Done', 'i-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo\n遵循项目约定'] })
    })
    await d.runStage({ phase: 'implementation', task: fakeTask(), repos: fakeRepos() })
    const texts = sdkMock.__getUserMessages()
    expect(texts[0]).toContain('## Agent 指引')
  })

  it('runStage(implementation) with resumeSessionId skips agent context re-injection', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('Resumed', 'r-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo\n遵循项目约定'] })
    })
    await d.runStage({
      phase: 'implementation',
      task: fakeTask(),
      repos: fakeRepos(),
      resumeSessionId: 'r-sess',
      extraPrompt: '继续完成'
    })
    const texts = sdkMock.__getUserMessages()
    expect(texts[0]).not.toContain('## Agent 指引')
    expect(texts[0]).toContain('继续完成')
  })

  it('runStage(test_generation) prepends agent context sections to the prompt', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('{"files":[]}', 't-sess')] })
    const { driver: d } = driver({
      resolveAgentContext: async () => ({ sections: ['## Agent 指引 — 仓库 repo\n遵循项目约定'] })
    })
    await d.runStage({ phase: 'test_generation', task: fakeTask(), repos: fakeRepos() })
    const texts = sdkMock.__getUserMessages()
    expect(texts[0]).toContain('## Agent 指引')
  })

  it('forwards resolveModel result as the query model', async () => {
    sdkMock.__pushQueryScript({ messages: [resultMsg('Done', 'm-sess')] })
    const { driver: d } = driver({
      resolveModel: () => 'claude-sonnet-4.5'
    })
    await d.runStage({ phase: 'implementation', task: fakeTask(), repos: fakeRepos() })
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
    await expect(d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })).rejects.toThrow(/Qoder Token/)
  })

  it('throws when no repositories are associated with the task', async () => {
    const { driver: d } = driver()
    await expect(d.runStage({ phase: 'planning', task: fakeTask(), repos: [] })).rejects.toThrow(/未关联代码仓库/)
  })

  it('rejects an unknown collectResult phase gracefully (returns empty)', () => {
    const { driver: d } = driver()
    // @ts-expect-error 故意传入错误 phase 验证 driver 不抛
    const result = d.collectResult('task-1', 'invalid-phase')
    expect(result.responseTexts).toEqual([])
  })

  it('runStage(planning) 阶段 SDK 抛 QoderCliProcessError(exit 42) 时,把 stderr 拼到错误 message 一起上抛', async () => {
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
      await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
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

  it('runStage(planning) 阶段 SDK 抛非 QoderCliProcessError 时,原样上抛不附加 stderr', async () => {
    const plainError = new Error('boom')
    sdkMock.__pushQueryScript({ messages: [], throwAfter: 0, throwWith: plainError })
    const { driver: d } = driver()
    let caught: Error | undefined
    try {
      await d.runStage({ phase: 'planning', task: fakeTask(), repos: fakeRepos() })
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
    await d.runStage({ phase: 'implementation', task: fakeTask(), repos: fakeRepos() })
    const options = (sdkMock.__queryCalls[0] as { options?: { model?: unknown } } | undefined)?.options
    expect(options?.model).toBe('claude-sonnet-4.5')
  })
})
