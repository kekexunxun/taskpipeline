import { describe, expect, it, vi } from 'vitest'

/**
 * 厂商注册表测试：detectVendor 按 baseUrl 识别，createVendorModel 按厂商选包。
 * 三个 ai-sdk provider 包全部 mock，只验证分发逻辑与调用参数。
 */
const calls: Array<{ vendor: string; baseUrl?: string; apiKey?: string; model: string }> = vi.hoisted(
  () => [] as Array<{ vendor: string; baseUrl?: string; apiKey?: string; model: string }>
)

vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: (options: { baseURL?: string; apiKey?: string }) => ({
    chat: (model: string) => {
      calls.push({ vendor: 'deepseek', baseUrl: options.baseURL, apiKey: options.apiKey, model })
      return { modelId: model }
    }
  })
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (options: { baseURL?: string; apiKey?: string }) => ({
    chat: (model: string) => {
      calls.push({ vendor: 'openai', baseUrl: options.baseURL, apiKey: options.apiKey, model })
      return { modelId: model }
    }
  })
}))

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: (options: { name: string; baseURL?: string; apiKey?: string }) => ({
    chatModel: (model: string) => {
      calls.push({ vendor: 'openai-compatible', baseUrl: options.baseURL, apiKey: options.apiKey, model })
      return { modelId: model }
    }
  })
}))

const { detectVendor, createVendorModel, MODEL_VENDORS } = await import('./model-providers.js')

function resetCalls(): void {
  calls.length = 0
}

describe('detectVendor', () => {
  it('recognizes official DeepSeek baseUrl', () => {
    expect(detectVendor('https://api.deepseek.com')).toBe('deepseek')
    expect(detectVendor('https://api.deepseek.com/v1')).toBe('deepseek')
  })

  it('recognizes official OpenAI baseUrl', () => {
    expect(detectVendor('https://api.openai.com/v1')).toBe('openai')
    expect(detectVendor('https://api.openai.com')).toBe('openai')
  })

  it('falls back to openai-compatible for unknown or invalid baseUrl', () => {
    expect(detectVendor('https://gateway.example.com/v1')).toBe('openai-compatible')
    expect(detectVendor('https://api.siliconflow.cn/v1')).toBe('openai-compatible')
    expect(detectVendor(undefined)).toBe('openai-compatible')
    expect(detectVendor('not-a-url')).toBe('openai-compatible')
  })
})

describe('createVendorModel', () => {
  it('creates model via @ai-sdk/deepseek and strips trailing slash', () => {
    resetCalls()
    createVendorModel('deepseek', { baseUrl: 'https://api.deepseek.com/', apiKey: 'k1' }, 'deepseek-chat')
    expect(calls).toEqual([
      { vendor: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'k1', model: 'deepseek-chat' }
    ])
  })

  it('creates model via @ai-sdk/openai', () => {
    resetCalls()
    createVendorModel('openai', { baseUrl: 'https://api.openai.com/v1', apiKey: 'k2' }, 'gpt-5')
    expect(calls).toEqual([{ vendor: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k2', model: 'gpt-5' }])
  })

  it('creates model via @ai-sdk/openai-compatible with fixed provider name', () => {
    resetCalls()
    createVendorModel('openai-compatible', { baseUrl: 'https://gateway.example.com/v1', apiKey: 'k3' }, 'qwen-max')
    expect(calls).toEqual([
      { vendor: 'openai-compatible', baseUrl: 'https://gateway.example.com/v1', apiKey: 'k3', model: 'qwen-max' }
    ])
  })

  it('passes empty baseUrl through to openai-compatible (driver 已前置校验)', () => {
    resetCalls()
    createVendorModel('openai-compatible', { apiKey: 'k4' }, 'm')
    expect(calls).toEqual([{ vendor: 'openai-compatible', baseUrl: '', apiKey: 'k4', model: 'm' }])
  })
})

describe('MODEL_VENDORS', () => {
  it('lists the three supported vendors with distinct ids and default baseUrls', () => {
    expect(MODEL_VENDORS.map((v) => v.id)).toEqual(['deepseek', 'openai', 'openai-compatible'])
    expect(MODEL_VENDORS.find((v) => v.id === 'deepseek')?.defaultBaseUrl).toBe('https://api.deepseek.com')
    expect(MODEL_VENDORS.find((v) => v.id === 'openai')?.defaultBaseUrl).toBe('https://api.openai.com/v1')
    expect(MODEL_VENDORS.find((v) => v.id === 'openai-compatible')?.defaultBaseUrl).toBe('')
  })
})
