import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonlTraceStorage } from '@task-pipeline/core'
import { TracePipeline, type TraceLiveEvent } from '../bus/trace-pipeline.js'
import { PiTraceBuilder } from './pi-trace-builder.js'
import { QoderTraceBuilder } from './qoder-trace-builder.js'

let root: string
let storage: JsonlTraceStorage
let pipeline: TracePipeline
let live: TraceLiveEvent[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trace-pipeline-'))
  storage = new JsonlTraceStorage(root)
  live = []
  pipeline = new TracePipeline(storage, (event) => live.push(event))
})

afterEach(() => {})

describe('TracePipeline', () => {
  it('span 生命周期：start/update/end 落盘，end 补 durationMs', async () => {
    pipeline.beginTrace({ traceId: 't1', kind: 'chat', title: '提问', source: 'qoder' })
    const rootSpan = pipeline.startSpan('t1', { type: 'session.start', name: '会话' })
    const llm = pipeline.startSpan('t1', { type: 'llm.generate', name: 'qwen-max', model: 'qwen-max' })
    expect(llm.parentSpanId).toBe(rootSpan.spanId)
    pipeline.updateSpan('t1', llm, { output: 'partial' })
    pipeline.endSpan('t1', llm, { output: 'hello', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
    pipeline.endSpan('t1', rootSpan)
    pipeline.endTrace('t1')

    const spans = await storage.getTrace('t1')
    expect(spans).toHaveLength(2)
    const l = spans!.find((s) => s.type === 'llm.generate')!
    expect(l.durationMs).toBeGreaterThanOrEqual(0)
    expect(l.output).toBe('hello')
    expect(l.usage?.costUsd).toBeDefined() // qwen-max 单价表兜底估算
    // update 是快照覆盖：llm 只有 2 条（start + end；update 被覆盖）
    const summary = (await storage.listTraces())[0]!
    expect(summary.title).toBe('提问')
    expect(summary.tokens?.total).toBe(15)
    expect(summary.spanCount).toBe(2)
  })

  it('脱敏：input/output/meta 中的敏感字段落盘为 [REDACTED]', async () => {
    pipeline.beginTrace({ traceId: 't1', kind: 'chat', title: '提问', source: 'openai' })
    const tool = pipeline.startSpan('t1', {
      type: 'tool.execute',
      name: 'bash',
      input: { cmd: 'echo hi', password: 'hunter2' },
      meta: { api_key: 'sk-abcdefghijklmn' }
    })
    pipeline.endSpan('t1', tool, { output: { secret: 'Bearer xyz_abcdefghijk', ok: true } })
    pipeline.endTrace('t1')

    const spans = await storage.getTrace('t1')
    const t = spans![0]!
    expect(String((t.input as { password: string }).password)).toMatch(/REDACTED/)
    expect(String((t.meta as { api_key: string }).api_key)).toMatch(/REDACTED/)
    expect(String((t.output as { secret: string }).secret)).toMatch(/REDACTED/)
    expect((t.output as { ok: boolean }).ok).toBe(true)
  })

  it('live 事件按 op 推送', () => {
    pipeline.beginTrace({ traceId: 't1', kind: 'chat', title: 'x', source: 'qoder' })
    const s = pipeline.startSpan('t1', { type: 'session.start', name: '会话' })
    pipeline.endSpan('t1', s)
    expect(live.map((e) => e.op)).toEqual(['span_start', 'span_end'])
    expect(live[0]!.traceId).toBe('t1')
  })

  it('未 beginTrace 抛错', () => {
    expect(() => pipeline.startSpan('nope', { type: 'llm.generate', name: 'x' })).toThrow(/beginTrace/)
  })

  it('join 语义：主对话 + 辅助 LLM 调用共享同一 trace（一次提问一条记录）', async () => {
    // 回合开始：主对话
    pipeline.beginTrace({ traceId: 'chat-c1-m1', kind: 'chat', title: '用户提问', source: 'qoder' })
    pipeline.startSpan('chat-c1-m1', { type: 'session.start', name: '对话', meta: { source: 'qoder' } })
    // 关键词提取 join：ensureActive 不重建、不覆盖根
    pipeline.ensureActive({ traceId: 'chat-c1-m1', kind: 'chat', title: '关键词提取', source: 'qoder' })
    const kw = pipeline.startSpan('chat-c1-m1', { type: 'llm.generate', name: 'qwen-lite' })
    pipeline.endSpan('chat-c1-m1', kw)
    // 主对话 LLM join
    pipeline.ensureActive({ traceId: 'chat-c1-m1', kind: 'chat', title: '主对话', source: 'qoder' })
    const llm = pipeline.startSpan('chat-c1-m1', { type: 'llm.generate', name: 'qwen-max' })
    pipeline.endSpan('chat-c1-m1', llm)
    pipeline.endTrace('chat-c1-m1')

    const spans = await storage.getTrace('chat-c1-m1')
    expect(spans).toHaveLength(3) // session + 关键词提取 + 主对话
    expect(spans![0]!.name).toBe('对话') // 根未被 join 调用覆盖
    const list = await storage.listTraces()
    expect(list).toHaveLength(1) // 只有一条 trace 记录
    expect(list[0]!.traceId).toBe('chat-c1-m1')
    expect(list[0]!.spanCount).toBe(3)
  })

  it('ensureRootSpan 幂等：恢复（含应用重启）不建第二个根，新 span 挂历史根下', async () => {
    // 首跑：建根 + 一个 llm，收尾
    pipeline.beginTrace({ traceId: 'task-1', kind: 'task', title: '任务', source: 'qoder' })
    const root = pipeline.ensureRootSpan('task-1', { type: 'task.run', name: '任务执行' })
    const llm1 = pipeline.startSpan('task-1', { type: 'llm.generate', name: 'qoder-lite' })
    pipeline.endSpan('task-1', llm1)
    pipeline.endTrace('task-1')

    // 模拟应用重启后恢复：全新 pipeline（内存标记全丢），同一 storage
    const restarted = new TracePipeline(storage, (event) => live.push(event))
    restarted.beginTrace({ traceId: 'task-1', kind: 'task', title: '任务', source: 'qoder' })
    const root2 = restarted.ensureRootSpan('task-1', { type: 'task.run', name: '任务执行' })
    expect(root2.spanId).toBe(root.spanId) // 复用历史根，不新建
    const llm2 = restarted.startSpan('task-1', { type: 'llm.generate', name: 'qoder-lite' })
    expect(llm2.parentSpanId).toBe(root.spanId) // 新 span 挂历史根下，树不断裂
    restarted.endSpan('task-1', llm2)
    restarted.endTrace('task-1')

    const spans = await storage.getTrace('task-1')
    expect(spans!.filter((s) => s.type === 'task.run')).toHaveLength(1) // 无第二个根
    expect(spans!.filter((s) => s.type === 'llm.generate')).toHaveLength(2)
  })

  it('endTrace 摘要基于全量快照：跨恢复累计 token / spanCount（不丢首跑数据）', async () => {
    // 首跑：100 + 50
    pipeline.beginTrace({ traceId: 'task-2', kind: 'task', title: '任务', source: 'qoder' })
    pipeline.ensureRootSpan('task-2', { type: 'task.run', name: '任务执行' })
    const llm1 = pipeline.startSpan('task-2', { type: 'llm.generate', name: 'qoder-lite', model: 'qoder-lite' })
    pipeline.endSpan('task-2', llm1, { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } })
    const first = pipeline.endTrace('task-2')
    expect(first!.tokens?.total).toBe(150)

    // 恢复执行：再跑一轮，再次 finalize
    const restarted = new TracePipeline(storage)
    restarted.beginTrace({ traceId: 'task-2', kind: 'task', title: '任务', source: 'qoder' })
    restarted.ensureRootSpan('task-2', { type: 'task.run', name: '任务执行' })
    const llm2 = restarted.startSpan('task-2', { type: 'llm.generate', name: 'qoder-lite', model: 'qoder-lite' })
    restarted.endSpan('task-2', llm2, { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } })
    const second = restarted.endTrace('task-2')

    // 跨恢复累计：两轮的 token 都在，span 数含首跑
    expect(second!.tokens?.total).toBe(300)
    expect(second!.spanCount).toBe(3) // 根 + 两个 llm
  })

  it('重开时把旧摘要刷新为 running（恢复执行期间列表显示"进行中"），收尾后回到 ended', async () => {
    pipeline.beginTrace({ traceId: 'task-3', kind: 'task', title: '任务', source: 'qoder' })
    pipeline.ensureRootSpan('task-3', { type: 'task.run', name: '任务执行' })
    pipeline.endTrace('task-3')
    expect(storage.readSummary('task-3')!.status).toBe('ended')

    // 恢复：beginTrace 命中已有摘要 → 刷新 running（历史指标保留）
    const restarted = new TracePipeline(storage)
    restarted.beginTrace({ traceId: 'task-3', kind: 'task', title: '任务', source: 'qoder' })
    const during = storage.readSummary('task-3')!
    expect(during.status).toBe('running')
    expect(during.spanCount).toBe(1) // 历史累计指标保留

    restarted.endTrace('task-3')
    expect(storage.readSummary('task-3')!.status).toBe('ended')
  })

  it('endSpan 支持 endedAt 覆盖（lastMessageAt 收尾悬挂 span）', async () => {
    pipeline.beginTrace({ traceId: 'task-4', kind: 'task', title: '任务', source: 'qoder' })
    pipeline.ensureRootSpan('task-4', { type: 'task.run', name: '任务执行' })
    const tool = pipeline.startSpan('task-4', { type: 'tool.execute', name: 'grep' })
    const staleEndedAt = Date.now() - 5000
    pipeline.endSpan('task-4', tool, { status: 'cancelled', endedAt: staleEndedAt })
    pipeline.endTrace('task-4')

    const spans = await storage.getTrace('task-4')
    const t = spans!.find((s) => s.type === 'tool.execute')!
    expect(t.endedAt).toBe(staleEndedAt)
    // endedAt 早于 startedAt 时 durationMs 钳为 0（finalizeSpanDuration 的下限保护）
    expect(t.durationMs).toBe(0)
  })
})

