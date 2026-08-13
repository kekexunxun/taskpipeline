import { describe, expect, it } from 'vitest'
import type { ChatModelGroup } from '../api'
import { isModelAvailable, pickSystemDefaultModel } from './chat-models'

/** 构造分组测试替身。 */
function group(
  driverId: 'qoder' | 'openai',
  models: Array<{ value: string; isDefault?: boolean; priceFactor?: number }>
): ChatModelGroup {
  return {
    driverId,
    displayName: driverId,
    models: models.map((m) => ({
      value: m.value,
      displayName: m.value,
      ...(m.isDefault !== undefined ? { isDefault: m.isDefault } : {}),
      ...(m.priceFactor !== undefined ? { priceFactor: m.priceFactor } : {})
    }))
  }
}

describe('pickSystemDefaultModel(前端默认选择)', () => {
  it('qoder 组优先,组内取 isDefault 模型', () => {
    const groups = [
      group('openai', [{ value: 'openai:gpt-4o', isDefault: true }]),
      group('qoder', [{ value: 'qoder:a' }, { value: 'qoder:b', isDefault: true }])
    ]
    expect(pickSystemDefaultModel(groups)).toEqual({ driverId: 'qoder', model: 'qoder:b' })
  })

  it('qoder 组无 isDefault 标记时取组内第一个(不再跨组找 isDefault 错选 openai)', () => {
    const groups = [
      group('openai', [{ value: 'openai:gpt-4o', isDefault: true }]),
      group('qoder', [{ value: 'qoder:a' }, { value: 'qoder:b' }])
    ]
    expect(pickSystemDefaultModel(groups)).toEqual({ driverId: 'qoder', model: 'qoder:a' })
  })

  it('qoder 组无 isDefault 时回落免费 lite(无 credit 场景)', () => {
    const groups = [
      group('qoder', [
        { value: 'qoder:claude-sonnet-4.5', priceFactor: 1 },
        { value: 'qoder:qwen-lite', priceFactor: 0 }
      ])
    ]
    expect(pickSystemDefaultModel(groups)).toEqual({ driverId: 'qoder', model: 'qoder:qwen-lite' })
  })

  it('无 qoder 组时落到第一个分组', () => {
    const groups = [group('openai', [{ value: 'openai:gpt-4o' }])]
    expect(pickSystemDefaultModel(groups)).toEqual({ driverId: 'openai', model: 'openai:gpt-4o' })
  })

  it('空列表返回 undefined', () => {
    expect(pickSystemDefaultModel([])).toBeUndefined()
  })
})

describe('isModelAvailable(加载对话失效校验)', () => {
  const groups = [group('qoder', [{ value: 'qoder:a' }]), group('openai', [{ value: 'openai:gpt-4o' }])]

  it('存在的 value 有效,失效/空值无效', () => {
    expect(isModelAvailable(groups, 'qoder:a')).toBe(true)
    expect(isModelAvailable(groups, 'openai:gpt-4o')).toBe(true)
    expect(isModelAvailable(groups, 'openai:deleted-profile')).toBe(false)
    expect(isModelAvailable(groups, undefined)).toBe(false)
  })
})
