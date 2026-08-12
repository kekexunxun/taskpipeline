import { mkdtempSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { estimateCostUsd, lookupCostRate } from './cost-table.js'
import { redactSecretsDeep, redactSpan } from './redact.js'
import { summarizeTrace } from './stats.js'
import { JsonlTraceStorage, traceEventsFile, traceInfoDir, traceInfoFile } from './storage.js'
import type { AgentSpan } from './types.js'

let root: string
let storage: JsonlTraceStorage

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trace-v2-'))
  storage = new JsonlTraceStorage(root)
})

afterEach(() => {
  /* tmp 目录留给系统清理 */
})

function span(partial: Partial<AgentSpan>): AgentSpan {
  return {
    spanId: 'evt-t1-1',
    traceId: 't1',
    type: 'llm.generate',
    name: 'gpt-4o',
    status: 'started',
    startedAt: 1000,
    sequence: 1,
    createdAt: new Date(1000).toISOString(),
    ...partial
  }
}

describe('JsonlTraceStorage', () => {
  it('appendSpan 追加写 events 文件，getTrace 按 spanId 合并快照（保留最后一条）', async () => {
    storage.appendSpan('t1', 'span_start', span({ spanId: 'evt-t1-1', status: 'started', sequence: 1 }))
    storage.appendSpan('t1', 'span_update', span({ spanId: 'evt-t1-1', status: 'running', sequence: 2 }))
    storage.appendSpan(
      't1',
      'span_end',
      span({ spanId: 'evt-t1-1', status: 'completed', endedAt: 2000, durationMs: 1000, sequence: 3 })
    )
    storage.appendSpan(
      't1',
      'span_start',
      span({ spanId: 'evt-t1-2', type: 'tool.execute', name: 'bash', status: 'started', sequence: 4 })
    )

    const spans = await storage.getTrace('t1')
    expect(spans).toHaveLength(2)
    expect(spans![0]!.status).toBe('completed')
    expect(spans![0]!.durationMs).toBe(1000)
    expect(spans![1]!.name).toBe('bash')
    // 文件按 sequence 排序
    expect(spans![0]!.sequence).toBe(3)
    expect(spans![1]!.sequence).toBe(4)
  })

  it('finalize 写 info 摘要，listTraces 返回完成态并按 updatedAt 倒序', async () => {
    storage.appendSpan('t1', 'span_start', span({ traceId: 't1', status: 'completed' }))
    storage.finalize(
      't1',
      summarizeTrace('t1', 'chat', '提问1', (await storage.getTrace('t1'))!, '2026-01-02T00:00:00.000Z')
    )
    storage.appendSpan('t2', 'span_start', span({ traceId: 't2', status: 'completed' }))
    storage.finalize(
      't2',
      summarizeTrace('t2', 'chat', '提问2', (await storage.getTrace('t2'))!, '2026-01-01T00:00:00.000Z')
    )

    const list = await storage.listTraces()
    expect(list.map((s) => s.traceId)).toEqual(['t1', 't2'])
    expect(list[0]!.title).toBe('提问1')
  })

  it('running 兜底：无 info 的 events 文件按 running 列出', async () => {
    storage.appendSpan('t3', 'span_start', span({ traceId: 't3', status: 'started' }))
    const list = await storage.listTraces()
    expect(list.some((s) => s.traceId === 't3' && s.status === 'running')).toBe(true)
  })

  it('deleteTrace 移除 info 摘要与 events 文件，列表不再返回', async () => {
    storage.appendSpan('t1', 'span_start', span({ traceId: 't1', status: 'completed' }))
    storage.finalize(
      't1',
      summarizeTrace('t1', 'chat', '提问1', (await storage.getTrace('t1'))!, '2026-01-01T00:00:00.000Z')
    )

    expect(await storage.deleteTrace('t1')).toBe(true)
    expect(existsSync(traceEventsFile(root, 't1'))).toBe(false)
    expect(existsSync(traceInfoFile(root, 't1'))).toBe(false)
    expect(await storage.listTraces()).toHaveLength(0)
    // 幂等：再次删除不存在的 trace 返回 false
    expect(await storage.deleteTrace('t1')).toBe(false)
  })

  it('dashboardStats 聚合今日请求数 / 平均耗时 / 总成本', async () => {
    const now = Date.now()
    const today = new Date(now).toISOString()
    storage.appendSpan(
      't1',
      'span_start',
      span({ traceId: 't1', startedAt: now - 1000, status: 'completed', endedAt: now + 500 })
    )
    storage.finalize('t1', summarizeTrace('t1', 'chat', 'a', (await storage.getTrace('t1'))!, today))
    storage.appendSpan(
      't2',
      'span_start',
      span({ traceId: 't2', startedAt: now - 2000, status: 'completed', endedAt: now + 1500 })
    )
    storage.finalize('t2', summarizeTrace('t2', 'chat', 'b', (await storage.getTrace('t2'))!, today))

    const stats = await storage.dashboardStats()
    expect(stats.todayCount).toBe(2)
    expect(stats.avgDurationMs).toBe(2500)
  })

  it('dashboardStats.errorCount 口径：含错误步骤的 trace 数（两态模型下与 trace 状态无关）', async () => {
    const today = new Date().toISOString()
    // t1：含一个 error span —— summarize 恒 ended，但 errorCount=1
    storage.appendSpan(
      't1',
      'span_start',
      span({ traceId: 't1', status: 'error', error: { message: 'boom' }, startedAt: Date.now() - 1000 })
    )
    storage.finalize('t1', summarizeTrace('t1', 'chat', 'a', (await storage.getTrace('t1'))!, today))
    // t2：全部正常
    storage.appendSpan('t2', 'span_start', span({ traceId: 't2', status: 'completed', startedAt: Date.now() - 1000 }))
    storage.finalize('t2', summarizeTrace('t2', 'chat', 'b', (await storage.getTrace('t2'))!, today))

    const list = await storage.listTraces()
    // 两态模型：两条都是 ended，含 error span 的 t1 也不例外
    expect(list.every((s) => s.status === 'ended')).toBe(true)
    const stats = await storage.dashboardStats()
    expect(stats.errorCount).toBe(1)
  })

  it('孤儿收口：loadSpans 全量快照 + finalize 标记 interrupted，列表按已结束返回且保留错误计数', async () => {
    // 模拟崩溃残留：只有 events 文件、无 info 摘要
    storage.appendSpan(
      't-orphan',
      'span_start',
      span({ traceId: 't-orphan', spanId: 'root', type: 'task.run', name: '任务执行', status: 'started', sequence: 1 })
    )
    storage.appendSpan(
      't-orphan',
      'span_start',
      span({
        traceId: 't-orphan',
        spanId: 'tool1',
        type: 'tool.execute',
        name: 'bash',
        status: 'error',
        error: { message: 'exit 1' },
        sequence: 2
      })
    )
    // 收口前列表按 running 兜底
    expect((await storage.listTraces()).find((s) => s.traceId === 't-orphan')?.status).toBe('running')

    // 收口（main.ts sweepInterruptedTraces 的核心步骤）：全量快照 → 摘要 → finalize interrupted
    const spans = storage.loadSpans('t-orphan')
    expect(spans).toHaveLength(2)
    const rootSpan = spans!.find((s) => s.type === 'task.run' || s.type === 'session.start')
    const summary = summarizeTrace('t-orphan', rootSpan?.type === 'session.start' ? 'chat' : 'task', 't-orphan', spans!)
    storage.finalize('t-orphan', { ...summary, interrupted: true })

    const listed = (await storage.listTraces()).find((s) => s.traceId === 't-orphan')
    expect(listed?.status).toBe('ended')
    expect(listed?.interrupted).toBe(true)
    expect(listed?.errorCount).toBe(1)
    expect(listed?.spanCount).toBe(2)
  })
})

