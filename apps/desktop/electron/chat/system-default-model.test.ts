import { describe, expect, it } from 'vitest'
import { isModelAvailable, pickSystemDefaultModel } from './system-default-model.js'
import type { ChatModelGroup } from './chat-types.js'

/** 构造分组测试替身。 */
function group(driverId: 'qoder' | 'openai', models: Array<{ value: string; isDefault?: boolean }>): ChatModelGroup {
  return {
    driverId,
    displayName: driverId,
    models: models.map((m) => ({ value: m.value, displayName: m.value, isDefault: m.isDefault }))
  }
}

describe('pickSystemDefaultModel', () => {
  it('prefers the qoder group over openai', () => {
    const groups = [
      group('openai', [{ value: 'openai:gpt-4o' }]),
      group('qoder', [{ value: 'qoder:claude-sonnet-4.5' }])
    ]
    expect(pickSystemDefaultModel(groups)).toEqual({ driverId: 'qoder', model: 'qoder:claude-sonnet-4.5' })
  })

  it('falls back to the first group when qoder is absent', () => {
    const groups = [group('openai', [{ value: 'openai:gpt-4o' }])]
    expect(pickSystemDefaultModel(groups)).toEqual({ driverId: 'openai', model: 'openai:gpt-4o' })
  })

  it('picks the isDefault model inside the preferred group', () => {
    const groups = [group('qoder', [{ value: 'qoder:first' }, { value: 'qoder:marked', isDefault: true }])]
    expect(pickSystemDefaultModel(groups)).toEqual({ driverId: 'qoder', model: 'qoder:marked' })
  })

  it('picks the first model when none is marked default', () => {
    const groups = [group('qoder', [{ value: 'qoder:first' }, { value: 'qoder:second' }])]
    expect(pickSystemDefaultModel(groups)).toEqual({ driverId: 'qoder', model: 'qoder:first' })
  })

  it('returns undefined for empty groups', () => {
    expect(pickSystemDefaultModel([])).toBeUndefined()
  })

  it('returns undefined when the preferred group has no models', () => {
    expect(pickSystemDefaultModel([group('qoder', [])])).toBeUndefined()
  })
})

describe('isModelAvailable', () => {
  const groups = [group('qoder', [{ value: 'qoder:claude-sonnet-4.5' }]), group('openai', [{ value: 'openai:gpt-4o' }])]

  it('returns true for an existing value in any group', () => {
    expect(isModelAvailable(groups, 'qoder:claude-sonnet-4.5')).toBe(true)
    expect(isModelAvailable(groups, 'openai:gpt-4o')).toBe(true)
  })

  it('returns false for a missing / empty value', () => {
    expect(isModelAvailable(groups, 'qoder:retired')).toBe(false)
    expect(isModelAvailable(groups, undefined)).toBe(false)
    expect(isModelAvailable(groups, '')).toBe(false)
  })
})
