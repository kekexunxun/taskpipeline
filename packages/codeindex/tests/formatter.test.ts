import { describe, it, expect } from 'vitest'
import type { Language, SearchHit, SymbolKind } from '../src/types.js'
import { formatBoundedSearch, DEFAULT_MAX_BYTES } from '../src/search/bounded-formatter.js'
import { MemFileSystem } from './test-utils.js'

function hit(p: Partial<SearchHit> & { name: string }): SearchHit {
  return {
    repoId: p.repoId ?? 'R',
    name: p.name,
    qualifiedName: p.qualifiedName ?? p.name,
    kind: (p.kind ?? 'function') as SymbolKind,
    language: (p.language ?? 'typescript') as Language,
    filePath: p.filePath ?? 'src/a.ts',
    startLine: p.startLine ?? 1,
    endLine: p.endLine ?? 5,
    signature: p.signature ?? null,
    exported: p.exported ?? true,
    score: p.score ?? 0
  }
}

describe('formatBoundedSearch — 有界输出', () => {
  it('无命中 → 空文本', () => {
    const r = formatBoundedSearch([])
    expect(r.text).toBe('')
    expect(r.included).toBe(0)
    expect(r.truncated).toBe(false)
  })

  it('指针行含 repo名/路径:行 + kind + 限定名', () => {
    const r = formatBoundedSearch(
      [
        hit({
          name: 'sendMessage',
          kind: 'method',
          qualifiedName: 'MnsClient.sendMessage',
          filePath: 'src/mns.ts',
          startLine: 10
        })
      ],
      { repoNames: { R: 'myrepo' } }
    )
    expect(r.text).toContain('myrepo/src/mns.ts:10')
    expect(r.text).toContain('[method]')
    expect(r.text).toContain('MnsClient.sendMessage')
  })

  it('给定 fs + rootDirs 时附带 5 行片段且带行号', () => {
    const content = 'l1\nl2\nl3\nexport function f() {\n  return 1;\n}\n'
    const fs = new MemFileSystem({ '/abs/src/a.ts': content })
    const r = formatBoundedSearch([hit({ name: 'f', startLine: 4 })], { fs, rootDirs: { R: '/abs' }, snippetLines: 3 })
    expect(r.text).toContain('4 | export function f() {')
    expect(r.text).toContain('5 |   return 1;')
    expect(r.text).toContain('6 | }')
    // 不应把片段前的 l1/l2 也带进来
    expect(r.text).not.toContain('1 | l1')
  })

  it('同 (repo,file,line,kind,name) 去重', () => {
    const r = formatBoundedSearch([hit({ name: 'X' }), hit({ name: 'X' })])
    expect(r.included).toBe(1)
  })

  it('触顶即截并标 truncated + 收尾提示', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      hit({ name: `sym${i}`, filePath: `src/f${i}.ts`, startLine: i + 1, signature: 'a'.repeat(80) })
    )
    const r = formatBoundedSearch(many, { maxBytes: 2000 })
    expect(r.included).toBeLessThan(many.length)
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(2000 + 200) // 含收尾提示的少量余量
    expect(r.text).toContain('已达上限截断')
  })

  it('默认硬上限为 30KB', () => {
    const huge = Array.from({ length: 5000 }, (_, i) =>
      hit({ name: `s${i}`, filePath: `p/${'x'.repeat(60)}.ts`, startLine: i + 1, signature: 'long '.repeat(40) })
    )
    const r = formatBoundedSearch(huge)
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 200)
  })

  it('读不到文件时只出指针、不崩', () => {
    const fs = new MemFileSystem({}) // 空 fs
    const r = formatBoundedSearch([hit({ name: 'gone' })], { fs, rootDirs: { R: '/abs' } })
    expect(r.text).toContain('src/a.ts:1')
    expect(r.text).not.toContain('| ')
  })
})