describe('redactSecretsDeep', () => {
  it('命中敏感 key 名整体替换', () => {
    const input = { api_key: 'sk-1234567890abcdef', password: 'hunter2', model: 'gpt-4o', nested: { token: 'abc' } }
    const out = redactSecretsDeep(input) as Record<string, unknown>
    expect(out.api_key).toMatch(/REDACTED/)
    expect(out.password).toMatch(/REDACTED/)
    expect(out.model).toBe('gpt-4o')
    expect((out.nested as Record<string, unknown>).token).toMatch(/REDACTED/)
  })

  it('字符串值命中敏感格式替换（Bearer / sk- / JWT）', () => {
    expect(
      redactSecretsDeep(
        'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
      )
    ).toMatch(/REDACTED/)
    expect(redactSecretsDeep('Authorization: Bearer xyz_abcdefghijk')).toMatch(/REDACTED/)
    expect(redactSecretsDeep('普通文本 no secret')).toBe('普通文本 no secret')
  })

  it('数组与嵌套结构递归脱敏', () => {
    const input = [{ args: { apiKey: 'ak-1' } }, 'sk-abcdefghijklmnop', 42]
    const out = redactSecretsDeep(input) as unknown[]
    expect((out[0] as { args: Record<string, unknown> }).args.apiKey).toMatch(/REDACTED/)
    expect(out[1]).toMatch(/REDACTED/)
    expect(out[2]).toBe(42)
  })

  it('redactSpan 覆盖 input/output/meta/error 全字段', () => {
    const out = redactSpan({
      input: { password: 'x', prompt: 'hi' },
      output: { apiKey: 'k' },
      meta: { token: 't' },
      error: { message: 'Bearer abc_123456789012', stack: 'x' }
    })
    expect((out.input as Record<string, unknown>).password).toMatch(/REDACTED/)
    expect((out.output as Record<string, unknown>).apiKey).toMatch(/REDACTED/)
    expect((out.meta as Record<string, unknown>).token).toMatch(/REDACTED/)
    expect((out.error as { message: string }).message).toMatch(/REDACTED/)
  })
})

