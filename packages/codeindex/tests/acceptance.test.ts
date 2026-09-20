import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import type { ParserBackend } from '../src/types.js'
import { CodeIndexStore } from '../src/db/sqlite-store.js'
import { CodeIndexer } from '../src/indexer/index.js'
import { NodeFileSystem } from '../src/fs/node.js'
import { makeBackend } from './test-utils.js'

/**
 * Phase 1 验收：真实前端仓全量索引。
 * 仅在仓库存在时运行（外部开发机路径；CI 上自动跳过）。
 */
const REPO = join(process.env.HOME ?? '', 'Documents', 'baison', 'adaptor-suit-front-new')
const enabled = existsSync(REPO)

let backend: ParserBackend
let db: Database.Database
let store: CodeIndexStore
let indexer: CodeIndexer
let result: Awaited<ReturnType<CodeIndexer['indexRepo']>> | null = null
const stats: { nodeCount: number } = { nodeCount: 0 }

beforeAll(async () => {
  if (!enabled) return
  backend = await makeBackend()
  db = new Database(':memory:')
  store = new CodeIndexStore(db).init()
  indexer = new CodeIndexer({ backend, store, fs: new NodeFileSystem() })
  result = await indexer.indexRepo({ repoId: 'REAL', rootDir: REPO })
  stats.nodeCount = store.getStats('REAL').nodeCount
}, 120_000)

afterAll(() => db?.close())

describe.skipIf(!enabled)('Phase 1 验收 — 真实仓 adaptor-suit-front-new', () => {
  it('全量索引：规模 + 计时（≤15s）', () => {
    expect(result).toBeTruthy()
    expect(result!.filesScanned).toBeGreaterThan(400)
    expect(result!.filesErrored).toBeLessThan(result!.filesScanned * 0.05)
    expect(result!.symbolCount).toBeGreaterThan(4000)

    console.log(
      `[accept] files=${result!.filesScanned} indexed=${result!.filesIndexed} symbols=${result!.symbolCount} edges=${result!.edgeCount} ${result!.durationMs}ms`
    )
    expect(result!.durationMs).toBeLessThanOrEqual(15_000)
  })

  it('检索真实 class：LazySelectCacheManager', () => {
    const hit = store.searchSymbols('LazySelectCacheManager', { repoIds: ['REAL'], kinds: ['class'] })[0]
    expect(hit?.name).toBe('LazySelectCacheManager')
    expect(hit?.kind).toBe('class')
  })

  it('检索真实 TS 函数：clearMessages', () => {
    const names = store.searchSymbols('clearMessages', { repoIds: ['REAL'] }).map((h) => h.name)
    expect(names).toContain('clearMessages')
  })

  it('Vue 脚本符号端到端行号准确：ToolCallCard.vue 的 formatJson@150', () => {
    const hits = store
      .searchSymbols('formatJson', { repoIds: ['REAL'], languages: ['vue'] })
      .filter((h) => h.filePath.endsWith('layout/Copilot/ToolCallCard.vue'))
    expect(hits.length).toBeGreaterThan(0)
    // 真实文件里 formatJson 定义在第 150 行 —— 验证混合式 Vue 的行偏移还原。
    const def = hits.find((h) => h.startLine === 150)
    expect(def?.name).toBe('formatJson')
  })

  it('Vue 模板组件符号被收录（language=vue 且非脚本来源）', () => {
    const vueSymbols = store.searchSymbols('', { repoIds: ['REAL'], languages: ['vue'], limit: 0 })
    // 用显式 kind 查询确认 component 类存在（模板抽取生效）
    const comps = store.getStats('REAL').nodesByKind
    expect(comps.component ?? 0).toBeGreaterThan(0)
    void vueSymbols
  })
})
