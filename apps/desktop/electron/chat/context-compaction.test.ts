import { describe, expect, it } from 'vitest'
import type { ChatDriver } from './drivers/chat-driver.js'
import type { StoredMessageRecord } from './chat-types.js'
import { trimHistoryToBudget } from './context-budget.js'
import {
  COMPACTION_TRIGGER_TOKENS,
  SUMMARY_SYSTEM_PREFIX,
  buildCompaction,
  buildCompactionTranscript,
  excludeCoveredRecords,
  makeSummarySystemRecord,
  shouldCompact,
  summarizeOverflow
} from './context-compaction.js'

function rec(role: StoredMessageRecord['role'], id: string, text: string): StoredMessageRecord {
  return { id, role, createdAt: 't', driverId: 'openai', raw: { kind: role, text } }
}
function bigRec(id: string, tokens: number, role: StoredMessageRecord['role'] = 'user'): StoredMessageRecord {
  return rec(role, id, 'x'.repeat(tokens * 4))
}

/** 最小 driver 替身：只覆盖 compaction 用到的方法。 */
function fakeDriver(streamChat: ChatDriver['streamChat']): ChatDriver {
  return {
    id: 'openai',
    displayName: 'OpenAI',
    listModels: async () => [],
    deserializeMessage: (record: StoredMessageRecord) =>
      ({ ...record, parts: [{ type: 'text', text: (record.raw as { text?: string }).text ?? '' }] }) as never,
    serializeUserMessage: (input: Parameters<ChatDriver['serializeUserMessage']>[0]) =>
      ({
        id: input.id,
        role: 'user',
        createdAt: input.createdAt,
        driverId: 'openai',
        raw: { kind: 'user', text: input.text }
      }) as never,
    streamChat,
    dispose: () => undefined
  } as unknown as ChatDriver
}

describe('shouldCompact', () => {
  it('溢出 token 未达阈值时不触发', () => {
    const tokens = Math.floor(COMPACTION_TRIGGER_TOKENS / 4) - 100
    expect(shouldCompact([bigRec('u1', 10), bigRec('a1', tokens, 'assistant')])).toBe(false)
  })
  it('溢出 token 达阈值时触发', () => {
    expect(shouldCompact([bigRec('u1', COMPACTION_TRIGGER_TOKENS)])).toBe(true)
  })
  it('空溢出不触发', () => {
    expect(shouldCompact([])).toBe(false)
  })
  it('上下文占用达 80% 时,少量溢出也立即触发', () => {
    expect(shouldCompact([bigRec('u1', 10)], { contextReached: true })).toBe(true)
  })
  it('上下文占用达阈但无溢出时仍不触发（无事可摘）', () => {
    expect(shouldCompact([], { contextReached: true })).toBe(false)
  })
})

describe('excludeCoveredRecords', () => {
  it('排除覆盖 id 及其之前的非 system 记录，保留 system 与更晚记录', () => {
    const records = [
      rec('user', 'u1', 'old'),
      rec('assistant', 'a1', 'old'),
      rec('system', 's1', 'keep me'),
      rec('user', 'u2', 'new'),
      rec('assistant', 'a2', 'new')
    ]
    const out = excludeCoveredRecords(records, 'a1')
    const ids = out.map((r) => r.id)
    expect(ids).not.toContain('u1')
    expect(ids).not.toContain('a1')
    expect(ids).toContain('s1')
    expect(ids).toContain('u2')
    expect(ids).toContain('a2')
  })
  it('覆盖 id 不存在（陈旧）时不排除任何记录', () => {
    const records = [rec('user', 'u1', 'a'), rec('assistant', 'a1', 'b')]
    expect(excludeCoveredRecords(records, 'missing')).toEqual(records)
  })
  it('无覆盖 id 时原样返回', () => {
    const records = [rec('user', 'u1', 'a')]
    expect(excludeCoveredRecords(records, undefined)).toEqual(records)
  })
})

describe('makeSummarySystemRecord / buildCompaction', () => {
  it('摘要记录为 system 角色且带前缀', () => {
    const r = makeSummarySystemRecord('c1', '结论X', 'openai', 't')
    expect(r.role).toBe('system')
    expect((r.raw as { text: string }).text).toContain(SUMMARY_SYSTEM_PREFIX)
    expect((r.raw as { text: string }).text).toContain('结论X')
  })
  it('覆盖边界取溢出批次最后一条消息 id', () => {
    const overflow = [rec('user', 'u1', 'a'), rec('assistant', 'a1', 'b')]
    const c = buildCompaction(overflow, '摘要')
    expect(c?.coveredUntilMessageId).toBe('a1')
    expect(c?.summary).toBe('摘要')
  })
})

