/**
 * 模型厂商注册表与 ai-sdk provider 工厂。
 *
 * 背景：不同厂商的官方端点需要用各自的 ai-sdk provider 包才能拿到完整能力：
 *  - DeepSeek 官方 API（api.deepseek.com）：@ai-sdk/deepseek 解析 reasoning_content、
 *    支持 thinking 模式控制与 V4 系列兼容、上报 prompt cache 用量指标；
 *  - OpenAI 官方 API（api.openai.com）：@ai-sdk/openai 支持原生 structured outputs、
 *    reasoning_effort 等官方端点专属能力；
 *  - 其它 OpenAI 兼容端点（Kimi / GLM / 百炼 / 自建网关…）：@ai-sdk/openai-compatible 兜底，
 *    只保证 chat 与工具调用的基本协议。
 *
 * `vendor` 字段持久化在 modelProfiles（`{ id, provider, vendor, baseUrl, ... }`）里，
 * 与 `provider` 字段（`company-openai:<id>`，pi 的 models.json provider key）完全无关。
 * 旧数据没有 vendor 时按 baseUrl 主机名识别（detectVendor），识别不出走 openai-compatible。
 */

import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV4 } from '@ai-sdk/provider'

/** 厂商类型：决定用哪个 ai-sdk provider 包创建模型实例。 */
export type ModelVendor = 'deepseek' | 'openai' | 'openai-compatible' | 'dashscope-token-plan'

/** 厂商清单（UI 选择器）：新建配置时按厂商自动填充默认 baseURL，用户可再手动修改。 */
export const MODEL_VENDORS: ReadonlyArray<{ id: ModelVendor; name: string; defaultBaseUrl: string }> = [
  { id: 'deepseek', name: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com' },
  { id: 'openai', name: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1' },
  {
    id: 'dashscope-token-plan',
    name: '百炼 Token Plan',
    defaultBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
  },
  { id: 'openai-compatible', name: 'OpenAI-Compatible', defaultBaseUrl: '' }
]

/**
 * 按 baseURL 主机名识别厂商；非法 URL 或未知主机一律走 openai-compatible。
 * 百炼 Token Plan 的主机 `token-plan.<region>.maas.aliyuncs.com` 精确识别（Key 以 sk-sp-
 * 开头、仅北京地域，与通用百炼端点隔离，不能混用）。
 */
export function detectVendor(baseUrl: string | undefined): ModelVendor {
  if (!baseUrl) return 'openai-compatible'
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host === 'api.deepseek.com' || host === 'api.openai.com')
      return host === 'api.deepseek.com' ? 'deepseek' : 'openai'
    if (host.startsWith('token-plan.') && host.endsWith('.maas.aliyuncs.com')) return 'dashscope-token-plan'
  } catch {
    /* 非法 URL 走兜底 */
  }
  return 'openai-compatible'
}

/**
 * 创建对应厂商的 ai-sdk 语言模型实例（driver 不感知包差异）。
 * baseURL 为空时交给各包默认值（deepseek/openai 有官方默认端点），openai-compatible 必须显式传入。
 */
export function createVendorModel(
  vendor: ModelVendor,
  options: { baseUrl?: string; apiKey?: string },
  modelId: string
): LanguageModelV4 {
  const baseURL = options.baseUrl?.replace(/\/$/, '')
  switch (vendor) {
    case 'deepseek':
      return createDeepSeek({ baseURL, apiKey: options.apiKey }).chat(modelId)
    case 'openai':
      return createOpenAI({ baseURL, apiKey: options.apiKey }).chat(modelId)
    default:
      return createOpenAICompatible({
        name: 'desktop-openai-compatible',
        baseURL: baseURL ?? '',
        apiKey: options.apiKey
      }).chatModel(modelId)
  }
}
