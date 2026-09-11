import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@task-pipeline/core'
import { draftGaps, formatDraftFieldValue, intakeMessages, latestDraftSuggestion } from './draftIntake'

function event(overrides: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    taskId: 'task-1',
    kind: 'status',
    title: '',
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides
  } as AgentEvent
}

const suggestionEvent = (id: string, fields: Record<string, unknown>, repositoryNames?: Record<string, string>) =>
  event({ id, payload: { type: 'draft-suggestion', fields, ...(repositoryNames ? { repositoryNames } : {}) } })

describe('intakeMessages', () => {
  it('keeps only clarification messages and marks who said them', () => {
    const messages = intakeMessages([
      event({ id: 'e1', kind: 'message', detail: '帮我补一下', payload: { type: 'draft-message', role: 'user' } }),
      event({ id: 'e2', kind: 'message', detail: '先确认范围', payload: { type: 'draft-message', role: 'assistant' } }),
      suggestionEvent('e3', { title: '新标题' }),
      event({ id: 'e4', kind: 'message', title: '你', detail: '没有载荷的老消息' })
    ])
    expect(messages).toEqual([
      { id: 'e1', me: true, text: '帮我补一下', createdAt: '2026-09-10T00:00:00.000Z' },
      { id: 'e2', me: false, text: '先确认范围', createdAt: '2026-09-10T00:00:00.000Z' }
    ])
  })

  it('drops an empty reply instead of rendering an empty bubble', () => {
    const empty = event({ id: 'e1', detail: '   ', payload: { type: 'draft-message', role: 'assistant' } })
    expect(intakeMessages([empty])).toEqual([])
  })
})

describe('latestDraftSuggestion', () => {
  it('returns the newest unresolved suggestion', () => {
    const suggestion = latestDraftSuggestion([
      suggestionEvent('old', { title: '旧标题' }),
      event({ id: 'resolved', payload: { type: 'draft-suggestion-resolved', action: 'discarded' } }),
      suggestionEvent('new', { description: '新描述' })
    ])
    expect(suggestion).toMatchObject({ eventId: 'new', fields: { description: '新描述' }, keys: ['description'] })
  })

  it('returns nothing once the newest suggestion has been resolved', () => {
    expect(
      latestDraftSuggestion([
        suggestionEvent('new', { title: '标题' }),
        event({ id: 'resolved', payload: { type: 'draft-suggestion-resolved', action: 'applied' } })
      ])
    ).toBeUndefined()
  })

  it('skips a suggestion with no usable field rather than showing an empty card', () => {
    expect(latestDraftSuggestion([suggestionEvent('empty', { keywords: [], title: '  ' })])).toBeUndefined()
  })

  it('lists fields in a fixed order regardless of what the model filled first', () => {
    const suggestion = latestDraftSuggestion([
      suggestionEvent('e1', { repositoryIds: ['r1'], title: '标题', acceptanceCriteria: ['可回滚'] })
    ])
    expect(suggestion?.keys).toEqual(['title', 'acceptanceCriteria', 'repositoryIds'])
  })
})

describe('formatDraftFieldValue', () => {
  it('shows repository names from the snapshot and falls back to the id', () => {
    const suggestion = latestDraftSuggestion([
      suggestionEvent('e1', { repositoryIds: ['r1', 'r2'] }, { r1: 'codingagent' })
    ])!
    expect(formatDraftFieldValue('repositoryIds', suggestion)).toBe('codingagent、r2')
  })

  it('puts each acceptance criterion on its own line and joins keywords inline', () => {
    const suggestion = latestDraftSuggestion([
      suggestionEvent('e1', { keywords: ['ipc', 'draft'], acceptanceCriteria: ['能采纳', '能丢弃'] })
    ])!
    expect(formatDraftFieldValue('keywords', suggestion)).toBe('ipc、draft')
    expect(formatDraftFieldValue('acceptanceCriteria', suggestion)).toBe('能采纳\n能丢弃')
  })
})

describe('draftGaps', () => {
  it('flags a description shorter than the threshold', () => {
    const filled = { description: '描'.repeat(40), acceptanceCriteria: ['可判定'] }
    expect(draftGaps(filled, 1)).toEqual([])
    expect(draftGaps({ ...filled, description: '描'.repeat(39) }, 1)).toEqual(['description'])
  })

  it('reports every missing item at once so the hint says all of them', () => {
    expect(draftGaps({ description: '', acceptanceCriteria: [] }, 0)).toEqual([
      'description',
      'acceptanceCriteria',
      'repositories'
    ])
  })
})
