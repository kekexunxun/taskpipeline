import { describe, expect, it } from 'vitest'
import { resolveMrMode } from './types.js'

const resolver = (value: string | undefined) => ({ get: () => value })

describe('resolveMrMode', () => {
  it('prefers the task-level choice over the system setting', () => {
    expect(resolveMrMode({ mrAutoSubmit: 'auto' }, resolver('false'))).toBe('auto')
    expect(resolveMrMode({ mrAutoSubmit: 'manual' }, resolver('true'))).toBe('manual')
  })

  it('reads the system setting only when the task carries no explicit choice', () => {
    expect(resolveMrMode({}, resolver('true'))).toBe('auto')
    expect(resolveMrMode({}, resolver('false'))).toBe('manual')
    expect(resolveMrMode(undefined, resolver('true'))).toBe('auto')
  })

  it('defaults to manual, matching the pre-refactor resolveTaskSetting(defaults: false)', () => {
    expect(resolveMrMode({}, resolver(undefined))).toBe('manual')
    expect(resolveMrMode({}, resolver('1'))).toBe('manual')
    expect(resolveMrMode({ mrAutoSubmit: undefined }, resolver(undefined))).toBe('manual')
  })
})