describe('cost-table', () => {
  it('按 model 匹配估算成本（单价 per 1K）', () => {
    // gpt-4o：0.0025/1K in + 0.01/1K out → 1000 in + 500 out = 0.0025 + 0.005
    expect(estimateCostUsd('gpt-4o', 1000, 500)).toBeCloseTo(0.0075, 6)
    expect(estimateCostUsd('deepseek-chat', 1000, 0)).toBeCloseTo(0.00027, 6)
    // 新形态匹配：deepseek 通用兜底 / claude-sonnet-4.x / gpt-5 系列
    expect(estimateCostUsd('deepseek-v3.2-exp', 1000, 1000)).toBeCloseTo(0.00027 + 0.0011, 6)
    expect(estimateCostUsd('claude-sonnet-4.5', 1000, 0)).toBeCloseTo(0.003, 6)
    expect(estimateCostUsd('gpt-5-nano', 1000, 1000)).toBeCloseTo(0.00005 + 0.0004, 6)
  })
  it('未知模型返回 undefined', () => {
    expect(estimateCostUsd('some-future-model', 1000, 1000)).toBeUndefined()
    expect(lookupCostRate(undefined)).toBeUndefined()
    expect(lookupCostRate('some-future-model')).toBeUndefined()
  })
  it('lookupCostRate 首个命中生效（长名优先）', () => {
    expect(lookupCostRate('gpt-4o-mini')?.match).toBe('gpt-4o-mini')
    expect(lookupCostRate('gpt-4o')?.match).toBe('gpt-4o')
    expect(lookupCostRate('glm-4.5-air')?.match).toBe('glm-4.5-air')
  })
})