describe('QoderTraceBuilder', () => {
  it('assistant 消息 → llm + tool 成对 span，usage 正确', async () => {
    pipeline.beginTrace({ traceId: 'q1', kind: 'chat', title: 'qoder 提问', source: 'qoder' })
    pipeline.startSpan('q1', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q1', 'chat')

    builder.onMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '先看一下代码' },
          { type: 'tool_use', id: 'tc1', name: 'bash', input: { cmd: 'ls' } },
          { type: 'tool_result', tool_use_id: 'tc1', content: 'file.ts', is_error: false },
          { type: 'text', text: '完成了' }
        ],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }
      }
    })
    builder.onMessage({ type: 'result', result: '完成', total_cost_usd: 0.001 })
    pipeline.endTrace('q1')

    const spans = await storage.getTrace('q1')
    const types = spans!.map((s) => s.type)
    expect(types).toContain('llm.generate')
    expect(types).toContain('tool.execute')
    const tool = spans!.find((s) => s.type === 'tool.execute')!
    expect(tool.parentSpanId).toBe(spans!.find((s) => s.type === 'llm.generate')!.spanId) // 挂 llm 栈顶
    expect(tool.input).toEqual({ cmd: 'ls' })
    expect(tool.output).toBe('file.ts')
    const llm = spans!.find((s) => s.type === 'llm.generate')!
    expect(llm.usage?.inputTokens).toBe(100)
    expect(llm.usage?.cacheRead).toBe(10)
  })

  it('subtask 三件套 → subtask.run span', async () => {
    pipeline.beginTrace({ traceId: 'q2', kind: 'task', title: '任务', source: 'qoder' })
    pipeline.startSpan('q2', { type: 'task.run', name: '任务' })
    const builder = new QoderTraceBuilder(pipeline, 'q2', 'task')
    builder.onMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub1',
      description: '实现登录',
      task_type: 'implement'
    })
    builder.onMessage({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'sub1',
      last_tool_name: 'edit_file',
      description: '改代码'
    })
    builder.onMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'sub1',
      status: 'success',
      summary: '完成'
    })
    pipeline.endTrace('q2')

    const spans = await storage.getTrace('q2')
    const sub = spans!.find((s) => s.type === 'subtask.run')!
    expect(sub.name).toBe('实现登录')
    expect(sub.status).toBe('completed')
    expect(sub.meta?.summary).toBe('完成')
  })

  it('同 callId 去重：content_block_start 与 assistant 快照复用同一 span，input 回填', async () => {
    pipeline.beginTrace({ traceId: 'q4', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q4', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q4', 'chat')
    // 流式 start：SDK 常给空 input，index 注册
    builder.onMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tc-dup', name: 'glob', input: {} }
      }
    })
    // assistant 全量快照再次出现同 callId：必须复用而非重复建 span
    builder.onMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tc-dup', name: 'glob', input: { pattern: '**/*.ts' } },
          { type: 'tool_result', tool_use_id: 'tc-dup', content: ['a.ts'], is_error: false }
        ]
      }
    })
    builder.onMessage({ type: 'result' })
    pipeline.endTrace('q4')

    const spans = await storage.getTrace('q4')
    const tools = spans!.filter((s) => s.type === 'tool.execute')
    expect(tools).toHaveLength(1) // 不重复建 span
    expect(tools[0]!.input).toEqual({ pattern: '**/*.ts' }) // 快照回填
    expect(tools[0]!.status).toBe('completed') // 不因旧 span 残留而悬挂
  })

  it('tool_use input 为 null 时不抛异常、工具 span 正常落库（Object.keys(null) 会中断采集）', async () => {
    pipeline.beginTrace({ traceId: 'q4b', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q4b', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q4b', 'chat')
    // Anthropic 协议允许 input 为 null：startTool 透传 null 后 endTool 的 inputEmpty 判断
    // 不能对 null 调 Object.keys，否则抛 TypeError → 本条消息 span 采集失败（Trace 数据缺失）。
    builder.onMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tc-null', name: 'glob', input: null }
      }
    })
    builder.onMessage({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tc-null', content: ['a.ts'] }] }
    })
    builder.onMessage({ type: 'result' })
    pipeline.endTrace('q4b')

    const spans = await storage.getTrace('q4b')
    const tools = spans!.filter((s) => s.type === 'tool.execute')
    expect(tools).toHaveLength(1)
    expect(tools[0]!.status).toBe('completed') // 正常收尾不悬挂
  })

  it('input_json_delta 累积回填：start 无 input 的工具结束时不缺参数', async () => {
    pipeline.beginTrace({ traceId: 'q5', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q5', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q5', 'chat')
    builder.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc-glob', name: 'glob' } }
    })
    builder.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pattern"' } }
    })
    builder.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"**/*.ts"}' } }
    })
    builder.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tc-glob', name: 'glob' }] } })
    builder.onMessage({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tc-glob', content: ['a.ts'] }] }
    })
    builder.onMessage({ type: 'result' })
    pipeline.endTrace('q5')

    const spans = await storage.getTrace('q5')
    const tool = spans!.find((s) => s.type === 'tool.execute')!
    expect(tool.input).toEqual({ pattern: '**/*.ts' }) // 累积解析后回填，而非 {} 占位
  })

  it('全量 assistant 文本覆盖流式碎片（超集替换，不重复拼接）', async () => {
    pipeline.beginTrace({ traceId: 'q6', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q6', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q6', 'chat')
    builder.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '正在' } }
    })
    builder.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '分析' } }
    })
    // 全量快照包含已累积内容 → 整体替换，避免「正在分析正在分析代码」
    builder.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '正在分析代码' }] } })
    builder.onMessage({ type: 'result' })
    pipeline.endTrace('q6')

    const spans = await storage.getTrace('q6')
    const llm = spans!.find((s) => s.type === 'llm.generate')!
    expect(llm.output).toBe('正在分析代码')
  })

  it('task_started 滞后：内部 span 不改写 parentSpanId，meta.parentToolUseId 原样落盘（渲染层重定向）', async () => {
    pipeline.beginTrace({ traceId: 'q7', kind: 'task', title: '任务', source: 'qoder' })
    pipeline.startSpan('q7', { type: 'task.run', name: '任务' })
    const builder = new QoderTraceBuilder(pipeline, 'q7', 'task')
    // 委派工具（顶层消息，无 parent_tool_use_id）
    builder.onMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tc-delegate', name: 'task', input: { description: '实现登录' } }] }
    })
    // 子代理内部流：parent_tool_use_id 指向委派工具，llm + 工具完整走完
    builder.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '开始' } },
      parent_tool_use_id: 'tc-delegate'
    })
    builder.onMessage({
      type: 'assistant',
      message: {
        parent_tool_use_id: 'tc-delegate',
        content: [
          { type: 'tool_use', id: 'tc-inner', name: 'edit_file', input: { path: 'a.ts' } },
          { type: 'tool_result', tool_use_id: 'tc-inner', content: 'ok', is_error: false }
        ]
      }
    })
    builder.onMessage({ type: 'result', parent_tool_use_id: 'tc-delegate' })
    // task_started 滞后到达：内部 span 保持当时的锚点 parentSpanId，不再事后改写
    builder.onMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub-late',
      description: '实现登录',
      tool_use_id: 'tc-delegate'
    })
    builder.onMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'sub-late',
      status: 'success',
      summary: '完成'
    })
    pipeline.endTrace('q7')

    const spans = await storage.getTrace('q7')
    const sub = spans!.find((s) => s.type === 'subtask.run')!
    expect(sub.meta?.toolUseId).toBe('tc-delegate') // 委派工具 callId 落盘,执行面板吸收用
    const taskRoot = spans!.find((s) => s.type === 'task.run')!
    const llms = spans!.filter((s) => s.type === 'llm.generate')
    // 委派回合是纯 tool_use 回合（无文本），不再产生 0ms 空 llm span —— 只剩子代理内部 llm
    expect(llms).toHaveLength(1)
    // 数据诚实化：内部 llm 的 parentSpanId 是创建时的锚点（任务根），不被事后改写；
    // 真实归属由 meta.parentToolUseId 落盘，渲染层据此重定向进 subtask。
    expect(llms[0]!.parentSpanId).toBe(taskRoot.spanId)
    expect(llms[0]!.meta?.parentToolUseId).toBe('tc-delegate')
    const innerTool = spans!.find((s) => s.meta?.toolCallId === 'tc-inner')!
    expect(innerTool.parentSpanId).toBe(llms[0]!.spanId) // 已收尾 tool 保持挂内部 llm 下（嵌套保留）
    expect(innerTool.meta?.parentToolUseId).toBe('tc-delegate')
    const delegate = spans!.find((s) => s.meta?.toolCallId === 'tc-delegate')!
    expect(delegate.parentSpanId).toBe(taskRoot.spanId) // 委派工具无 llm 锚点，挂任务根
  })

  it('纯 tool_use 回合不产生 llm span（0ms 空记录根因回归）', async () => {
    pipeline.beginTrace({ traceId: 'q8', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q8', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q8', 'chat')
    // 连续三个纯工具回合（assistant 只有 tool_use / tool_result，无文本、无 thinking）
    for (let i = 0; i < 3; i += 1) {
      builder.onMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: `tc-${i}`, name: 'grep', input: { pattern: 'x' } }] }
      })
      builder.onMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: `tc-${i}`, content: 'hit' }] }
      })
    }
    builder.onMessage({ type: 'result' })
    pipeline.endTrace('q8')

    const spans = await storage.getTrace('q8')
    expect(spans!.filter((s) => s.type === 'llm.generate')).toHaveLength(0)
    expect(spans!.filter((s) => s.type === 'tool.execute')).toHaveLength(3)
    // 工具无 llm 锚点时挂会话根，不平级堆叠
    const root = spans!.find((s) => s.type === 'session.start')!
    for (const tool of spans!.filter((s) => s.type === 'tool.execute')) {
      expect(tool.parentSpanId).toBe(root.spanId)
    }
  })

  it('result 消息 usage 补录到已结束的 llm span（usage 丢失回归）', async () => {
    pipeline.beginTrace({ traceId: 'q9', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q9', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q9', 'chat')
    // assistant 不带 usage，usage 只出现在 result 消息（llm span 此时已 end）
    builder.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } })
    // SDK 真实形状：result 字段是文本结论，usage/total_cost_usd 在消息顶层。
    builder.onMessage({
      type: 'result',
      result: '你好',
      usage: { input_tokens: 200, output_tokens: 80 },
      total_cost_usd: 0.002
    })
    pipeline.endTrace('q9')

    const spans = await storage.getTrace('q9')
    const llm = spans!.find((s) => s.type === 'llm.generate')!
    expect(llm.usage?.inputTokens).toBe(200)
    expect(llm.usage?.outputTokens).toBe(80)
    expect(llm.usage?.costUsd).toBe(0.002) // total_cost_usd 补录成功
  })

  it('result 顶层 usage 缺失时按 modelUsage 分桶求和兜底', async () => {
    pipeline.beginTrace({ traceId: 'q9b', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q9b', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q9b', 'chat')
    builder.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } })
    builder.onMessage({
      type: 'result',
      result: '你好',
      modelUsage: {
        'claude-sonnet-4.5': { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 10, costUSD: 0.001 },
        'qoder-lite': { inputTokens: 50, outputTokens: 20, costUSD: 0.0005 }
      }
    })
    pipeline.endTrace('q9b')

    const spans = await storage.getTrace('q9b')
    const llm = spans!.find((s) => s.type === 'llm.generate')!
    expect(llm.usage?.inputTokens).toBe(150)
    expect(llm.usage?.outputTokens).toBe(60)
    expect(llm.usage?.cacheRead).toBe(10)
    expect(llm.usage?.totalTokens).toBe(220)
    expect(llm.usage?.costUsd).toBeCloseTo(0.0015, 6) // 分桶 costUSD 合计
  })

  it('setTurnInput 记录为本回合首个 llm span 的 input（关键词提取/记忆整理 Prompt 可见）', async () => {
    pipeline.beginTrace({ traceId: 'q9c', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q9c', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q9c', 'chat', 'qoder', 'qoder-lite', '关键词提取')
    builder.setTurnInput('请从下面的文本中提取关键词：修复登录页样式')
    builder.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '["登录页","样式"]' }] } })
    pipeline.endTrace('q9c')

    const spans = await storage.getTrace('q9c')
    const llm = spans!.find((s) => s.type === 'llm.generate')!
    expect(llm.name).toBe('关键词提取')
    expect(llm.input).toBe('请从下面的文本中提取关键词：修复登录页样式')
  })

  it('thinking 块与 text 块分条到达 → 归入同一 llm span（不再按 content block 拆分）', async () => {
    pipeline.beginTrace({ traceId: 'q10', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q10', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q10', 'chat')
    // SDK 真实行为：每个 content block 各发一条 assistant 消息（先 thinking 块、后 text 块）
    builder.onMessage({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '先看一下错误日志' }] } })
    builder.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '定位到原因了' }] } })
    builder.onMessage({ type: 'result', result: '定位到原因了' })
    pipeline.endTrace('q10')

    const spans = await storage.getTrace('q10')
    const llms = spans!.filter((s) => s.type === 'llm.generate')
    expect(llms).toHaveLength(1) // thinking 与 text 同 span 展示，不拆成两条
    // thinking 与正文同 span：output 为 { thinking, text } 结构
    expect(llms[0]!.output).toEqual({ thinking: '先看一下错误日志', text: '定位到原因了' })
  })

  it('tool_use 回合：llm 在 step 边界收尾，工具 span 挂刚收尾的 llm', async () => {
    pipeline.beginTrace({ traceId: 'q11', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q11', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q11', 'chat')
    // text 与 tool_use 同一条 assistant：先累积 text 进当前 llm，工具边界收尾该 llm
    builder.onMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '我来查一下' },
          { type: 'tool_use', id: 'tc-step', name: 'grep', input: { pattern: 'foo' } }
        ],
        usage: { input_tokens: 30, output_tokens: 10 }
      }
    })
    builder.onMessage({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tc-step', content: 'hit' }] }
    })
    // 工具结果后的新一轮文本 → 新 llm span（不与上一轮合并）
    builder.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '完成了' }] } })
    builder.onMessage({ type: 'result' })
    pipeline.endTrace('q11')

    const spans = await storage.getTrace('q11')
    const llms = spans!.filter((s) => s.type === 'llm.generate')
    expect(llms).toHaveLength(2)
    const tool = spans!.find((s) => s.type === 'tool.execute')!
    expect(tool.parentSpanId).toBe(llms[0]!.spanId) // 挂 step 边界刚收尾的 llm
    expect(llms[0]!.output).toBe('我来查一下')
    expect(llms[0]!.usage?.inputTokens).toBe(30)
    expect(llms[1]!.output).toBe('完成了')
  })

  it('子代理内部 llm → tool 嵌套：不改写 parentSpanId，内部父子关系与归属 meta 并存', async () => {
    pipeline.beginTrace({ traceId: 'q10', kind: 'task', title: '任务', source: 'qoder' })
    pipeline.startSpan('q10', { type: 'task.run', name: '任务' })
    const builder = new QoderTraceBuilder(pipeline, 'q10', 'task')
    // 委派回合（纯工具，无 llm）
    builder.onMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tc-delegate', name: 'Agent', input: { description: '探索' } }] }
    })
    // 子代理内部：有文本回合 → llm 创建，工具挂该 llm 下
    builder.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '开始' } },
      parent_tool_use_id: 'tc-delegate'
    })
    builder.onMessage({
      type: 'assistant',
      message: {
        parent_tool_use_id: 'tc-delegate',
        content: [
          { type: 'text', text: '开始' },
          { type: 'tool_use', id: 'tc-inner', name: 'grep', input: { pattern: 'x' } },
          { type: 'tool_result', tool_use_id: 'tc-inner', content: 'hit', is_error: false }
        ]
      }
    })
    // task_started 滞后：内部 llm 保持创建时锚点，归属由 meta.parentToolUseId 表达
    builder.onMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub-nest',
      description: '探索',
      tool_use_id: 'tc-delegate'
    })
    builder.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'sub-nest', status: 'success' })
    pipeline.endTrace('q10')

    const spans = await storage.getTrace('q10')
    const sub = spans!.find((s) => s.type === 'subtask.run')!
    const taskRoot = spans!.find((s) => s.type === 'task.run')!
    const innerLlm = spans!.find((s) => s.type === 'llm.generate')!
    const innerTool = spans!.find((s) => s.meta?.toolCallId === 'tc-inner')!
    expect(innerLlm.parentSpanId).toBe(taskRoot.spanId) // 创建时的锚点，不改写
    expect(innerLlm.meta?.parentToolUseId).toBe('tc-delegate') // 渲染层据此重定向挂 subtask
    expect(sub.meta?.toolUseId).toBe('tc-delegate')
    expect(innerTool.parentSpanId).toBe(innerLlm.spanId) // 工具保持挂 llm 下（嵌套）
    expect(innerLlm.output).toBe('开始')
  })

  it('悬挂工具 span 在 result 到达时以 lastMessageAt 收尾（不等 finish()，消除假时长）', async () => {
    pipeline.beginTrace({ traceId: 'q11', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q11', { type: 'session.start', name: '会话' })
    const builder = new QoderTraceBuilder(pipeline, 'q11', 'chat')
    builder.onMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tc-hang', name: 'grep', input: { pattern: 'x' } }] }
    })
    // tool_result 被 SDK 丢弃（不送达）；result 到达时兜底收尾，endedAt = result 到达时刻
    builder.onMessage({ type: 'result' })
    const afterResult = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 30))
    builder.finish() // finish 不应再改写已兜底收尾的 endedAt
    pipeline.endTrace('q11')

    const spans = await storage.getTrace('q11')
    const tool = spans!.find((s) => s.meta?.toolCallId === 'tc-hang')!
    expect(tool.status).toBe('cancelled')
    expect(tool.endedAt).toBeDefined()
    // 若悬到 finish() 才收尾，endedAt 会 ≈ afterResult + 30ms
    expect(tool.endedAt!).toBeLessThanOrEqual(afterResult)
  })

  it('stream_event 流 → 文本累积到 llm output', async () => {
    pipeline.beginTrace({ traceId: 'q3', kind: 'chat', title: 'x', source: 'qoder' })
    pipeline.startSpan('q3', { type: 'session.start', name: '会话' })
    // modelName 透传:qoder 驱动把真实模型(qoder:lite 去前缀)传给 builder
    const builder = new QoderTraceBuilder(pipeline, 'q3', 'chat', 'qoder', 'qoder-lite')
    builder.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } }
    })
    builder.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } }
    })
    builder.onMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'a.ts' } }
      }
    })
    builder.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '！' } }
    })
    builder.onMessage({ type: 'result' })
    pipeline.endTrace('q3')

    const spans = await storage.getTrace('q3')
    const llm = spans!.find((s) => s.type === 'llm.generate')!
    expect(llm.output).toBe('你好！')
    expect(llm.model).toBe('qoder-lite') // builder modelName 落到 llm span,不再写死占位名
    expect(spans!.some((s) => s.type === 'tool.execute')).toBe(true)
  })
})

