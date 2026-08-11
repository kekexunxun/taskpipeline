/**
 * 模型厂商清单（前端版）。
 *
 * 与 electron/chat/drivers/model-providers.ts 双写（跨进程边界无法共享模块）：
 * - MODEL_VENDORS：厂商选择器选项与默认 baseURL；
 * - detectVendor：读取存量配置时按 baseUrl 主机名识别 vendor，识别不出走 openai-compatible。
 */

export type ModelVendor = 'deepseek' | 'openai' | 'openai-compatible'

export const MODEL_VENDORS: ReadonlyArray<{ id: ModelVendor; name: string; defaultBaseUrl: string }> = [
  { id: 'deepseek', name: 'DeepSeek 官方', defaultBaseUrl: 'https://api.deepseek.com' },
  { id: 'openai', name: 'OpenAI 官方', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'openai-compatible', name: '其它兼容端点', defaultBaseUrl: '' }
]

export function detectVendor(baseUrl: string | undefined): ModelVendor {
  if (!baseUrl) return 'openai-compatible'
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host === 'api.deepseek.com' || host === 'api.openai.com')
      return host === 'api.deepseek.com' ? 'deepseek' : 'openai'
  } catch {
    /* 非法 URL 走兜底 */
  }
  return 'openai-compatible'
}
