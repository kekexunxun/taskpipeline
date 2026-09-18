import { describe, expect, it } from 'vitest'
import type { StoredMessageRecord } from './chat-types.js'
import { estimateRecordTokens, trimHistoryToBudget } from './context-budget.js'

function rec(role: StoredMessageRecord['role'], id: string, text: string): StoredMessageRecord {
  return { id, role, createdAt: 't', driverId: 'openai', raw: { kind: role, text } }
}

/** 造一条约 target tokens 的记录（char/4 → 长度 target*4）。 */
function bigRec(role: StoredMessageRecord['role'], id: string, targetTokens: number): StoredMessageRecord {
  return rec(role, id, 'x'.repeat(targetTokens * 4))
}

describe('trimHistoryToBudget', () => {
  it('未超预算时原样返回（短对话行为不变）', () => {
    const records = [rec('user', 'u1', 'hi'), rec('assistant', 'a1', 'hello'), rec('user', 'u2', 'again')]
    const out = trimHistoryToBudget({ records, budgetTokens: 10_000 })
    expect(out.dropped).toEqual([])
    expect(out.kept).toEqual(records)
  })

  it('超预算时从最早轮次起成对丢弃，保留最近轮与当前提问', () => {
    // 三轮对话，每轮 user+assistant 各 ~50 tokens；预算 120 → 只能留最近一轮 + 当前 user。
    const records = [
      bigRec('user', 'u1', 50),
      bigRec('assistant', 'a1', 50),
      bigRec('user', 'u2', 50),
      bigRec('assistant', 'a2', 50),
      bigRec('user', 'u3', 50)
    ]
    const out = trimHistoryToBudget({ records, budgetTokens: 120 })
    const keptIds = out.kept.map((r) => r.id)
    // 最早轮（u1+a1）被丢；最近轮 u3 保留。
    expect(keptIds).not.toContain('u1')
    expect(keptIds).not.toContain('a1')
    expect(keptIds).toContain('u3')
    // 丢弃始终按轮成对：不会留下孤儿 assistant 而无其 user。
    const droppedIds = out.dropped.map((r) => r.id)
    expect(droppedIds).toContain('u1')
    expect(droppedIds).toContain('a1')
    // 保持原始相对顺序（末条仍是当前 user）。
    expect(out.kept.at(-1)?.id).toBe('u3')
  })

  it('始终保留 system 记录', () => {
    const records = [
      rec('system', 's1', 'workspace context'),
      bigRec('user', 'u1', 50),
      bigRec('assistant', 'a1', 50),
      bigRec('user', 'u2', 50),
      rec('system', 's2', 'memory context')
    ]
    const out = trimHistoryToBudget({ records, budgetTokens: 60 })
    const keptIds = out.kept.map((r) => r.id)
    expect(keptIds).toContain('s1')
    expect(keptIds).toContain('s2')
  })

  it('lastUsageTokens 超过预算时触发裁剪（即使估算未超）', () => {
    const records = [rec('user', 'u1', 'hi'), rec('assistant', 'a1', 'x'.repeat(400)), rec('user', 'u2', 'again')]
    const est = records.reduce((s, r) => s + estimateRecordTokens(r), 0)
    // 估算低于预算，但实测上一轮 input 远高于预算 → 仍应裁剪。
    expect(est).toBeLessThan(5000)
    const out = trimHistoryToBudget({ records, budgetTokens: 100, lastUsageTokens: 20_000 })
    expect(out.kept.length).toBeLessThan(records.length)
    expect(out.dropped.length).toBeGreaterThan(0)
  })

  it('最后一轮即便超预算也强制保留（不可丢当前提问）', () => {
    const records = [bigRec('user', 'u1', 300), bigRec('assistant', 'a1', 300), bigRec('user', 'u2', 300)]
    const out = trimHistoryToBudget({ records, budgetTokens: 50 })
    // 预算极小，只能留最后一轮。
    expect(out.kept.map((r) => r.id)).toEqual(['u2'])
  })

  it('实测超预算但字符估算仍低于预算时，按实测缩放仍能裁出溢出轮次（触发压缩链路）', () => {
    // 估算 total 低于预算，但字符/4 严重低估——实测上一轮 input 远高于预算：
    // 修复前 remaining=估算(已<预算) → 立即 break、dropped 恒空 → 压缩永不触发。
    const records = [
      bigRec('user', 'u1', 100),
      bigRec('assistant', 'a1', 100),
      bigRec('user', 'u2', 100),
      bigRec('assistant', 'a2', 100),
      bigRec('user', 'u3', 100),
      bigRec('assistant', 'a3', 100),
      bigRec('user', 'u4', 100)
    ]
    const est = records.reduce((s, r) => s + estimateRecordTokens(r), 0)
    // 估算落在预算内，实测却超预算——正是旧缺陷的触发条件。
    expect(est).toBeLessThan(1000)
    const out = trimHistoryToBudget({ records, budgetTokens: 1000, lastUsageTokens: 2000 })
    expect(out.dropped.length).toBeGreaterThan(0)
    expect(out.kept.length).toBeLessThan(records.length)
    // 末轮（当前提问）始终保留，丢弃从最早轮次开始。
    expect(out.kept.at(-1)?.id).toBe('u4')
    expect(out.dropped.map((r) => r.id)).toContain('u1')
  })
})
