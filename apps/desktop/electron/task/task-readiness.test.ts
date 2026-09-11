import { describe, expect, it } from 'vitest'
import { TASK_STATES } from '@task-pipeline/core'
import {
  assertDraftIntake,
  isExplicitNoChangeCompletionRequest,
  nextStepForImplementation,
  nextStepForPlan,
  parseImplementationDecision
} from './task-readiness.js'

describe('parseImplementationDecision', () => {
  it('uses the explicit outcome marker', () => {
    expect(
      parseImplementationDecision([
        'I need the acceptance criteria before I can continue.\n<!-- task-pipeline-outcome:needs_input -->'
      ])
    ).toMatchObject({ outcome: 'needs_input', content: 'I need the acceptance criteria before I can continue.' })
  })

  it('recognizes legacy clarification and already-satisfied responses', () => {
    expect(
      parseImplementationDecision(['Could you share the full acceptance criteria before I can start?']).outcome
    ).toBe('needs_input')
    expect(parseImplementationDecision(['当前代码已满足任务要求，无需修改。']).outcome).toBe('already_satisfied')
  })

  it('does not let a generic SDK result hide an earlier clarification request', () => {
    expect(
      parseImplementationDecision(['Could you share the full acceptance criteria before I can start?', 'success'])
    ).toMatchObject({ outcome: 'needs_input' })
  })

  it('keeps an unclassified response unknown', () => {
    expect(parseImplementationDecision(['I inspected the repository.']).outcome).toBe('unknown')
  })
})

describe('nextStepForImplementation', () => {
  it('waits for input even when partial file changes exist', () => {
    expect(nextStepForImplementation('needs_input', 2)).toBe('await_input')
  })

  it('only completes an already-satisfied task when there are no changes', () => {
    expect(nextStepForImplementation('already_satisfied', 0)).toBe('complete_without_changes')
    expect(nextStepForImplementation('already_satisfied', 1)).toBe('await_confirmation')
  })

  it('only validates a completed implementation when files changed', () => {
    expect(nextStepForImplementation('completed', 1)).toBe('validate')
    expect(nextStepForImplementation('completed', 0)).toBe('await_confirmation')
    expect(nextStepForImplementation('unknown', 1)).toBe('await_confirmation')
  })
})

describe('nextStepForPlan', () => {
  it('only auto-completes an already-satisfied plan when the worktree is clean', () => {
    expect(nextStepForPlan('already_satisfied', 0)).toBe('complete_without_changes')
    expect(nextStepForPlan('already_satisfied', 1)).toBe('await_plan_approval')
    expect(nextStepForPlan('changes_required', 0)).toBe('await_plan_approval')
  })
})

describe('isExplicitNoChangeCompletionRequest', () => {
  it('recognizes an explicit request to finish without doing work', () => {
    expect(isExplicitNoChangeCompletionRequest('没有，什么都不用做，直接完成吧')).toBe(true)
    expect(isExplicitNoChangeCompletionRequest('No changes are needed. Please complete the task.')).toBe(true)
  })

  it('does not treat ordinary completion or clarification messages as a skip request', () => {
    expect(isExplicitNoChangeCompletionRequest('修改完成后直接结束任务')).toBe(false)
    expect(isExplicitNoChangeCompletionRequest('我来补充验收标准')).toBe(false)
  })
})

describe('assertDraftIntake', () => {
  it('lets a draft task open the clarification session', () => {
    expect(() => assertDraftIntake('draft')).not.toThrow()
  })

  // 逐状态扫而不只测一个代表：这条 guard 的全部意义就是「除了 draft 都不行」，
  // 以后往状态机里加一个状态时，漏放开这里比漏测这里更容易。
  it('rejects every other state so clarifying cannot start the pipeline', () => {
    const rejected = TASK_STATES.filter((state) => state !== 'draft')
    expect(rejected.length).toBe(TASK_STATES.length - 1)
    for (const state of rejected) expect(() => assertDraftIntake(state), state).toThrow('待处理')
  })
})
