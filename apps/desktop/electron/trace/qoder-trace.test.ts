import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { QoderTraceSink, parseQoderTraceFile } from './qoder-trace.js'

const roots: string[] = []
function temporaryRoot() {
  const root = join(tmpdir(), `task-pipeline-qoder-trace-${crypto.randomUUID()}`)
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

  // Qoder SDK 把工具回传放进 user 消息(标准 Claude API 形态),content 是 tool_result 块数组。
  // 原实现把所有 user 消息都序列化成一条“用户”消息,工具结果彻底丢失 —— 这是 trace 里
  // 看到“工具执行了但没内容”的根因。这里锁住新行为: tool_result 块独立成条,
  // 字符串 / text 块走原路径,空数组兜底走 JSON.stringify。
  it('user 消息里的 tool_result 块拆成独立 tool_result 条目', async () => {
    const dataDir = temporaryRoot()
    const file = join(dataDir, 'traces', 'qoder')
    mkdirSync(file, { recursive: true })
    writeFileSync(
      join(file, 't4.jsonl'),
      [
        {
          t: '2025-01-01T00:00:00.000Z',
          taskId: 't4',
          message: {
            type: 'user',
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 'tc1', content: '文件内容: hello', is_error: false },
                { type: 'tool_result', tool_use_id: 'tc2', content: 'stack trace...', is_error: true }
              ]
            }
          }
        },
        {
          t: '2025-01-01T00:00:00.100Z',
          taskId: 't4',
          message: { type: 'user', message: { content: '附加用户指令' } }
        }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      'utf8'
    )
    const entries = await parseQoderTraceFile(dataDir, 't4')
    const toolResults = entries.filter((e) => e.type === 'tool_result')
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0]?.detail).toBe('文件内容: hello')
    expect(toolResults[0]?.payload).toMatchObject({ toolCallId: 'tc1', isError: false })
    expect(toolResults[1]?.payload).toMatchObject({ toolCallId: 'tc2', isError: true })
    const userMessage = entries.find((e) => e.type === 'message' && e.title === '用户')
    expect(userMessage?.detail).toBe('附加用户指令')
  })

  it('user 消息空数组兜底走 JSON.stringify,不丢消息', async () => {
    const dataDir = temporaryRoot()
    const sink = new QoderTraceSink(dataDir)
    sink.append('t5', { type: 'user', message: { content: [] } })
    const entries = await parseQoderTraceFile(dataDir, 't5')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.type).toBe('message')
    expect(entries[0]?.title).toBe('用户')
    expect(entries[0]?.detail).toBe('[]')
  })

  // 配对逻辑:工具调用和结果用同一个 toolCallId,合并到 tool_call 的 detail 里,
  // trace 时间线只出现“工具 call + 结果”一个事件,避免与其它消息混淆。
  it('同 toolCallId 的 tool_call 和 tool_result 合并为单条 tool_call 条目', async () => {
    const dataDir = temporaryRoot()
    const file = join(dataDir, 'traces', 'qoder')
    mkdirSync(file, { recursive: true })
    writeFileSync(
      join(file, 't6.jsonl'),
      [
        {
          t: '2025-01-01T00:00:00.000Z',
          taskId: 't6',
          message: {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: 'tc-bash', name: 'Bash', input: { command: 'ls -la' } }]
            }
          }
        },
        {
          t: '2025-01-01T00:00:00.100Z',
          taskId: 't6',
          message: {
            type: 'user',
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 'tc-bash', content: 'total 8\ndrwxr-xr-x 2 ...', is_error: false }
              ]
            }
          }
        }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      'utf8'
    )
    const entries = await parseQoderTraceFile(dataDir, 't6')
    // 配对后只剩一条 tool_call,独立的 tool_result 被吃掉
    expect(entries.filter((e) => e.type === 'tool_call')).toHaveLength(1)
    expect(entries.filter((e) => e.type === 'tool_result')).toHaveLength(0)
    const call = entries.find((e) => e.type === 'tool_call')
    expect(call?.title).toBe('工具 Bash')
    expect(call?.detail).toContain('ls -la')
    expect(call?.detail).toContain('--- 工具结果 ---')
    expect(call?.detail).toContain('total 8')
    expect(call?.detail).not.toContain('(失败)')
    const callPayload = call?.payload as { toolCallId: string; isError: boolean; result: string } | undefined
    expect(callPayload?.toolCallId).toBe('tc-bash')
    expect(callPayload?.isError).toBe(false)
    expect(callPayload?.result).toContain('total 8')
  })

  it('isError: true 合并时 detail 带“失败”标记', async () => {
    const dataDir = temporaryRoot()
    const file = join(dataDir, 'traces', 'qoder')
    mkdirSync(file, { recursive: true })
    writeFileSync(
      join(file, 't7.jsonl'),
      [
        {
          t: '2025-01-01T00:00:00.000Z',
          taskId: 't7',
          message: {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 'tc-err', name: 'Bash', input: { command: 'false' } }] }
          }
        },
        {
          t: '2025-01-01T00:00:00.100Z',
          taskId: 't7',
          message: {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'tc-err', content: 'error: exit 1', is_error: true }]
            }
          }
        }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      'utf8'
    )
    const entries = await parseQoderTraceFile(dataDir, 't7')
    const call = entries.find((e) => e.type === 'tool_call')
    expect(call?.detail).toContain('--- 工具结果 (失败) ---')
    expect((call?.payload as { isError: boolean } | undefined)?.isError).toBe(true)
  })

  it('stream_event 的 input={} 占位 tool_call 被 assistant 完整消息合并(不残留空输入)', async () => {
    const dataDir = temporaryRoot()
    const file = join(dataDir, 'traces', 'qoder')
    mkdirSync(file, { recursive: true })
    writeFileSync(
      join(file, 't9.jsonl'),
      [
        {
          t: '2025-01-01T00:00:00.000Z',
          taskId: 't9',
          message: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              content_block: { type: 'tool_use', id: 'tc-read', name: 'Read', input: {} }
            }
          }
        },
        {
          t: '2025-01-01T00:00:00.100Z',
          taskId: 't9',
          message: {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: 'tc-read', name: 'Read', input: { file_path: '/tmp/a.ts' } }]
            }
          }
        }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      'utf8'
    )
    const entries = await parseQoderTraceFile(dataDir, 't9')
    // 同 id 重复 tool_call 合并为一条,完整 input 覆盖 {} 占位
    const calls = entries.filter((e) => e.type === 'tool_call')
    expect(calls).toHaveLength(1)
    expect((calls[0]!.payload as { input?: unknown }).input).toEqual({ file_path: '/tmp/a.ts' })
    expect(calls[0]!.detail).toContain('/tmp/a.ts')
  })

  it('tool_result 的 content 块数组提取 text 拼接(不展示原始 JSON)', async () => {
    const dataDir = temporaryRoot()
    const file = join(dataDir, 'traces', 'qoder')
    mkdirSync(file, { recursive: true })
    writeFileSync(
      join(file, 't10.jsonl'),
      [
        {
          t: '2025-01-01T00:00:00.000Z',
          taskId: 't10',
          message: {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 'tc-grep', name: 'Grep', input: { pattern: 'foo' } }] }
          }
        },
        {
          t: '2025-01-01T00:00:00.100Z',
          taskId: 't10',
          message: {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tc-grep',
                  content: [
                    { type: 'text', text: 'index.ts:1:foo' },
                    { type: 'text', text: 'main.ts:2:foo' }
                  ],
                  is_error: false
                }
              ]
            }
          }
        }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      'utf8'
    )
    const entries = await parseQoderTraceFile(dataDir, 't10')
    const call = entries.find((e) => e.type === 'tool_call')
    const result = (call?.payload as { result?: string } | undefined)?.result
    expect(result).toBe('index.ts:1:foo\nmain.ts:2:foo')
    expect(result).not.toContain('"type"')
  })

  it('找不到配对 tool_call 的孤儿 tool_result 保留为独立条目', async () => {
    const dataDir = temporaryRoot()
    const file = join(dataDir, 'traces', 'qoder')
    mkdirSync(file, { recursive: true })
    writeFileSync(
      join(file, 't8.jsonl'),
      [
        {
          t: '2025-01-01T00:00:00.000Z',
          taskId: 't8',
          message: {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'tc-orphan', content: '孤立结果', is_error: false }]
            }
          }
        }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      'utf8'
    )
    const entries = await parseQoderTraceFile(dataDir, 't8')
    expect(entries.filter((e) => e.type === 'tool_result')).toHaveLength(1)
    expect(entries[0]?.detail).toBe('孤立结果')
  })

  // 子任务场景：task_started 在主流程发出，task_use_id 指向主流程那条 tool_use;
  // 后续子任务内消息通过 parent_tool_use_id 反查落进该子任务。
  // 这里锁住：task_started 自身归主流程、task_progress 标 taskId、task_notification 标 taskId,
  // 且子任务内 tool_call 的 parentTaskId 反查正确。
  it('子任务消息按 parent_tool_use_id 反查 task_started, 装入对应子任务', async () => {
    const dataDir = temporaryRoot()
    const file = join(dataDir, 'traces', 'qoder')
    mkdirSync(file, { recursive: true })
    writeFileSync(
      join(file, 't9.jsonl'),
      [
        // 主流程: top-level tool_use "tc-explore" 触发子任务
        {
          t: '2025-01-01T00:00:00.000Z',
          taskId: 't9',
          message: {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: 'tc-explore', name: 'Agent', input: { task: '查找' } }]
            }
          }
        },
        // 子任务起点(归主流程,作为折叠卡 header)
        {
          t: '2025-01-01T00:00:00.050Z',
          taskId: 't9',
          message: {
            type: 'system',
            subtype: 'task_started',
            task_id: 'sub-1',
            tool_use_id: 'tc-explore',
            task_type: 'Explore',
            description: '在仓库里搜发票相关代码'
          }
        },
        // 子任务内: tool_use (parent_tool_use_id = tc-explore)
        {
          t: '2025-01-01T00:00:00.100Z',
          taskId: 't9',
          message: {
            type: 'assistant',
            parent_tool_use_id: 'tc-explore',
            message: { content: [{ type: 'tool_use', id: 'tc-bash', name: 'Bash', input: { command: 'ls' } }] }
          }
        },
        // 子任务内: tool_result 回传
        {
          t: '2025-01-01T00:00:00.150Z',
          taskId: 't9',
          message: {
            type: 'user',
            parent_tool_use_id: 'tc-explore',
            message: { content: [{ type: 'tool_result', tool_use_id: 'tc-bash', content: 'file list' }] }
          }
        },
        // 子任务内: 中间进度(过程态)
        {
          t: '2025-01-01T00:00:00.200Z',
          taskId: 't9',
          message: {
            type: 'system',
            parent_tool_use_id: 'tc-explore',
            subtype: 'task_progress',
            task_id: 'sub-1',
            description: '已读 1 个文件',
            last_tool_name: 'Read',
            usage: { total_tokens: 1234, tool_uses: 1, duration_ms: 200 }
          }
        },
        // 子任务收尾
        {
          t: '2025-01-01T00:00:00.250Z',
          taskId: 't9',
          message: {
            type: 'system',
            parent_tool_use_id: 'tc-explore',
            subtype: 'task_notification',
            task_id: 'sub-1',
            status: 'completed',
            output_file: '/tmp/sub-1.txt',
            summary: '在 src/router/modules/InvoicePushMenu.tsx 找到主入口'
          }
        }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      'utf8'
    )
    const entries = await parseQoderTraceFile(dataDir, 't9')

    // 子任务起点: 自指 parentTaskId = taskId(让 groupByParentTask 把它识别为 group header)
    const started = entries.find((e) => e.sdkSubtype === 'task_started')
    expect(started).toBeDefined()
    expect(started?.parentTaskId).toBe('sub-1')
    expect(started?.taskId).toBe('sub-1')
    expect((started?.payload as { taskType?: string } | undefined)?.taskType).toBe('Explore')

    // 子任务内: tool_call(tc-bash) 被配对到主流程的 tc-bash 之前,所以独立成条;parentTaskId 反查成功
    const bashCall = entries.find((e) => e.type === 'tool_call' && e.title === '工具 Bash')
    expect(bashCall).toBeDefined()
    expect(bashCall?.parentTaskId).toBe('sub-1')

    // task_progress 在子任务内
    const progress = entries.find((e) => e.sdkSubtype === 'task_progress')
    expect(progress?.parentTaskId).toBe('sub-1')
    expect(progress?.taskId).toBe('sub-1')
    expect((progress?.payload as { lastToolName?: string } | undefined)?.lastToolName).toBe('Read')

    // task_notification 收尾
    const end = entries.find((e) => e.sdkSubtype === 'task_notification')
    expect(end?.parentTaskId).toBe('sub-1')
    expect((end?.payload as { status?: string } | undefined)?.status).toBe('completed')
  })

  // 工具配对: task_started 自身产生一个 tool_use 在主流程,子任务内嵌套的 tool_call/result 仍然
  // 走原来的 pairToolCalls 路径(同 toolCallId 配对),与子任务分组正交,不能互相干扰。
  it('子任务内的 tool_call 与 tool_result 仍然能配对,parentTaskId 保留', async () => {
    const dataDir = temporaryRoot()
    const file = join(dataDir, 'traces', 'qoder')
    mkdirSync(file, { recursive: true })
    writeFileSync(
      join(file, 't10.jsonl'),
      [
        {
          t: '2025-01-01T00:00:00.000Z',
          taskId: 't10',
          message: {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 'tc-outer', name: 'Agent', input: {} }] }
          }
        },
        {
          t: '2025-01-01T00:00:00.050Z',
          taskId: 't10',
          message: {
            type: 'system',
            subtype: 'task_started',
            task_id: 'sub-2',
            tool_use_id: 'tc-outer',
            task_type: 'Plan'
          }
        },
        {
          t: '2025-01-01T00:00:00.100Z',
          taskId: 't10',
          message: {
            type: 'assistant',
            parent_tool_use_id: 'tc-outer',
            message: { content: [{ type: 'tool_use', id: 'tc-inner', name: 'Read', input: { path: 'a.ts' } }] }
          }
        },
        {
          t: '2025-01-01T00:00:00.150Z',
          taskId: 't10',
          message: {
            type: 'user',
            parent_tool_use_id: 'tc-outer',
            message: { content: [{ type: 'tool_result', tool_use_id: 'tc-inner', content: '文件内容' }] }
          }
        }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      'utf8'
    )
    const entries = await parseQoderTraceFile(dataDir, 't10')
    const innerCall = entries.find((e) => e.type === 'tool_call' && e.title === '工具 Read')
    expect(innerCall).toBeDefined()
    expect(innerCall?.parentTaskId).toBe('sub-2')
    // 配对后 detail 里同时有 input 与 result
    expect(innerCall?.detail).toContain('a.ts')
    expect(innerCall?.detail).toContain('文件内容')
    expect(innerCall?.detail).toContain('--- 工具结果 ---')
  })

  // 容错: 出现未注册的 parent_tool_use_id(例如流式采集丢包导致 task_started 缺失)
  // 不能抛错,不能伪造归属,parentTaskId 保持 undefined(主流程兜底)。
  it('parent_tool_use_id 未命中已注册子任务时, 退化为主流程不报错', async () => {
    const dataDir = temporaryRoot()
    const file = join(dataDir, 'traces', 'qoder')
    mkdirSync(file, { recursive: true })
    writeFileSync(
      join(file, 't11.jsonl'),
      [
        {
          t: '2025-01-01T00:00:00.000Z',
          taskId: 't11',
          message: {
            type: 'assistant',
            parent_tool_use_id: 'tc-missing',
            message: { content: [{ type: 'text', text: 'A1' }] }
          }
        }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      'utf8'
    )
    const entries = await parseQoderTraceFile(dataDir, 't11')
    const msg = entries.find((e) => e.type === 'message' && e.title === 'AI')
    expect(msg).toBeDefined()
    expect(msg?.parentTaskId).toBeUndefined()
  })

  it('B2：appendChat 落盘到独立目录,parseQoderTraceFile(kind=chat) 解析为 kind=chat 条目', async () => {
    const dataDir = temporaryRoot()
    const sink = new QoderTraceSink(dataDir)
    sink.appendChat('chat-1', {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '对话里的思考' } }
    })
    sink.appendChat('chat-1', {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'c-tc1', name: 'Edit', input: { file_path: '/tmp/a.ts' } }] }
    })
    // 任务目录不出现 chat 数据
    expect(parseQoderTraceFile(dataDir, 'chat-1')).resolves.toEqual([])
    const entries = await parseQoderTraceFile(dataDir, 'chat-1', 'chat')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((e) => e.kind === 'chat')).toBe(true)
    expect(entries.every((e) => e.traceId === 'chat-1')).toBe(true)
    expect(entries.some((e) => e.type === 'thinking' && e.detail === '对话里的思考')).toBe(true)
    expect(entries.some((e) => e.type === 'tool_call' && e.title === '工具 Edit')).toBe(true)
    // 任务路径的 parseQoderTraceFile(kind=task) 不受影响
    expect(entries.some((e) => e.kind === 'task')).toBe(false)
  })
})
