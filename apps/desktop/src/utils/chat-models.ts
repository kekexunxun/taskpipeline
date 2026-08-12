/**
 * 系统默认模型解析（前端版）— 纯函数。
 *
 * 与 electron/chat/system-default-model.ts 双写（跨进程边界无法共享模块）：
 *  - Qoder 分组存在（已连接且有模型）→ 系统默认优先落在 Qoder 组；
 *  - Qoder 不可用 → 落到第一个有模型的分组（当前即 OpenAI）；
 *  - 组内取 isDefault 标记的模型，无标记取第一个。
 */

import type { ChatModelGroup, SystemDefaultModel } from '../api'

export type { SystemDefaultModel }

/** 从分组列表中挑系统默认模型；无任何可用模型时返回 undefined。 */
export function pickSystemDefaultModel(groups: ChatModelGroup[]): SystemDefaultModel | undefined {
  const preferred = groups.find((group) => group.driverId === 'qoder') ?? groups[0]
  if (!preferred) return undefined
  const model = preferred.models.find((item) => item.isDefault) ?? preferred.models[0]
  if (!model) return undefined
  return { driverId: preferred.driverId, model: model.value }
}

/** 模型 value 是否仍存在于当前分组列表中（对话/任务存储值的存在性校验）。 */
export function isModelAvailable(groups: ChatModelGroup[], value: string | undefined): boolean {
  if (!value) return false
  return groups.some((group) => group.models.some((model) => model.value === value))
}
