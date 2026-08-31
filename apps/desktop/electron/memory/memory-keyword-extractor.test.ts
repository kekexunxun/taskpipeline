import { describe, expect, it } from 'vitest'
import { fallbackKeywords } from './memory-keyword-extractor'

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
