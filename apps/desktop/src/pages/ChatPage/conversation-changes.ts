/**
 * 对话级变更推导层 —— 从已持久化的消息 parts 纯推导「本次对话改了哪些文件」,零存储、零 IPC。
 *
 * 事实源:`chat-{id}.json` 中的 assistant parts——
 * - `qoder.tool-use` / `openai.tool-call` 的 input 含 `file_path`(Write 另有 content、Edit 另有 old/new_string);
 * - 配对的 `qoder.tool-result` / `openai.tool-result` 标记成功/失败。
 *
 * 与 Qoder checkpoint 哲学一致:展示层由消息流推导;快照归 CLI 内部(仅服务 rewind);
 * Bash 直接写文件的变更不追踪。过去对话无需迁移直接生效;流式期间 parts 实时增长,推导天然跟随。
 */

import { useMemo } from 'react'
import type { StoredMessage } from '@/api'

/** 产生文件变更的工具名(小写匹配;Qoder 大写、Pi 小写均可命中)。 */
const MUTATING_TOOLS = new Set(['write', 'edit', 'delete', 'multiedit', 'notebookedit'])

/** 单次文件变更操作(一次工具调用)。 */
export type ConversationChangeOperation = {
  toolCallId: string
  /** 原始工具名(Write/Edit/Delete/…)。 */
  tool: string
  /** 配对 tool-result 推导:无结果=进行中;isError=失败;否则完成。 */
  status: 'pending' | 'done' | 'error'
  /** 透传给 ToolBlocks 渲染。 */
  input: unknown
  output?: unknown
  parentTaskId?: string
}

/** 按文件聚合的变更记录:同一文件只出现一行,操作按时间序追加。 */
export type ConversationChangeFile = {
  /** 原始路径(工具 input 中的值)。 */
  path: string
  /** 按 workingDirectory 相对化后的展示路径。 */
  displayPath: string
  operations: ConversationChangeOperation[]
}

/** 操作归类:列表行徽标与图标选择用(write=新建/整写,edit=局部编辑,delete=删除)。 */
export type ChangeOperationKind = 'write' | 'edit' | 'delete'

export function changeOperationKind(tool: string): ChangeOperationKind {
  const lower = tool.toLowerCase()
  if (lower === 'write' || lower === 'notebookedit') return 'write'
  if (lower === 'delete') return 'delete'
  return 'edit'
}

/** 从工具 input 提取指定字符串字段(ToolBlocks 渲染层也复用此逻辑)。 */
export function getInputField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 从工具 input 提取变更目标路径(兼容 file_path / path 两种字段名)。 */
export function extractChangePath(input: unknown): string | undefined {
  return getInputField(input, 'file_path') ?? getInputField(input, 'path')
}

function relativize(path: string, workingDirectory?: string): string {
  if (!workingDirectory) return path
  const prefix = workingDirectory.endsWith('/') ? workingDirectory : `${workingDirectory}/`
  if (path.startsWith(prefix)) return path.slice(prefix.length)
  return path
}

/**
 * 从消息列表推导对话级文件变更。
 *
 * 两遍扫描:先跨消息收集全部 tool-result(按 toolCallId 索引),
 * 再按时间序遍历写类工具调用并按 path 去重聚合。
 */
export function deriveConversationChanges(
  messages: StoredMessage[],
  workingDirectory?: string
): ConversationChangeFile[] {
  // Pass 1:收集 tool-result(可能晚于 tool-use 到达,跨消息索引)
  const results = new Map<string, { output: unknown; isError?: boolean }>()
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === 'qoder.tool-result') {
        results.set(part.toolCallId, { output: part.output, isError: part.isError })
      } else if (part.type === 'openai.tool-result') {
        results.set(part.toolCallId, { output: part.output })
      }
    }
  }

  // Pass 2:按时间序收集写类工具调用,按 path 聚合
  const byPath = new Map<string, ConversationChangeFile>()
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== 'qoder.tool-use' && part.type !== 'openai.tool-call') continue
      if (!MUTATING_TOOLS.has(part.name.toLowerCase())) continue
      const path = extractChangePath(part.input)
      if (!path) continue

      const result = results.get(part.toolCallId)
      const operation: ConversationChangeOperation = {
        toolCallId: part.toolCallId,
        tool: part.name,
        status: result ? (result.isError ? 'error' : 'done') : 'pending',
        input: part.input,
        ...(result ? { output: result.output } : {}),
        ...(part.parentTaskId ? { parentTaskId: part.parentTaskId } : {})
      }

      let file = byPath.get(path)
      if (!file) {
        file = { path, displayPath: relativize(path, workingDirectory), operations: [] }
        byPath.set(path, file)
      }
      file.operations.push(operation)
    }
  }
  return [...byPath.values()]
}

/** hook 形态:messages/workingDirectory 变化时重新推导(流式中天然跟随 parts 增长)。 */
export function useConversationChanges(messages: StoredMessage[], workingDirectory?: string) {
  return useMemo(() => deriveConversationChanges(messages, workingDirectory), [messages, workingDirectory])
}
