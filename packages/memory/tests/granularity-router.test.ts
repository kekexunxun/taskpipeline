import { describe, it, expect } from 'vitest'
import { getGranularityLayers, getPrimaryLayer } from '../src/retrieval/granularity-router.js'

describe('getGranularityLayers', () => {
  it('bug_fix → proposition, paragraph', () => {
    expect(getGranularityLayers('bug_fix')).toEqual(['proposition', 'paragraph'])
  })

  it('architecture_review → summary, paragraph', () => {
    expect(getGranularityLayers('architecture_review')).toEqual(['summary', 'paragraph'])
  })

  it('feature_implementation → chunk, proposition', () => {
    expect(getGranularityLayers('feature_implementation')).toEqual(['chunk', 'proposition'])
  })

  it('general → paragraph, chunk', () => {
    expect(getGranularityLayers('general')).toEqual(['paragraph', 'chunk'])
  })
})

describe('getPrimaryLayer', () => {
  it('bug_fix 首选 proposition', () => {
    expect(getPrimaryLayer('bug_fix')).toBe('proposition')
  })

  it('architecture_review 首选 summary', () => {
    expect(getPrimaryLayer('architecture_review')).toBe('summary')
  })

  it('feature_implementation 首选 chunk', () => {
    expect(getPrimaryLayer('feature_implementation')).toBe('chunk')
  })

  it('general 首选 paragraph', () => {
    expect(getPrimaryLayer('general')).toBe('paragraph')
  })
})
