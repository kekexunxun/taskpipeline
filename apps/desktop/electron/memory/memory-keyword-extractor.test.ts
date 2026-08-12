import { describe, expect, it } from 'vitest'
import type { ChatDriver } from '../chat/drivers/chat-driver'
import type { ChatStreamChunk } from '../chat/chat-types'
import { extractKeywords, fallbackKeywords, parseExtractedKeywords } from './memory-keyword-extractor'

/** 记录 streamChat 入参 + closeSession 调用的 fake driver（会话隔离断言用）。 */
function createFakeDriver(replyText: string) {
  const calls: Array<{ conversationId: string; traceId?: string; traceLabel?: string }> = []
  const closed: string[] = []
  const driver: ChatDriver = {
    id: 'qoder',
    displayName: 'Fake',
    async listModels() {
      return []
    },
    deserializeMessage(record) {
      return { ...record, parts: [] }
    },
    serializeUserMessage(input) {
      return { id: input.id, role: 'user', createdAt: input.createdAt, driverId: 'qoder', raw: { text: input.text } }
    },
    serializeAssistantMessage(input) {
      return { id: input.id, role: 'assistant', createdAt: input.createdAt, driverId: 'qoder', raw: {} }
    },
    async *streamChat(input) {
      calls.push({ conversationId: input.conversationId, traceId: input.traceId, traceLabel: input.traceLabel })
      yield { type: 'part', part: { driverId: 'qoder', type: 'text', text: replyText } }
    },
    closeSession(id) {
      closed.push(id)
    },
    dispose() {}
  }
  return { driver, calls, closed }
}

describe('parseExtractedKeywords', () => {
  it('解析干净 JSON 数组', () => {
    expect(parseExtractedKeywords('{"keywords":["结算页","优惠券","重试策略"]}')).toEqual([
      '结算页',
      '优惠券',
      '重试策略'
    ])
  })

  it('剥掉 Markdown 围栏', () => {
    const text = '```json\n{"keywords":["结算页","iOS"]}\n```'
    expect(parseExtractedKeywords(text)).toEqual(['结算页', 'iOS'])
  })

  it('从夹了开场白的文本里抓出最外层 JSON 对象', () => {
    const text = '好的，我已经分析完了。关键词如下：\n{"keywords":["MySQL","死锁排查","InnoDB"]}\n希望对你有帮助。'
    expect(parseExtractedKeywords(text)).toEqual(['MySQL', '死锁排查', 'InnoDB'])
  })

  it('JSON 解析失败时回退到抓所有被双引号包裹的字符串', () => {
    const text = '我建议关注这些："结算页" 和 "幂等键"，再加上 "MySQL 死锁"。'
    const result = parseExtractedKeywords(text)
    // 期望里面包含这些关键词（顺序按出现顺序）
    expect(result).toContain('结算页')
    expect(result).toContain('幂等键')
    expect(result).toContain('MySQL 死锁')
  })

  it('去重 + 上限 10', () => {
    const text = '{"keywords":["a","b","a","c","d","e","f","g","h","i","j","k","l","m","n","o"]}'
    const result = parseExtractedKeywords(text)
    expect(result.length).toBe(10)
    expect(new Set(result).size).toBe(result.length)
  })

  it('空文本 / 空 keywords 数组都返回空', () => {
    expect(parseExtractedKeywords('')).toEqual([])
    expect(parseExtractedKeywords('{}')).toEqual([])
    expect(parseExtractedKeywords('{"keywords":[]}')).toEqual([])
  })

  it('keywords 字段不是数组时返回空', () => {
    expect(parseExtractedKeywords('{"keywords":"结算页"}')).toEqual([])
    expect(parseExtractedKeywords('{"keywords":null}')).toEqual([])
  })
})

describe('fallbackKeywords', () => {
  it('纯中文：保留整段 + 切 3 字 n-gram', () => {
    const result = fallbackKeywords('MySQL 死锁排查')
    expect(result).toContain('MySQL')
    expect(result).toContain('死锁排查')
    expect(result).toContain('死锁排')
    expect(result).toContain('锁排查')
  })

  it('纯英文/数字 token 按非字母数字切', () => {
    const result = fallbackKeywords('OpenAI gpt-4o turbo')
    expect(result).toContain('OpenAI')
    expect(result).toContain('gpt-4o')
    expect(result).toContain('turbo')
  })

  it('文件路径里的 - _ . 保留为 token 内部字符', () => {
    const result = fallbackKeywords('see src/foo_bar.test.ts')
    expect(result).toContain('src')
    expect(result).toContain('foo_bar.test.ts')
  })

  it('空 query 返回空数组', () => {
    expect(fallbackKeywords('')).toEqual([])
    expect(fallbackKeywords('   ')).toEqual([])
  })

  it('纯标点返回空数组（没有 token 也没有 CJK）', () => {
    expect(fallbackKeywords('!@#$%')).toEqual([])
  })

  it('去重：同 token 多次出现只入一次', () => {
    const result = fallbackKeywords('结算页 结算页 结算页 死锁排查')
    const seen = new Set(result)
    expect(seen.size).toBe(result.length)
  })

  it('不超过 FALLBACK_MAX (10) 个', () => {
    const result = fallbackKeywords('一 二 三 四 五 六 七 八 九 十 十一 十二')
    expect(result.length).toBeLessThanOrEqual(10)
  })

  it('中日韩 stretch 都按 CJK 处理', () => {
    // 韩文 3 字 stretch,走 CJK n-gram 路径
    const result = fallbackKeywords('안녕하세요')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('extractKeywords 会话隔离', () => {
  it('两次调用使用不同的一次性 conversationId，且每次结束后 closeSession', async () => {
    const { driver, calls, closed } = createFakeDriver('{"keywords":["结算页"]}')
    const input = { driver, driverId: 'qoder' as const, model: 'lite', text: '结算页优惠券叠加报错' }

    const first = await extractKeywords(input)
    const second = await extractKeywords(input)

    expect(first).toEqual(['结算页'])
    expect(second).toEqual(['结算页'])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.conversationId).toMatch(/^memory-keyword-extract-/)
    expect(calls[1]!.conversationId).toMatch(/^memory-keyword-extract-/)
    expect(calls[0]!.conversationId).not.toBe(calls[1]!.conversationId)
    expect(closed).toEqual([calls[0]!.conversationId, calls[1]!.conversationId])
  })

  it('traceId 透传给 driver（join 调用方执行树），traceLabel 为语义名', async () => {
    const { driver, calls } = createFakeDriver('{"keywords":["a"]}')
    await extractKeywords({
      driver,
      driverId: 'qoder',
      model: 'lite',
      text: '查询',
      traceId: 'trace-caller-1'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.traceId).toBe('trace-caller-1')
    expect(calls[0]!.traceLabel).toBe('关键词提取')
  })

  it('driver 抛错时仍 closeSession 并回退 fallback 关键词', async () => {
    const { driver, calls, closed } = createFakeDriver('')
    const failing: ChatDriver = {
      ...driver,
      async *streamChat(): AsyncGenerator<ChatStreamChunk> {
        yield* []
        throw new Error('llm down')
      }
    }
    const result = await extractKeywords({ driver: failing, driverId: 'qoder', model: 'lite', text: '死锁排查' })
    expect(result.length).toBeGreaterThan(0)
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatch(/^memory-keyword-extract-/)
    expect(calls).toHaveLength(0)
  })
})
