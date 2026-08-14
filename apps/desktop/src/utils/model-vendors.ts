/**
 * 模型厂商清单（前端版）。
 *
 * 与 electron/chat/drivers/model-providers.ts 双写（跨进程边界无法共享模块）：
 * - MODEL_VENDORS：厂商选择器选项与默认 baseURL；
 * - detectVendor：读取存量配置时按 baseUrl 主机名识别 vendor，识别不出走 openai-compatible。
 */

export type ModelVendor = 'deepseek' | 'openai' | 'openai-compatible' | 'dashscope-token-plan'

export const MODEL_VENDORS: ReadonlyArray<{
  id: ModelVendor
  name: string
  defaultBaseUrl: string
  /** 开箱即用模型列表（UI 分组展示 + 可继续手输）；缺省 = 自由填写。 */
  models?: ReadonlyArray<{ label: string; items: readonly string[] }>
}> = [
  { id: 'deepseek', name: 'DeepSeek 官方', defaultBaseUrl: 'https://api.deepseek.com' },
  { id: 'openai', name: 'OpenAI 官方', defaultBaseUrl: 'https://api.openai.com/v1' },
  {
    id: 'dashscope-token-plan',
    name: '百炼 Token Plan',
    defaultBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    // Token Plan 个人版「支持的模型」完整列表（与官方文档同步，2026-08）。
    // 对话/推理/视觉类走 Chat Completions 可直接使用；生成/语音类走独立接口，
    // 当前产品不接入，仅列出以免用户误以为缺失。
    models: [
      {
        label: '对话 / 推理',
        items: [
          'qwen3.8-max',
          'qwen3.7-max',
          'qwen3.7-plus',
          'qwen3.6-flash',
          'deepseek-v4-pro',
          'deepseek-v4-flash-0731',
          'glm-5.2'
        ]
      },
      {
        label: '生成 / 语音（非对话模型）',
        items: [
          'qwen-audio-3.0-tts-plus',
          'qwen-audio-3.0-realtime-plus',
          'wan2.7-image',
          'wan2.7-image-pro',
          'happyhorse-1.1-i2v',
          'happyhorse-1.1-t2v',
          'happyhorse-1.1-r2v'
        ]
      }
    ]
  },
  { id: 'openai-compatible', name: 'OpenAI-Compatible', defaultBaseUrl: '' }
]

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
