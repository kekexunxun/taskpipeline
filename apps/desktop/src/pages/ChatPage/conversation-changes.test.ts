/**
 * conversation-changes 推导层单测:
 * 验证从消息 parts 推导「本次对话改了哪些文件」的核心规则。
 */

import { describe, expect, it } from 'vitest'
import { changeOperationKind, deriveConversationChanges, extractChangePath } from './conversation-changes'
import type { DriverPart, StoredMessage } from '@/api'

/** 构造 assistant 消息(parts 直接给定)。 */
function assistantMessage(id: string, parts: DriverPart[]): StoredMessage {
  return {
    id,
    role: 'assistant',
    createdAt: new Date().toISOString(),
    driverId: 'qoder',
    raw: null,
    parts
  }
}

function userMessage(id: string): StoredMessage {
  return {
    id,
    role: 'user',
    createdAt: new Date().toISOString(),
    driverId: 'qoder',
    raw: null,
    parts: [{ driverId: 'qoder', type: 'text', text: 'hi' }]
  }
}

const toolUse = (toolCallId: string, name: string, input: unknown): DriverPart => ({
  driverId: 'qoder',
  type: 'qoder.tool-use',
  toolCallId,
  name,
  input
})

const toolResult = (toolCallId: string, output: unknown, isError?: boolean): DriverPart => ({
  driverId: 'qoder',
  type: 'qoder.tool-result',
  toolCallId,
  output,
  ...(isError !== undefined ? { isError } : {})
})

describe('deriveConversationChanges', () => {
  it('Write/Edit 操作进入列表并按 path 聚合、顺序正确', () => {
    const messages = [
      userMessage('m1'),
      assistantMessage('m2', [
        toolUse('c1', 'Write', { file_path: '/proj/src/a.ts', content: 'v1' }),
        toolResult('c1', 'ok'),
        toolUse('c2', 'Edit', { file_path: '/proj/src/a.ts', old_string: 'a', new_string: 'b' }),
        toolResult('c2', 'ok'),
        toolUse('c3', 'Write', { file_path: '/proj/src/b.ts', content: 'x' }),
        toolResult('c3', 'ok')
      ])
    ]
    const files = deriveConversationChanges(messages, '/proj')
    expect(files.map((f) => f.displayPath)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(files[0]!.operations).toHaveLength(2)
    expect(files[0]!.operations.map((op) => op.tool)).toEqual(['Write', 'Edit'])
  })

  it('配对 tool-result:isError → error,无 result → pending,output 透传', () => {
    const messages = [
      assistantMessage('m1', [
        toolUse('c1', 'Write', { file_path: '/p/a.ts', content: 'v' }),
        toolResult('c1', 'boom', true),
        toolUse('c2', 'Edit', { file_path: '/p/b.ts', old_string: 'x', new_string: 'y' })
        // c2 无 tool-result:流式中
      ])
    ]
    const files = deriveConversationChanges(messages)
    expect(files).toHaveLength(2)
    const failed = files.find((f) => f.path === '/p/a.ts')!.operations[0]!
    expect(failed.status).toBe('error')
    expect(failed.output).toBe('boom')
    const pending = files.find((f) => f.path === '/p/b.ts')!.operations[0]!
    expect(pending.status).toBe('pending')
    expect(pending.output).toBeUndefined()
  })

  it('tool-result 晚于 tool-use(跨消息)也能配对', () => {
    const messages = [
      assistantMessage('m1', [toolUse('c1', 'Write', { file_path: '/p/a.ts', content: 'v' })]),
      assistantMessage('m2', [toolResult('c1', 'ok')])
    ]
    const files = deriveConversationChanges(messages)
    expect(files[0]!.operations[0]!.status).toBe('done')
  })

  it('非写工具(Read/Grep/Bash)不进入列表', () => {
    const messages = [
      assistantMessage('m1', [
        toolUse('c1', 'Read', { file_path: '/p/a.ts' }),
        toolUse('c2', 'Grep', { path: '/p', pattern: 'foo' }),
        toolUse('c3', 'Bash', { command: 'python gen.py' }),
        toolUse('c4', 'Write', { file_path: '/p/a.ts', content: 'v' })
      ])
    ]
    const files = deriveConversationChanges(messages)
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe('/p/a.ts')
  })

  it('工具名大小写不敏感(Pi 小写工具名同样命中)', () => {
    const messages = [assistantMessage('m1', [toolUse('c1', 'write', { path: '/p/a.ts', content: 'v' })])]
    const files = deriveConversationChanges(messages)
    expect(files).toHaveLength(1)
    expect(files[0]!.operations[0]!.tool).toBe('write')
  })

  it('openai driver 的 tool-call/tool-result 同样参与推导', () => {
    const messages: StoredMessage[] = [
      {
        ...assistantMessage('m1', []),
        driverId: 'openai',
        parts: [
          {
            driverId: 'openai',
            type: 'openai.tool-call',
            toolCallId: 'c1',
            name: 'Edit',
            input: { file_path: '/p/a.ts' }
          },
          { driverId: 'openai', type: 'openai.tool-result', toolCallId: 'c1', output: 'ok' }
        ]
      }
    ]
    const files = deriveConversationChanges(messages)
    expect(files[0]!.operations[0]!.status).toBe('done')
  })

  it('路径相对化:workingDirectory 前缀剥离,外部路径原样保留', () => {
    const messages = [
      assistantMessage('m1', [
        toolUse('c1', 'Write', { file_path: '/proj/src/a.ts', content: 'v' }),
        toolUse('c2', 'Write', { file_path: '/other/b.ts', content: 'v' })
      ])
    ]
    const files = deriveConversationChanges(messages, '/proj')
    expect(files[0]!.displayPath).toBe('src/a.ts')
    expect(files[1]!.displayPath).toBe('/other/b.ts')
  })
})

describe('extractChangePath', () => {
  it('优先 file_path,其次 path,缺失返回 undefined', () => {
    expect(extractChangePath({ file_path: '/a.ts', path: '/b.ts' })).toBe('/a.ts')
    expect(extractChangePath({ path: '/b.ts' })).toBe('/b.ts')
    expect(extractChangePath({})).toBeUndefined()
    expect(extractChangePath(null)).toBeUndefined()
  })
})

describe('changeOperationKind', () => {
  it('归类:Write/NotebookEdit→write,Delete→delete,其余→edit', () => {
    expect(changeOperationKind('Write')).toBe('write')
    expect(changeOperationKind('NotebookEdit')).toBe('write')
    expect(changeOperationKind('Delete')).toBe('delete')
    expect(changeOperationKind('Edit')).toBe('edit')
    expect(changeOperationKind('MultiEdit')).toBe('edit')
  })
})
