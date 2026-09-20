import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { CodeIndexStore } from '../src/db/sqlite-store.js'
import type { ExtractedSymbol, Language, SymbolKind } from '../src/types.js'

let db: Database.Database
afterEach(() => db?.close())

function sym(p: {
  name: string
  kind?: SymbolKind
  file?: string
  lang?: Language
  line?: number
  exported?: boolean
}): ExtractedSymbol {
  return {
    kind: p.kind ?? 'function',
    name: p.name,
    qualifiedName: p.name,
    filePath: p.file ?? 'src/a.ts',
    language: p.lang ?? 'typescript',
    startLine: p.line ?? 1,
    startCol: 0,
    endLine: (p.line ?? 1) + 3,
    endCol: 0,
    exported: p.exported ?? true
  }
}

function init(): CodeIndexStore {
  db = new Database(':memory:')
  return new CodeIndexStore(db).init()
}

describe('CodeIndexStore — schema & 写入', () => {
  it('constructor(db) 注入、init() 幂等建表', () => {
    const store = init()
    store.init() // 再次调用不报错
    expect(store.getStats().nodeCount).toBe(0)
  })

  it('replaceFileSymbols 写入 file 节点 + 符号 + contains 边', () => {
    const store = init()
    const r = store.replaceFileSymbols({
      repoId: 'R',
      relPath: 'src/a.ts',
      language: 'typescript',
      symbols: [
        sym({ name: 'MnsClient', kind: 'class', line: 6 }),
        sym({ name: 'sendMessage', kind: 'method', line: 10 })
      ],
      imports: [{ module: 'node:events', names: ['EventEmitter'], line: 1 }],
      size: 100,
      mtimeMs: 1,
      contentHash: 'h1'
    })
    expect(r.symbolCount).toBe(2)
    // file + 2 symbols = 3 节点；contains×2 + imports×1 = 3 边
    const stats = store.getStats('R')
    expect(stats.nodeCount).toBe(3)
    expect(stats.edgeCount).toBe(3)
  })
})

describe('CodeIndexStore — searchSymbols', () => {
  it('精确名命中，带回正确 file:line', () => {
    const store = init()
    store.replaceFileSymbols({
      repoId: 'R',
      relPath: 'src/mns.ts',
      language: 'typescript',
      symbols: [sym({ name: 'MnsClient', kind: 'class', line: 6 })],
      imports: [],
      size: 1,
      mtimeMs: 1,
      contentHash: 'h'
    })
    const hits = store.searchSymbols('MnsClient', { repoIds: ['R'] })
    expect(hits[0]?.name).toBe('MnsClient')
    expect(hits[0]?.filePath).toBe('src/mns.ts')
    expect(hits[0]?.startLine).toBe(6)
  })

  it('trigram 子串命中（搜 Mns 找回 MnsClient）', () => {
    const store = init()
    store.replaceFileSymbols({
      repoId: 'R',
      relPath: 'a.ts',
      language: 'typescript',
      symbols: [sym({ name: 'MnsClient' }), sym({ name: 'MnsMessage', kind: 'interface' })],
      imports: [],
      size: 1,
      mtimeMs: 1,
      contentHash: 'h'
    })
    const names = store.searchSymbols('Mns', { repoIds: ['R'] }).map((h) => h.name)
    expect(names).toContain('MnsClient')
    expect(names).toContain('MnsMessage')
  })

  it('repo 作用域隔离：近名不串仓', () => {
    const store = init()
    store.replaceFileSymbols({
      repoId: 'A',
      relPath: 'x.ts',
      language: 'typescript',
      symbols: [sym({ name: 'SharedNameA' })],
      imports: [],
      size: 1,
      mtimeMs: 1,
      contentHash: 'h'
    })
    store.replaceFileSymbols({
      repoId: 'B',
      relPath: 'x.ts',
      language: 'typescript',
      symbols: [sym({ name: 'SharedNameB' })],
      imports: [],
      size: 1,
      mtimeMs: 1,
      contentHash: 'h'
    })
    const a = store.searchSymbols('SharedNameA', { repoIds: ['A'] }).map((h) => h.name)
    expect(a).toContain('SharedNameA')
    expect(a).not.toContain('SharedNameB')
  })

  it('短查询（≤2）走 LIKE 回退', () => {
    const store = init()
    store.replaceFileSymbols({
      repoId: 'R',
      relPath: 'a.ts',
      language: 'typescript',
      symbols: [sym({ name: 'ab' }), sym({ name: 'abc' })],
      imports: [],
      size: 1,
      mtimeMs: 1,
      contentHash: 'h'
    })
    const names = store.searchSymbols('ab', { repoIds: ['R'] }).map((h) => h.name)
    expect(names).toContain('ab')
  })

  it('默认过滤 import/export/file 噪声；includeNoise 打开', () => {
    const store = init()
    store.replaceFileSymbols({
      repoId: 'R',
      relPath: 'a.ts',
      language: 'typescript',
      symbols: [sym({ name: 'foo' }), sym({ name: 'bar', kind: 'file' }), sym({ name: 'baz', kind: 'export' })],
      imports: [{ module: 'zzzmod', names: [], line: 1 }],
      size: 1,
      mtimeMs: 1,
      contentHash: 'h'
    })
    const clean = store.searchSymbols('bar', { repoIds: ['R'] }).map((h) => h.name)
    expect(clean).not.toContain('bar') // file 节点被过滤
    const noisy = store.searchSymbols('bar', { repoIds: ['R'], includeNoise: true }).map((h) => h.name)
    expect(noisy).toContain('bar')
  })
})

