/**
 * Chat 上下文预算裁剪（问题 2-A：兜底层）。
 *
 * 背景：OpenAI/deepseek chat 路径每轮把「全量历史」原样发送，且 agentic 循环内每一步都重发，
 * 单轮 input token 单调上涨，逼近模型窗口上限时不会自动裁剪、只会 provider 报「上下文超长」。
 *
 * 本模块只做**廉价兜底**：按 token 预算把待发送历史裁剪到「system + 最近若干轮」的保留窗口，
 * 逐字丢弃更早的轮次（问题 2-B 的滚动摘要层就绪后，被丢弃轮次交给它摘要，本层仍负责防爆窗）。
 *
 * 设计约束：
 *  - 短对话（未超预算）行为不变：不裁剪、原样返回；
 *  - 按「轮」成对丢弃（user + 其后续 assistant/tool parts），避免悬空 tool-call；
 *  - 始终保留 system 记录与最后一轮（含当前提问），且保持原始相对顺序（driver 依赖末条为 user）。
 */

import type { TaskStore } from '@task-pipeline/core'
import type { StoredMessageRecord } from './chat-types.js'

/** 预算比例：留给系统的窗口占用上限，超出即裁剪。 */
export const CHAT_CONTEXT_BUDGET_RATIO = 0.75

/** profile 未配置 contextWindowTokens 时的默认窗口（token）：主流模型普遍 ≥128k，取 128k 作为保守上限。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000

/** 粗略 token 估算：字符数 / 4（对中英混合偏保守，够用于预算判定）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** 估算单条持久化记录的 token：raw 为字符串直接用，否则序列化（覆盖 tool-result 大输出）。 */
export function estimateRecordTokens(record: StoredMessageRecord): number {
  const text = typeof record.raw === 'string' ? record.raw : JSON.stringify(record.raw ?? '')
  return estimateTokens(text)
}

function sumTokens(records: StoredMessageRecord[]): number {
  return records.reduce((acc, r) => acc + estimateRecordTokens(r), 0)
}

/**
 * 读取当前模型对应 profile 的 contextWindowTokens；缺省回落保守默认。
 * model value 形如 `<vendor>:<model>` 或 `<vendor>:<model>@<profileId>`。
 */
export function contextWindowForModel(store: TaskStore, model: string): number {
  try {
    const raw = store.getSetting('modelProfiles')
    if (!raw) return DEFAULT_CONTEXT_WINDOW_TOKENS
    const profiles = JSON.parse(raw) as Array<{ id?: string; model?: string; contextWindowTokens?: number }>
    if (!Array.isArray(profiles)) return DEFAULT_CONTEXT_WINDOW_TOKENS
    const [, rest = ''] = model.split(':')
    const [modelName, profileId] = rest.split('@')
    const matched = profiles.find((p) => (profileId ? p.id === profileId : p.model === modelName))
    const tokens = matched?.contextWindowTokens
    return typeof tokens === 'number' && tokens > 0 ? tokens : DEFAULT_CONTEXT_WINDOW_TOKENS
  } catch {
    return DEFAULT_CONTEXT_WINDOW_TOKENS
  }
}

/** 按模型窗口与预算比例算出可发送给历史部分的 token 上限。 */
export function budgetForModel(store: TaskStore, model: string): number {
  return Math.floor(contextWindowForModel(store, model) * CHAT_CONTEXT_BUDGET_RATIO)
}

export type TrimResult = {
  /** 裁剪后待发送记录（保持原始相对顺序）。 */
  kept: StoredMessageRecord[]
  /** 被丢弃的最早轮次记录（问题 2-B 摘要层的输入素材）。 */
  dropped: StoredMessageRecord[]
  /** 裁剪后保留部分的估算 token。 */
  estimatedTokens: number
}

/** 把对话记录（不含 system）按「user 开轮、后续 assistant 归入」切分成轮次。 */
function groupIntoTurns(records: StoredMessageRecord[]): StoredMessageRecord[][] {
  const turns: StoredMessageRecord[][] = []
  let current: StoredMessageRecord[] | undefined
  for (const r of records) {
    if (r.role === 'user') {
      current = [r]
      turns.push(current)
    } else if (current) {
      current.push(r)
    } else {
      // 无前置 user 的孤儿 assistant：自成一轮。
      current = [r]
      turns.push(current)
    }
  }
  return turns
}

/**
 * 按预算裁剪历史到保留窗口。
 *
 * @param records 组装后的完整历史（含 system 记录，末尾为当前 userRecord）
 * @param budgetTokens 历史部分可发送的 token 上限
 * @param lastUsageTokens 该对话最近一轮实测 input token（真实值含工具/system，作触发下限）
 */
export function trimHistoryToBudget(opts: {
  records: StoredMessageRecord[]
  budgetTokens: number
  lastUsageTokens?: number
}): TrimResult {
  const { records, budgetTokens, lastUsageTokens } = opts
  const total = sumTokens(records)
  const measured = lastUsageTokens ?? 0
  // 实测上一轮 input 与估算取大者作为触发基线：估算漏算工具定义/system 时仍能兜底。
  const startEstimate = Math.max(total, measured)
  if (startEstimate <= budgetTokens) {
    return { kept: records, dropped: [], estimatedTokens: total }
  }

  // 字符/4 估算对中英混排 + 工具定义 + system 严重低估：当实测 > 估算时，按 `measured/total`
  // 把估算放大到实测口径，令丢弃判定在「缩放后的 token 空间」进行。否则会出现「实测已超预算、
  // 但估算仍低于预算」→ 循环立即 break、dropped 恒空 → 压缩链路永不触发的缺陷。
  const scale = total > 0 && measured > total ? measured / total : 1

  const conversation = records.filter((r) => r.role !== 'system')
  const turns = groupIntoTurns(conversation)
  let remaining = startEstimate
  const droppedRecords: StoredMessageRecord[] = []
  const droppedSet = new Set<StoredMessageRecord>()
  // 从最早轮次起逐个丢弃（按缩放后 token 计），直到落回预算；最后一轮（含当前提问）永不下限。
  for (let i = 0; i < turns.length - 1; i += 1) {
    if (remaining <= budgetTokens) break
    const turn = turns[i]
    if (!turn) continue
    for (const r of turn) {
      droppedSet.add(r)
      droppedRecords.push(r)
    }
    remaining -= sumTokens(turn) * scale
  }

  const kept = records.filter((r) => !droppedSet.has(r))
  return { kept, dropped: droppedRecords, estimatedTokens: sumTokens(kept) }
}
