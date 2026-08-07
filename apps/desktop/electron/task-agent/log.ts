/**
 * Qoder 任务执行层的工具函数。
 *
 * 把 main.ts 里跟 Qoder SDK 强耦合的工具(qoderLogFile / logQoderMessage /
 * closeQoderQuerySafely / recordQoderMessage / qoderText)迁到这里,供
 * `QoderTaskAgentDriver` 与 main.ts 的 review / probe 路径共享。
 *
 * 注意：driver 内部按"注入依赖"的方式使用这些函数,而不是直接 import 顶层常量
 * (activeQoderQuery / store 等),保证 driver 可以单独被测试。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionUsage, TaskStore } from '@coding-agent/core'
import type { Query, SDKMessage } from '@qoder-ai/qoder-agent-sdk'
import { sdkResultText } from '../plan-content.js'

/**
 * Qoder 阶段日志文件路径(若 `CODING_AGENT_QODER_LOG=1`)。
 * 文件按 `taskId-<timestamp>.jsonl` 命名,append 模式逐条写入。
 */
export function qoderLogFile(dataDir: string, taskId: string): string | undefined {
  if (process.env.CODING_AGENT_QODER_LOG !== '1') return undefined
  const dir = join(dataDir, 'logs', 'qoder')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(dir, `${taskId}-${stamp}.jsonl`)
}

/** 把一条 SDKMessage 写入日志文件(若 file 为 undefined 则跳过)。 */
export function logQoderMessage(file: string | undefined, message: SDKMessage): void {
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), msg: message }) + '\n', 'utf8')
  } catch {
    /* 日志写不进去不能影响主流程 */
  }
}

/**
 * 安全关闭 query 句柄,带超时保护(避免 SDK 内部泄漏阻塞后续任务)。
 * 已经在关闭/中断状态下重复调用会被 SDK 吃掉。
 */
export async function closeQoderQuerySafely(query: Query, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      query.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 提取 SDKMessage 的可见文本(给 driver / review / probe 共用)。 */
export function qoderText(message: SDKMessage): string | undefined {
  const record = message as unknown as Record<string, any>
  if (message.type === 'result') return sdkResultText(record.result, record.errors)
  if (message.type !== 'assistant') return undefined
  const content = record.message?.content
  if (!Array.isArray(content)) return undefined
  return (
    content
      .filter((item: any) => item?.type === 'text')
      .map((item: any) => item.text)
      .filter(Boolean)
      .join('\n') || undefined
  )
}

/**
 * 记录一条 SDKMessage:更新 sessionUsage + 写任务事件 + emit qoder_event。
 * 拆出来是因为 plan / implementation / test_generation 三个阶段都共用,避免在 driver 内重复。
 */
export function recordQoderMessage(
  store: TaskStore,
  taskId: string,
  message: SDKMessage,
  options: {
    recordText: boolean
    addTaskEvent: (event: {
      taskId: string
      kind: 'message' | 'status' | 'error'
      title: string
      detail?: string
    }) => void
    emitPi: (event: { type: 'qoder_event'; taskId: string; message: SDKMessage }) => void
  }
): void {
  // 任务不存在时不写库、不发事件：
  // - `store.updateTask` 在任务不存在时会抛 `Task not found: <id>`；
  // - `store.addEvent` 写入 events 表，该表对 task_id 有 FK 约束，会报 `FOREIGN KEY constraint failed`。
  // 主力调用者（QoderTaskAgentDriver）走的是真实任务，这条快路径；哨兵 taskId
  // （如 `agents:generate-content` 使用的 `__agent_generator__`）走这里。
  if (!store.getTask(taskId)) return
  const text = qoderText(message)
  const current = store.getTask(taskId)?.sessionUsage
  const previous = current?.provider === 'qoder' ? current : undefined

  if (message.type === 'assistant') {
    const u = (
      message as unknown as {
        message?: {
          usage?: {
            input_tokens?: number | null
            output_tokens?: number | null
            cache_read_input_tokens?: number | null
            cache_creation_input_tokens?: number | null
          }
        }
      }
    ).message?.usage
    if (u) {
      const inputTokens = (previous?.inputTokens ?? 0) + (u.input_tokens ?? 0)
      const outputTokens = (previous?.outputTokens ?? 0) + (u.output_tokens ?? 0)
      const cacheRead = (previous?.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      const cacheWrite = (previous?.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      store.updateTask(taskId, {
        sessionUsage: {
          provider: 'qoder',
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          totalTokens: inputTokens + outputTokens + cacheRead + cacheWrite,
          costUsd: previous?.costUsd,
          durationMs: previous?.durationMs,
          turns: previous?.turns
        }
      })
    }
  }

  if (message.type === 'result') {
    const result = message as unknown as {
      duration_ms: number
      num_turns: number
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
      usage?: {
        input_tokens?: number | null
        output_tokens?: number | null
        cache_read_input_tokens?: number | null
        cache_creation_input_tokens?: number | null
      }
    }
    const models = Object.values(result.modelUsage ?? {})
    const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'costUSD') =>
      models.reduce((s, m) => s + ((m?.[k] as number) ?? 0), 0)
    const mIn = sum('inputTokens'),
      mOut = sum('outputTokens'),
      mRd = sum('cacheReadInputTokens'),
      mWr = sum('cacheCreationInputTokens'),
      mCost = sum('costUSD')
    const uIn = result.usage?.input_tokens ?? 0,
      uOut = result.usage?.output_tokens ?? 0,
      uRd = result.usage?.cache_read_input_tokens ?? 0,
      uWr = result.usage?.cache_creation_input_tokens ?? 0
    const pick = (mv: number, uv: number, prev: number | undefined) => (mv > 0 ? mv : uv > 0 ? uv : (prev ?? 0))
    const inputTokens = pick(mIn, uIn, previous?.inputTokens)
    const outputTokens = pick(mOut, uOut, previous?.outputTokens)
    const cacheRead = pick(mRd, uRd, previous?.cacheReadTokens)
    const cacheWrite = pick(mWr, uWr, previous?.cacheWriteTokens)
    const cost = mCost > 0 ? mCost : (result.total_cost_usd ?? 0)
    const usage: SessionUsage = {
      provider: 'qoder',
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: inputTokens + outputTokens + cacheRead + cacheWrite,
      costUsd: (previous?.costUsd ?? 0) + cost,
      durationMs: (previous?.durationMs ?? 0) + result.duration_ms,
      turns: (previous?.turns ?? 0) + result.num_turns
    }
    store.updateTask(taskId, { sessionUsage: usage })
  }

  if (text && options.recordText) options.addTaskEvent({ taskId, kind: 'message', title: 'Qoder Agent', detail: text })
  else if (message.type === 'system')
    options.addTaskEvent({
      taskId,
      kind: 'status',
      title: `Qoder ${message.subtype}`,
      detail: JSON.stringify(message).slice(0, 2000)
    })
  options.emitPi({ type: 'qoder_event', taskId, message })
}
