/** codebase_search 工具文件里的两块纯逻辑：索引预热 + 子代理委派指引常量。 */
import { describe, expect, it, vi } from 'vitest'
import type { CodeIndexService } from '@task-pipeline/codeindex'
import {
  CODEBASE_SEARCH_STEERING,
  CODEBASE_SEARCH_SUBAGENT_STEERING,
  warmCodebaseSearch
} from './codebase-search-tool.js'

function fakeService(impl?: (dir: string, name?: string) => void): CodeIndexService {
  return { ensureIndexed: vi.fn(impl ?? (() => undefined)) } as unknown as CodeIndexService
}

describe('warmCodebaseSearch', () => {
  it('对每个 root 以 dir + name 触发 ensureIndexed（预热首扫）', () => {
    const service = fakeService()
    warmCodebaseSearch(service, [{ dir: '/repo/a', name: 'a' }, { dir: '/repo/b' }])
    const spy = service.ensureIndexed as unknown as ReturnType<typeof vi.fn>
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenNthCalledWith(1, '/repo/a', 'a')
    expect(spy).toHaveBeenNthCalledWith(2, '/repo/b', undefined)
  })

  it('单个目录预热抛错被吞掉，不影响其余目录', () => {
    const service = fakeService((dir) => {
      if (dir === '/bad') throw new Error('unsafe root')
    })
    expect(() => warmCodebaseSearch(service, [{ dir: '/bad' }, { dir: '/good' }])).not.toThrow()
    const spy = service.ensureIndexed as unknown as ReturnType<typeof vi.fn>
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenLastCalledWith('/good', undefined)
  })

  it('空 roots 不调用 ensureIndexed', () => {
    const service = fakeService()
    warmCodebaseSearch(service, [])
    expect(service.ensureIndexed as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })
})

describe('codebase_search 使用指引常量', () => {
  it('子代理委派指引是非空且区别于基础指引的独立文案', () => {
    expect(CODEBASE_SEARCH_SUBAGENT_STEERING.length).toBeGreaterThan(0)
    expect(CODEBASE_SEARCH_SUBAGENT_STEERING).not.toBe(CODEBASE_SEARCH_STEERING)
  })

  it('子代理指引点破「子代理看不到 codebase_search、主会话先取锚点再委派」的核心语义', () => {
    expect(CODEBASE_SEARCH_SUBAGENT_STEERING).toContain('子代理')
    expect(CODEBASE_SEARCH_SUBAGENT_STEERING).toContain('codebase_search')
  })
})
