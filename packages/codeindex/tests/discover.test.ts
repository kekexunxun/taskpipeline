import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { discoverFiles, unsafeIndexRootReason } from '../src/indexer/discover.js'
import { NodeFileSystem } from '../src/fs/node.js'
import { MemFileSystem } from './test-utils.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_REPO = join(here, 'fixtures', 'repo')

describe('discoverFiles — 真实 fixture 仓（.gitignore 驱动 + 取反）', () => {
  const found = discoverFiles({ fs: new NodeFileSystem(), rootDir: FIXTURE_REPO }).map((f) => f.relPath)

  it('收录各语言源码', () => {
    for (const p of [
      'src/mns-client.ts',
      'src/App.tsx',
      'src/legacy.js',
      'src/UserList.vue',
      'src/services/client.py'
    ]) {
      expect(found).toContain(p)
    }
  })
  it('被 .gitignore 排除的文件不索引', () => {
    expect(found).not.toContain('ignored/secret.ts')
  })
  it('`!` 取反重新纳入的文件要索引', () => {
    expect(found).toContain('ignored/keepme.ts')
  })
  it('relPath 使用 POSIX 分隔且 language 正确映射', () => {
    const py = discoverFiles({ fs: new NodeFileSystem(), rootDir: FIXTURE_REPO }).find((f) =>
      f.relPath.endsWith('client.py')
    )
    expect(py?.language).toBe('python')
    expect(py?.relPath).not.toContain('\\')
  })
})

describe('discoverFiles — 合成 fs（硬跳目录 / 体积上限 / 无 gitignore 全量）', () => {
  const files: Record<string, string> = {
    '/r/src/a.ts': 'export const a = 1;',
    '/r/node_modules/dep/index.ts': 'export const dep = 1;',
    '/r/dist/bundle.js': 'var x=1;',
    '/r/build/out.js': 'var y=1;',
    '/r/src/big.ts': 'x'.repeat(10),
    '/r/readme.md': '# not code'
  }
  const fs = new MemFileSystem(files, { sizes: { '/r/src/big.ts': 5 * 1024 * 1024 } })

  it('硬跳 node_modules / dist / build', () => {
    const found = discoverFiles({ fs, rootDir: '/r', respectGitignore: false }).map((f) => f.relPath)
    expect(found.some((p) => p.includes('node_modules'))).toBe(false)
    expect(found.some((p) => p.startsWith('dist/'))).toBe(false)
    expect(found.some((p) => p.startsWith('build/'))).toBe(false)
  })
  it('超过 1MB 的文件跳过', () => {
    const found = discoverFiles({ fs, rootDir: '/r', respectGitignore: false }).map((f) => f.relPath)
    expect(found).toContain('src/a.ts')
    expect(found).not.toContain('src/big.ts')
  })
  it('非受支持扩展名（.md）不索引', () => {
    const found = discoverFiles({ fs, rootDir: '/r', respectGitignore: false }).map((f) => f.relPath)
    expect(found).not.toContain('readme.md')
  })
})

describe('unsafeIndexRootReason', () => {
  it('拒绝文件系统根', () => {
    expect(unsafeIndexRootReason('/')).not.toBeNull()
  })
  it('拒绝用户家目录', () => {
    expect(unsafeIndexRootReason(homedir())).not.toBeNull()
  })
  it('普通项目目录放行', () => {
    expect(unsafeIndexRootReason(join(homedir(), 'projects', 'repo'))).toBeNull()
  })
  it('discoverFiles 对家目录抛错', () => {
    expect(() => discoverFiles({ fs: new NodeFileSystem(), rootDir: homedir() })).toThrow()
  })
})
