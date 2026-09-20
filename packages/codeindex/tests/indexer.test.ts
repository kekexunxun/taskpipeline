import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import type { ParserBackend } from '../src/types.js'
import { CodeIndexStore } from '../src/db/sqlite-store.js'
import { CodeIndexer } from '../src/indexer/index.js'
import { makeBackend } from './test-utils.js'

let root: string
let backend: ParserBackend
let db: Database.Database
let store: CodeIndexStore
let indexer: CodeIndexer

beforeAll(async () => {
  backend = await makeBackend()
  root = mkdtempSync(join(tmpdir(), 'codeindex-test-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'mns-client.ts'),
    `export class MnsClient { async sendMessage(q: string) { return q; } }\nexport function buildQueueUrl(a: string) { return a; }\n`
  )
  writeFileSync(
    join(root, 'src', 'list.vue'),
    `<template><div @click="onSubmit">x</div></template>\n<script setup lang="ts">\nfunction onSubmit() { const y = 1; void y; }\n</script>\n`
  )
  writeFileSync(join(root, 'src', 'helper.py'), `class Helper:\n    def work(self): return 1\n`)
  db = new Database(':memory:')
  store = new CodeIndexStore(db).init()
  indexer = new CodeIndexer({ backend, store })
})

afterAll(() => {
  db?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('CodeIndexer — 全量索引', () => {
  it('扫到三类语言文件并建符号', async () => {
    const res = await indexer.indexRepo({ repoId: 'T', rootDir: root })
    expect(res.filesScanned).toBe(3)
    expect(res.filesIndexed).toBe(3)
    expect(res.filesErrored).toBe(0)
    expect(res.symbolCount).toBeGreaterThanOrEqual(4) // MnsClient, buildQueueUrl, onSubmit, Helper/work
    const names = new Set(store.searchSymbols('MnsClient', { repoIds: ['T'] }).map((h) => h.name))
    expect(names.has('MnsClient')).toBe(true)
    // Vue 脚本符号 + 行偏移
    const onSubmit = store.searchSymbols('onSubmit', { repoIds: ['T'] })[0]
    expect(onSubmit?.language).toBe('vue')
    expect(onSubmit?.startLine).toBeGreaterThanOrEqual(3)
    // Python
    expect(store.searchSymbols('Helper', { repoIds: ['T'] })[0]?.language).toBe('python')
  })

  it('contains 边建立（file → symbol）', () => {
    const edges = db.prepare(`SELECT COUNT(*) c FROM edge WHERE kind='contains' AND repo_id='T'`).get() as { c: number }
    expect(edges.c).toBeGreaterThanOrEqual(4)
  })
})

describe('CodeIndexer — 增量', () => {
  it('无改动重扫：全部走 mtime+size 快路径跳过', async () => {
    const res = await indexer.indexRepo({ repoId: 'T', rootDir: root })
    expect(res.filesIndexed).toBe(0)
    expect(res.filesSkipped).toBe(3)
  })

  it('改一个文件：只有它被重解析', async () => {
    writeFileSync(
      join(root, 'src', 'mns-client.ts'),
      `export class MnsClient { async sendMessage(q: string) { return q; } }\nexport function buildQueueUrl(a: string) { return a; }\nexport function brandNewFn(z: string) { return z; }\n`
    )
    const res = await indexer.indexRepo({ repoId: 'T', rootDir: root })
    expect(res.filesIndexed).toBe(1)
    expect(store.searchSymbols('brandNewFn', { repoIds: ['T'] })[0]?.filePath).toBe('src/mns-client.ts')
  })

  it('写后即查 onlyPaths：只重解析指定文件', async () => {
    writeFileSync(
      join(root, 'src', 'helper.py'),
      `class Helper:\n    def work(self): return 1\n    def addedMethod(self): return 2\n`
    )
    const res = await indexer.indexRepo({ repoId: 'T', rootDir: root, onlyPaths: ['src/helper.py'] })
    expect(res.filesScanned).toBe(1)
    expect(res.filesIndexed).toBe(1)
    expect(store.searchSymbols('addedMethod', { repoIds: ['T'] })[0]?.name).toBe('addedMethod')
  })

  it('删除文件后重扫：其符号消失', async () => {
    rmSync(join(root, 'src', 'mns-client.ts'))
    const res = await indexer.indexRepo({ repoId: 'T', rootDir: root })
    expect(res.filesScanned).toBe(2)
    expect(store.searchSymbols('buildQueueUrl', { repoIds: ['T'] }).length).toBe(0)
    expect(store.getFileRecord('T', 'src/mns-client.ts')).toBeNull()
  })

  it('force 全量重建', async () => {
    const res = await indexer.indexRepo({ repoId: 'T', rootDir: root, force: true })
    expect(res.filesIndexed).toBe(2)
  })
})