describe('CodeIndexStore — 增量与删除', () => {
  it('二次 replace 用更少符号会清掉旧的', () => {
    const store = init()
    store.replaceFileSymbols({
      repoId: 'R',
      relPath: 'a.ts',
      language: 'typescript',
      symbols: [sym({ name: 'X' }), sym({ name: 'Y' })],
      imports: [],
      size: 1,
      mtimeMs: 1,
      contentHash: 'h1'
    })
    expect(store.searchSymbols('Y', { repoIds: ['R'], includeNoise: true }).length).toBe(1)
    store.replaceFileSymbols({
      repoId: 'R',
      relPath: 'a.ts',
      language: 'typescript',
      symbols: [sym({ name: 'X' })],
      imports: [],
      size: 2,
      mtimeMs: 2,
      contentHash: 'h2'
    })
    expect(store.searchSymbols('Y', { repoIds: ['R'], includeNoise: true }).length).toBe(0)
    expect(store.searchSymbols('X', { repoIds: ['R'] }).length).toBe(1)
  })

  it('removeFile 清该文件节点与边', () => {
    const store = init()
    store.replaceFileSymbols({
      repoId: 'R',
      relPath: 'a.ts',
      language: 'typescript',
      symbols: [sym({ name: 'Z' })],
      imports: [],
      size: 1,
      mtimeMs: 1,
      contentHash: 'h'
    })
    store.removeFile('R', 'a.ts')
    expect(store.getStats('R').nodeCount).toBe(0)
    expect(store.getFileRecord('R', 'a.ts')).toBeNull()
  })

  it('removeRepo 清整仓', () => {
    const store = init()
    store.replaceFileSymbols({
      repoId: 'R',
      relPath: 'a.ts',
      language: 'typescript',
      symbols: [sym({ name: 'Z' })],
      imports: [],
      size: 1,
      mtimeMs: 1,
      contentHash: 'h'
    })
    store.replaceFileSymbols({
      repoId: 'R2',
      relPath: 'b.ts',
      language: 'typescript',
      symbols: [sym({ name: 'W', file: 'b.ts' })],
      imports: [],
      size: 1,
      mtimeMs: 1,
      contentHash: 'h'
    })
    store.removeRepo('R')
    expect(store.listRepoIds()).toEqual(['R2'])
  })

  it('nodeId/contentHash 稳定', () => {
    init()
    const id1 = CodeIndexStore.nodeId('R', 'a.ts', 'class', 'X', 3)
    expect(id1).toBe(CodeIndexStore.nodeId('R', 'a.ts', 'class', 'X', 3))
    expect(CodeIndexStore.contentHash('abc')).toBe(CodeIndexStore.contentHash('abc'))
  })
})
