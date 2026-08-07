import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { QoderTraceSink, parseQoderTraceFile } from './qoder-trace.js'

const roots: string[] = []
function temporaryRoot() {
  const root = join(tmpdir(), `coding-agent-qoder-trace-${crypto.randomUUID()}`)
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('qoder-trace', () => {
  it('Sink 落盘 + 解析：thinking / tool_use / tool_result / 文本碎片合并 / result 汇总', async () => {
    const dataDir = temporaryRoot()
    const sink = new QoderTraceSink(dataDir)
    const lines = [
      {
        t: '2025-01-01T00:00:00.000Z',
        taskId: 't1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先分析' } }
        }
      },
      {
        t: '2025-01-01T00:00:00.100Z',
        taskId: 't1',
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tc1', name: 'read', input: { path: 'a.ts' } }
          }
        }
      },
      {
        t: '2025-01-01T00:00:00.200Z',
        taskId: 't1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } }
        }
      },
      {
        t: '2025-01-01T00:00:00.300Z',
        taskId: 't1',
        message: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '世界' } }
        }
      },
      { t: '2025-01-01T00:00:00.400Z', taskId: 't1', message: { type: 'tool_result' } },
      {
        t: '2025-01-01T00:00:00.500Z',
        taskId: 't1',
        message: {
          type: 'result',
          result: {
            duration_ms: 5000,
            num_turns: 2,
            total_cost_usd: 0.05,
            modelUsage: { 'qoder:mmodel': { inputTokens: 100, outputTokens: 50, costUSD: 0.05 } }
          }
        }
      }
    ]
    for (const line of lines) sink.append('t1', line.message)

    const entries = await parseQoderTraceFile(dataDir, 't1')
    const types = entries.map((e) => `${e.type}:${e.title}`)
    // thinking 一条
    expect(types).toContain('thinking:思考')
    // tool_use → tool_call
    expect(types).toContain('tool_call:工具 read')
    expect(entries.find((e) => e.type === 'tool_call')?.detail).toContain('a.ts')
    // 文本碎片合并为一条
    const messages = entries.filter((e) => e.type === 'message' && e.title === 'AI')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.detail).toBe('你好世界')
    // result 汇总
    const done = entries.find((e) => e.type === 'status' && e.title === 'Qoder 会话结束')
    expect(done).toBeDefined()
    expect(done?.payload).toMatchObject({
      tokens: { input: 100, output: 50 },
      costUsd: 0.05,
      durationMs: 5000,
      turns: 2
    })
  })

  it('assistant 完整消息（content blocks + usage）映射', async () => {
    const dataDir = temporaryRoot()
    const file = join(dataDir, 'traces', 'qoder')
    mkdirSync(file, { recursive: true })
    writeFileSync(
      join(file, 't2.jsonl'),
      `${JSON.stringify({
        t: '2025-01-01T00:00:00.000Z',
        taskId: 't2',
        message: {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: '推理过程' },
              { type: 'text', text: '回答文本' },
              { type: 'tool_use', id: 'tc2', name: 'edit', input: { path: 'b.ts' } }
            ],
            usage: { input_tokens: 10, output_tokens: 5 }
          }
        }
      })}\n`,
      'utf8'
    )
    const entries = await parseQoderTraceFile(dataDir, 't2')
    expect(entries.map((e) => e.type)).toContain('thinking')
    expect(entries.map((e) => e.type)).toContain('message')
    expect(entries.map((e) => e.type)).toContain('tool_call')
    expect(entries.find((e) => e.type === 'message')?.payload).toMatchObject({ usage: { input_tokens: 10 } })
  })

  it('文件缺失返回空数组', async () => {
    expect(await parseQoderTraceFile(temporaryRoot(), 'nope')).toEqual([])
  })

  it('损坏行不中断解析', async () => {
    const dataDir = temporaryRoot()
    const sink = new QoderTraceSink(dataDir)
    sink.append('t3', {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
    })
    const file = join(dataDir, 'traces', 'qoder', 't3.jsonl')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nnot-json{{\n`, 'utf8')
    const entries = await parseQoderTraceFile(dataDir, 't3')
    expect(entries.length).toBeGreaterThan(0)
  })
})