describe('PiTraceBuilder', () => {
  it('Pi 事件 → agent/llm/tool span 树', async () => {
    pipeline.beginTrace({ traceId: 'p1', kind: 'task', title: 'Pi 任务', source: 'pi' })
    pipeline.startSpan('p1', { type: 'task.run', name: '任务' })
    const builder = new PiTraceBuilder(pipeline, 'p1', 'task')
    builder.onEvent({ type: 'agent_start', phase: 'implementing' })
    builder.onEvent({ type: 'message_start', message: { model: 'gpt-4o' } })
    builder.onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '正在' } })
    builder.onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '处理' } })
    builder.onEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'end_turn',
        usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
        content: '处理完成'
      }
    })
    builder.onEvent({ type: 'tool_execution_start', toolCallId: 'tc-p1', toolName: 'bash', args: { cmd: 'pwd' } })
    builder.onEvent({ type: 'tool_execution_end', toolCallId: 'tc-p1', result: '/repo', isError: false })
    builder.onEvent({ type: 'agent_end' })
    pipeline.endTrace('p1')

    const spans = await storage.getTrace('p1')
    const agent = spans!.find((s) => s.type === 'agent.run')!
    const llm = spans!.find((s) => s.type === 'llm.generate')!
    const tool = spans!.find((s) => s.type === 'tool.execute')!
    expect(agent.name).toBe('Agent implementing')
    expect(llm.model).toBe('gpt-4o')
    expect(llm.output).toBe('处理完成')
    expect(llm.usage?.totalTokens).toBe(280)
    expect(llm.parentSpanId).toBe(agent.spanId)
    expect(tool.parentSpanId).toBe(agent.spanId) // Pi 工具执行在 message_end 之后，父级为 agent.run
    expect(tool.output).toBe('/repo')
  })

  it('message_end 错误 → llm span 标记 error', async () => {
    pipeline.beginTrace({ traceId: 'p2', kind: 'task', title: 'x', source: 'pi' })
    pipeline.startSpan('p2', { type: 'task.run', name: '任务' })
    const builder = new PiTraceBuilder(pipeline, 'p2', 'task')
    builder.onEvent({ type: 'message_start' })
    builder.onEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'boom' } })
    pipeline.endTrace('p2')
    const spans = await storage.getTrace('p2')
    const llm = spans!.find((s) => s.type === 'llm.generate')!
    expect(llm.status).toBe('error')
    expect(llm.error?.message).toBe('boom')
  })
})
