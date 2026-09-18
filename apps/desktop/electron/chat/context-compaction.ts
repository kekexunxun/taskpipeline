/**
 * Chat 上下文滚动摘要（问题 2-B：摘要层）。
 *
 * 在兜底裁剪层（`context-budget.ts`，问题 2-A）之上增强：当溢出保留窗口的更早轮次累积到阈值，
 * 跑一次**辅助 LLM 调用**把「已有摘要 + 新溢出轮次」压成新的滚动摘要，持久化到 `conversation.compaction`；
 * 重建 history 时把已覆盖轮次排除、摘要作为 system 注入。
 *
 * 约束：
 *  - 摘要用一次性会话 + `traceLabel` join 同一回合 trace（沿用记忆整理同类模式）；
 *  - 失败/异常只返回 undefined，调用方降级为「仅 2-A 裁剪」，绝不阻断对话；
 *  - 覆盖边界 `coveredUntilMessageId` 之后（更新）的消息永不丢失，只排除其及其之前的非 system 轮次。
 */

import { randomUUID } from 'node:crypto'
import type { ChatDriver } from './drivers/chat-driver.js'
import type { ChatDriverId, ChatCompaction, StoredMessageRecord } from './chat-types.js'
import { estimateRecordTokens } from './context-budget.js'

/** 溢出轮次估算 token 达此阈值才触发一次摘要（避免每轮都调模型）。 */
export const COMPACTION_TRIGGER_TOKENS = 4_000

/** 上下文占用达窗口此比例即触发压缩（不等溢出攒够 4k，未雨绸缪）。 */
export const COMPACT_CONTEXT_USAGE_RATIO = 0.8

/** 摘要正文注入为 system 时的标题前缀（读回时可据此识别，也便于日志）。 */
export const SUMMARY_SYSTEM_PREFIX = '【历史对话摘要】'

/**
 * 是否需要为这批溢出轮次跑摘要：
 *  - `contextReached`（上下文占用已达窗口 80%）时，只要有溢出即触发；
 *  - 否则沿用溢出估算 token 达阈值触发（短溢出攒批，避免每轮调模型）。
 */
export function shouldCompact(overflow: StoredMessageRecord[], opts?: { contextReached?: boolean }): boolean {
  if (!overflow.length) return false
  if (opts?.contextReached) return true
  const tokens = overflow.reduce((acc, r) => acc + estimateRecordTokens(r), 0)
  return tokens >= COMPACTION_TRIGGER_TOKENS
}

/**
 * 从 history 记录中排除已被摘要覆盖的更早轮次：`coveredUntilMessageId` 及其之前的**非 system** 记录丢弃，
 * system 记录与更晚记录保留（保持原序）。覆盖 id 已不存在（消息被删）时视为陈旧，不排除任何记录。
 */
export function excludeCoveredRecords(
  records: StoredMessageRecord[],
  coveredUntilMessageId: string | undefined
): StoredMessageRecord[] {
  if (!coveredUntilMessageId) return records
  const coveredIndex = records.findIndex((r) => r.id === coveredUntilMessageId)
  if (coveredIndex < 0) return records
  return records.filter((r, i) => r.role === 'system' || i > coveredIndex)
}

/** 把摘要正文包装成一条 system 记录（driver 会抽取所有 system 融入分层系统提示）。 */
export function makeSummarySystemRecord(
  chatId: string,
  summary: string,
  driverId: ChatDriverId,
  createdAt: string
): StoredMessageRecord {
  return {
    id: `compaction-${chatId}`,
    role: 'system',
    createdAt,
    driverId,
    raw: { kind: 'system', text: `${SUMMARY_SYSTEM_PREFIX}\n${summary}` }
  } as StoredMessageRecord
}

/** 把持久化记录列表转成供摘要的可读对话文本（只取 text part，按角色前缀）。 */
export function buildCompactionTranscript(driver: ChatDriver, records: StoredMessageRecord[]): string {
  return records
    .filter((r) => r.role !== 'system')
    .map((r) => {
      const parts = driver.deserializeMessage(r).parts
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { type: 'text'; text?: string }).text ?? '')
        .join('')
      if (!text.trim()) return ''
      return `${r.role === 'user' ? '用户' : '助手'}：${text}`
    })
    .filter(Boolean)
    .join('\n\n')
}

function summaryPrompt(existingSummary: string | undefined): string {
  return [
    '你是对话上下文压缩助手。请把下面的对话历史压缩成一段**滚动摘要**，',
    '供后续对话作为背景继续，不必复述寒暄与过程性内容。',
    '务必保留：关键技术结论、已核实的事实、涉及的文件/函数/配置名、已达成的决定与未决待办、用户明确表达的偏好。',
    existingSummary ? `\n已有摘要（在其基础上合并新内容，输出完整新版摘要）：\n${existingSummary}\n` : '',
    '直接输出摘要正文纯文本，不要输出 JSON、Markdown 代码块或任何额外说明；控制在约 600 字以内。'
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 跑一次辅助 LLM 调用，把「已有摘要 + 溢出轮次文本」压成新的滚动摘要。
 * 失败/异常返回 undefined（调用方降级为仅裁剪）。
 */
export async function summarizeOverflow(input: {
  driver: ChatDriver
  driverId: ChatDriverId
  model: string
  existingSummary?: string
  transcript: string
  signal?: AbortSignal
  /** join 当前对话回合 trace，缺省自建独立 trace。 */
  traceId?: string
}): Promise<string | undefined> {
  const abort = new AbortController()
  const forwardAbort = () => abort.abort()
  input.signal?.addEventListener('abort', forwardAbort, { once: true })
  const conversationId = `context-compaction-${randomUUID()}`
  const userText = `${summaryPrompt(input.existingSummary)}\n\n待压缩的对话历史：\n${input.transcript}`
  const userRecord = input.driver.serializeUserMessage({
    id: randomUUID(),
    text: userText,
    createdAt: new Date().toISOString()
  })
  let result = ''
  try {
    for await (const chunk of input.driver.streamChat({
      conversationId,
      model: input.model,
      history: [input.driver.deserializeMessage(userRecord)],
      userInput: { id: userRecord.id, text: userText, createdAt: userRecord.createdAt },
      signal: abort.signal,
      traceLabel: '上下文摘要',
      ...(input.traceId ? { traceId: input.traceId } : {})
    })) {
      if (chunk.type === 'part' && chunk.part.type === 'text') {
        result += chunk.part.text
      } else if (chunk.type === 'error') {
        console.warn('[compaction] summarize llm error:', chunk.message)
      }
    }
  } catch (error) {
    console.warn('[compaction] summarize llm failed:', error)
    return undefined
  } finally {
    input.signal?.removeEventListener('abort', forwardAbort)
    try {
      input.driver.closeSession?.(conversationId)
    } catch {
      /* 关闭失败不影响摘要结果 */
    }
  }
  const summary = result.trim()
  return summary ? summary : undefined
}

/** 组装新的 compaction：摘要正文 + 覆盖边界（本批溢出轮次里最后一条消息 id）。 */
export function buildCompaction(overflow: StoredMessageRecord[], summary: string): ChatCompaction | undefined {
  const boundary = overflow.at(-1)?.id
  if (!boundary) return undefined
  return { summary, coveredUntilMessageId: boundary, updatedAt: new Date().toISOString() }
}
