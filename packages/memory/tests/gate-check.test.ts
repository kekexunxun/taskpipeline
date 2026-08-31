import { describe, it, expect } from 'vitest'
import { checkGate, DEFAULT_GATE_CONFIG } from '../src/reflection/gate-check.js'

describe('checkGate', () => {
  it('冷却期未过 → 不通过', () => {
    const result = checkGate({
      pendingCandidateCount: 10,
      newEvidenceCount: 10,
      msSinceLastReflection: 1000 // 1 秒，远小于 5 分钟
    })
    expect(result.passed).toBe(false)
    expect(result.skipReasons[0]).toContain('Cooldown')
  })

  it('冷却期已过 + candidate 压力 → 通过', () => {
    const result = checkGate({
      pendingCandidateCount: 10,
      newEvidenceCount: 0,
      msSinceLastReflection: 10 * 60 * 1000 // 10 分钟
    })
    expect(result.passed).toBe(true)
    expect(result.reasons.some((r) => r.includes('Candidate pressure'))).toBe(true)
  })

  it('冷却期已过 + 证据阈值 → 通过', () => {
    const result = checkGate({
      pendingCandidateCount: 0,
      newEvidenceCount: 5,
      msSinceLastReflection: 10 * 60 * 1000
    })
    expect(result.passed).toBe(true)
    expect(result.reasons.some((r) => r.includes('Evidence threshold'))).toBe(true)
  })

  it('冷却期已过 + 无触发条件 → 不通过', () => {
    const result = checkGate({
      pendingCandidateCount: 0,
      newEvidenceCount: 0,
      msSinceLastReflection: 10 * 60 * 1000
    })
    expect(result.passed).toBe(false)
    expect(result.skipReasons).toContain('No gate condition met')
  })

  it('置信衰减触发', () => {
    const result = checkGate(
      {
        pendingCandidateCount: 0,
        newEvidenceCount: 0,
        msSinceLastReflection: 10 * 60 * 1000,
        nodesToCheck: [{ status: 'active', confidence: 0.1 } as any, { status: 'active', confidence: 0.9 } as any]
      },
      { ...DEFAULT_GATE_CONFIG, confidenceDecayThreshold: 0.3 }
    )
    expect(result.passed).toBe(true)
    expect(result.reasons.some((r) => r.includes('Confidence decay'))).toBe(true)
  })

  it('自定义配置', () => {
    const result = checkGate(
      {
        pendingCandidateCount: 2,
        newEvidenceCount: 0,
        msSinceLastReflection: 1000
      },
      { ...DEFAULT_GATE_CONFIG, cooldownMs: 500, candidatePressureThreshold: 2 }
    )
    expect(result.passed).toBe(true)
  })
})