describe('buildCompactionTranscript', () => {
  it('按角色前缀拼接非 system 文本', () => {
    const driver = fakeDriver(async function* () {})
    const text = buildCompactionTranscript(driver, [
      rec('user', 'u1', '问题'),
      rec('system', 's1', '忽略'),
      rec('assistant', 'a1', '回答')
    ])
    expect(text).toContain('用户：问题')
    expect(text).toContain('助手：回答')
    expect(text).not.toContain('忽略')
  })
})

describe('summarizeOverflow', () => {
  it('收集 text part 作为摘要正文', async () => {
    const driver = fakeDriver(async function* () {
      yield { type: 'part', part: { driverId: 'openai', type: 'text', text: '压缩' } }
      yield { type: 'part', part: { driverId: 'openai', type: 'text', text: '结果' } }
      yield { type: 'done', status: 'done' }
    })
    const summary = await summarizeOverflow({ driver, driverId: 'openai', model: 'm', transcript: '对话…' })
    expect(summary).toBe('压缩结果')
  })

  it('辅助调用抛错时降级返回 undefined（不阻断）', async () => {
    const driver = fakeDriver((() => {
      throw new Error('llm down')
    }) as ChatDriver['streamChat'])
    const summary = await summarizeOverflow({ driver, driverId: 'openai', model: 'm', transcript: '对话…' })
    expect(summary).toBeUndefined()
  })

  it('返回空白文本视为失败，undefined', async () => {
    const driver = fakeDriver(async function* () {
      yield { type: 'part', part: { driverId: 'openai', type: 'text', text: '   ' } }
    } as ChatDriver['streamChat'])
    expect(await summarizeOverflow({ driver, driverId: 'openai', model: 'm', transcript: 'x' })).toBeUndefined()
  })
})

describe('2-B 组装不变量（排除 + 摘要注入 + 2-A 裁剪串联）', () => {
  it('超预算历史：轮次下降、system 含摘要、覆盖边界之后消息不丢失、最近轮逐字保留', () => {
    // 五轮对话，每轮 ~600 tokens；已有 compaction 覆盖到 a2。
    const records = [
      bigRec('u1', 600),
      bigRec('a1', 600, 'assistant'),
      bigRec('u2', 600),
      bigRec('a2', 600, 'assistant'),
      bigRec('u3', 600),
      bigRec('a3', 600, 'assistant'),
      bigRec('u4', 600),
      bigRec('a4', 600, 'assistant'),
      bigRec('u5', 600)
    ]
    const summaryRecord = makeSummarySystemRecord('c', '早期结论汇总', 'openai', 't')
    // 1) 排除已覆盖轮次（u1..a2）。
    const afterExclude = excludeCoveredRecords([...records], 'a2')
    expect(afterExclude.map((r) => r.id)).not.toContain('u1')
    expect(afterExclude.map((r) => r.id)).not.toContain('a2')
    // 2) 摘要作为 system 注入最前。
    const withSummary = [summaryRecord, ...afterExclude]
    // 3) 2-A 裁剪到预算。
    const trimmed = trimHistoryToBudget({ records: withSummary, budgetTokens: 1400 })
    expect(trimmed.kept.length).toBeLessThan(withSummary.length)
    const ids = trimmed.kept.map((r) => r.id)
    // system 摘要始终保留且含摘要正文。
    expect(ids).toContain('compaction-c')
    // 覆盖边界之后的消息（u3 及以后）不因排除而丢失（可能因预算再裁，但 u1/a1/a2 绝不回来）。
    expect(ids).not.toContain('u1')
    expect(ids).not.toContain('a1')
    expect(ids).not.toContain('a2')
    // 最近一轮（当前提问 u5）逐字保留在末尾。
    expect(trimmed.kept.at(-1)?.id).toBe('u5')
    const keptU5 = trimmed.kept.find((r) => r.id === 'u5')
    expect((keptU5?.raw as { text: string }).text).toBe('x'.repeat(600 * 4))
    // 溢出集为非 system 的更早轮次，且都在覆盖边界之后。
    for (const d of trimmed.dropped) {
      expect(d.role).not.toBe('system')
      expect(['u3', 'a3', 'u4', 'a4']).toContain(d.id)
    }
  })
})
