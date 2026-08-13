/**
 * OpenAI 兼容模型 value（`<厂商前缀>:<model>[@<profileId>]`）的编解码。
 *
 * 前缀 = profile 的 vendor（deepseek / openai / openai-compatible / dashscope-token-plan），
 * driver 组仍是 `openai`（对话 driverId），厂商前缀只用于在 value 上标识厂商，便于阅读与路由：
 * - deepseek 配置产出 `deepseek:<model>`；
 * - openai 官方配置产出 `openai:<model>`（与历史格式一致，天然兼容）；
 * - 百炼 Token Plan 产出 `dashscope-token-plan:<model>`；
 * - 其它兼容端点产出 `openai-compatible:<model>`。
 *
 * 历史格式统一为 `openai:<model>`（早期所有 OpenAI 兼容模型都用它），
 * `openai:default` 是早期占位 value；解析层保留对这些旧值的前缀识别。
 */

import type { ModelVendor } from './model-providers.js'

/** 当前厂商前缀（与 vendor 同名）。 */
export const VENDOR_PREFIXES: readonly ModelVendor[] = [
  'deepseek',
  'openai',
  'openai-compatible',
  'dashscope-token-plan'
]

/** 历史前缀：早期所有 OpenAI 兼容模型统一 `openai:`，与 openai 厂商前缀重合。 */
export const LEGACY_PREFIX = 'openai'

/** 所有属于 OpenAI 兼容 driver 组的前缀（当前厂商前缀 + 历史前缀）。 */
export const OPENAI_MODEL_PREFIXES: readonly string[] = VENDOR_PREFIXES

/** value 是否属于 OpenAI 兼容 driver 组（按前缀判定；无前缀 / qoder: 均不属于）。 */
export function isOpenAIModelValue(value: string): boolean {
  return OPENAI_MODEL_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}:`))
}

/** 按 vendor 生成 value 前缀（vendor 缺省或非预期值按 openai-compatible 兜底）。 */
export function prefixOfVendor(vendor: string | undefined): string {
  return vendor && OPENAI_MODEL_PREFIXES.includes(vendor) ? vendor : 'openai-compatible'
}

/** 剥掉 `<前缀>:` 取原始模型串（保留 `@<profileId>` 消歧后缀）。 */
export function stripModelPrefix(value: string): string {
  const idx = value.indexOf(':')
  return idx >= 0 ? value.slice(idx + 1) : value
}