describe('summarizeTrace', () => {
  it('聚合总耗时 / Token / 成本 / 工具统计 / 错误数', () => {
    const spans: AgentSpan[] = [
      span({
        traceId: 't',
        spanId: 's1',
        type: 'session.start',
        name: '会话',
        status: 'completed',
        startedAt: 0,
        endedAt: 5000,
        durationMs: 5000,
        sequence: 1
      }),
      span({
        traceId: 't',
        spanId: 's2',
        type: 'llm.generate',
        name: 'gpt-4o',
        model: 'gpt-4o',
        status: 'completed',
        startedAt: 0,
        endedAt: 3000,
        durationMs: 3000,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 },
        sequence: 2
      }),
      span({
        traceId: 't',
        spanId: 's3',
        type: 'tool.execute',
        name: 'bash',
        status: 'completed',
        startedAt: 3000,
        endedAt: 4000,
        durationMs: 1000,
        sequence: 3
      }),
      span({
        traceId: 't',
        spanId: 's4',
        type: 'tool.execute',
        name: 'bash',
        status: 'error',
        startedAt: 4000,
        endedAt: 4500,
        durationMs: 500,
        error: { message: 'boom' },
        sequence: 4
      })
    ]
    const summary = summarizeTrace('t', 'task', '任务A', spans, '2026-01-01T00:00:00.000Z')
    // 两态模型：含 error span 不再把 trace 翻转为失败，status 恒 'ended'，错误量由 errorCount 承载。
    expect(summary.status).toBe('ended')
    expect(summary.durationMs).toBe(5000)
    expect(summary.tokens).toEqual({ input: 100, output: 50, total: 150 })
    expect(summary.costUsd).toBe(0.01)
    expect(summary.errorCount).toBe(1)
    expect(summary.toolStats).toEqual([{ name: 'bash', count: 2, errors: 1 }])
    expect(summary.spanCount).toBe(4)
  })

  it('opts.model/agentName 优先于 spans 推断（ctx 显式声明 > span 兜底）', () => {
    // 模拟真实场景：trace 内混入辅助 LLM 调用（记忆检索关键词提取，用系统模型 deepseek-v4-flash），
    // 任务真实模型 qoder:lite 只存在于 beginTrace 的 ctx —— opts 必须覆盖 span 推断。
    const spans: AgentSpan[] = [
      span({
        traceId: 't',
        spanId: 's1',
        type: 'llm.generate',
        name: '关键词提取',
        model: 'deepseek-v4-flash',
        status: 'completed',
        sequence: 1
      }),
      span({
        traceId: 't',
        spanId: 's2',
        type: 'llm.generate',
        name: 'qoder',
        model: 'qoder',
        status: 'completed',
        sequence: 2
      })
    ]
    const summary = summarizeTrace('t', 'task', '任务A', spans, '2026-01-01T00:00:00.000Z', {
      model: 'qoder-lite',
      agentName: 'qoder'
    })
    expect(summary.model).toBe('qoder-lite')
    expect(summary.agentName).toBe('qoder')
  })

  it('无 opts 时回退 spans 推断（最后一个带 model 的 llm span）', () => {
    const spans: AgentSpan[] = [
      span({
        traceId: 't',
        spanId: 's1',
        type: 'llm.generate',
        name: '关键词提取',
        model: 'deepseek-v4-flash',
        status: 'completed',
        sequence: 1
      }),
      span({
        traceId: 't',
        spanId: 's2',
        type: 'llm.generate',
        name: '主对话',
        model: 'qwen-max',
        status: 'completed',
        sequence: 2
      })
    ]
    const summary = summarizeTrace('t', 'chat', 'x', spans, '2026-01-01T00:00:00.000Z')
    expect(summary.model).toBe('qwen-max')
  })
})

describe('目录布局', () => {
  it('events 与 info 分目录', () => {
    storage.appendSpan('t1', 'span_start', span({}))
    storage.finalize(
      't1',
      summarizeTrace('t1', 'chat', 'x', [span({ status: 'completed' })], '2026-01-01T00:00:00.000Z')
    )
    expect(readdirSync(traceInfoDir(root)).length).toBe(1)
    expect(existsSync(traceEventsFile(root, 't1'))).toBe(true)
  })
})
