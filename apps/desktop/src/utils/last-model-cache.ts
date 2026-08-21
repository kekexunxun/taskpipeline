/**
 * 模型选择缓存与统一解析。
 *
 * 全应用唯一的模型解析链：props value → cache → system default，每步过可用性验证。
 * 所有需要「确定当前模型」的地方（ChatModelSelector / useChat / DetailPanel 等）
 * 统一调用 resolveModelValue()，不再各自写 fallback。
 */

import type { ChatModelGroup } from '../api'
import { isModelAvailable, pickSystemDefaultModel } from './chat-models'

const STORAGE_KEY = 'chat:lastSelectedModel'

/** 读取上次选择的模型 value；不存在或解析失败返回 undefined。 */
export function getLastSelectedModel(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) || undefined
  } catch {
    return undefined
  }
}

/** 持久化当前选择的模型 value。 */
export function saveLastSelectedModel(model: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, model)
  } catch {
    // 隐私模式 / 存储满等异常静默忽略
  }
}

/**
 * 统一模型解析：value → cache → system default，每步过可用性验证。
 *
 * - value 存在且在 groups 中可用 → 直接返回
 * - 否则查 cache（上次用户手动选择），可用则返回
 * - 否则走 pickSystemDefaultModel 兑底
 * - 均无可用模型 → undefined
 */
export function resolveModelValue(value: string | undefined, groups: ChatModelGroup[]): string | undefined {
  // 1. props value 可用就直接返回
  if (value && isModelAvailable(groups, value)) return value
  // 2. cache 可用就用
  const cached = getLastSelectedModel()
  if (cached && isModelAvailable(groups, cached)) return cached
  // 3. system default 兑底
  return pickSystemDefaultModel(groups)?.model
}
