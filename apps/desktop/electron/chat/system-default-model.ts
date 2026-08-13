/**
 * 系统默认模型解析 — 纯函数，供 ChatService / main.ts / 单测共用。
 *
 * 规则（与前端 src/utils/chat-models.ts 双写，跨进程边界无法共享模块）：
 *  - Qoder 分组存在（已连接且有模型）→ 系统默认优先落在 Qoder 组；
 *  - Qoder 不可用 → 落到第一个有模型的分组（当前即 OpenAI）；
 *  - 组内：isDefault 标记优先 → 无标记回落 lite（priceFactor===0 或名字含 lite/haiku/flash/mini）
 *    → 兜底第一个。Qoder 无 credit 时可用列表只剩免费模型，回落稳定落在 lite；
 *    该 lite 回落仅对 Qoder 组应用，OpenAI 组保持 isDefault → 第一个。
 */

import type { ChatDriverId, ChatModelGroup, ChatModelInfo } from './chat-types.js'

export type SystemDefaultModel = { driverId: ChatDriverId; model: string }

/**
 * lite 特征词（完整 word 匹配，词边界避免误命中 MiniMax 等含 mini 前缀的模型名）。
 * 供 Qoder 组回落与 chat-service 重试 fallback 共用。
 */
export const LITE_MODEL_PATTERN = /\b(lite|haiku|flash|mini)\b/i

/** 组内挑选（见文件头注释）；无任何模型时返回 undefined。 */
export function pickGroupModel(preferred: ChatModelGroup): ChatModelInfo | undefined {
  if (preferred.driverId !== 'qoder') {
    return preferred.models.find((item) => item.isDefault) ?? preferred.models[0]
  }
  return (
    preferred.models.find((item) => item.isDefault) ??
    preferred.models.find(
      (item) => item.priceFactor === 0 || LITE_MODEL_PATTERN.test(`${item.value} ${item.displayName ?? ''}`)
    ) ??
    preferred.models[0]
  )
}

/** 从分组列表中挑系统默认模型；无任何可用模型时返回 undefined。 */
export function pickSystemDefaultModel(groups: ChatModelGroup[]): SystemDefaultModel | undefined {
  const preferred = groups.find((group) => group.driverId === 'qoder') ?? groups[0]
  if (!preferred) return undefined
  const model = pickGroupModel(preferred)
  if (!model) return undefined
  return { driverId: preferred.driverId, model: model.value }
}

/** 模型 value 是否仍存在于当前分组列表中（对话/任务存储值的存在性校验）。 */
export function isModelAvailable(groups: ChatModelGroup[], value: string | undefined): boolean {
  if (!value) return false
  return groups.some((group) => group.models.some((model) => model.value === value))
}
