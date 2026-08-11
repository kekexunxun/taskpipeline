import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * ProjectQueryToolSource 单测：全部工具基于 node:fs，直接用临时目录做真实文件系统验证。
 */
const { createProjectQueryToolSource } = await import('./project-query-tools.js')

let cwd: string

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-tools-'))
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const abs = path.join(cwd, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

describe('ProjectQueryToolSource 元信息', () => {
  it('id / displayName / describeResult / close 符合只读查询工具约定', () => {
    const source = createProjectQueryToolSource(cwd)
    expect(source.id).toBe('project')
    expect(source.displayName).toBe('项目查询')
    // 查询工具不创建任务
    expect(source.describeResult({ anything: 1 })).toBeUndefined()
    expect(source.describeResult(null)).toBeUndefined()
    // 纯 fs 实现，close 不抛错
    expect(() => source.close()).not.toThrow()
    expect(source.systemPrompt()).toContain('只能读取')
    expect(source.systemPrompt()).toContain('相对工作目录')
  })

  it('tools() 全部只读且 schema 为单层 zod 字段', async () => {
    const source = createProjectQueryToolSource(cwd)
    const tools = source.tools()
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'grep', 'glob', 'list_dir'])
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
      // execute 返回 Promise
      expect(typeof tool.execute).toBe('function')
    }
  })
})

describe('read_file', () => {
  it('正常读取文件内容', async () => {
    writeFile('a.txt', 'line1\nline2\nline3\n')
    const source = createProjectQueryToolSource(cwd)
    const result = await source.tools()[0].execute({ path: 'a.txt' })
    expect(result).toBe('line1\nline2\nline3')
  })

  it('支持 offset / limit 行区间', async () => {
    writeFile('a.txt', 'l0\nl1\nl2\nl3\nl4\n')
    const source = createProjectQueryToolSource(cwd)
    const tools = source.tools()
    const sliced = await tools[0].execute({ path: 'a.txt', offset: 1, limit: 2 })
    expect(sliced).toBe('l1\nl2\n[行区间 1..3 / 共 5 行]')
    const head = await tools[0].execute({ path: 'a.txt', limit: 1 })
    expect(head).toBe('l0\n[行区间 0..1 / 共 5 行]')
  })

  it('拒绝越界路径（目录穿越）', async () => {
    writeFile('a.txt', 'ok')
    const source = createProjectQueryToolSource(cwd)
    await expect(source.tools()[0].execute({ path: '../secret.txt' })).rejects.toThrow(/越界/)
    await expect(source.tools()[0].execute({ path: '/etc/passwd' })).rejects.toThrow(/越界/)
  })

  it('超过 1MB 的文件只读取前 1MB 并提示截断', async () => {
    // 1MB + 一点：内容全部是 'x'，读出来的内容不含换行
    const big = 'x'.repeat(1024 * 1024 + 100)
    writeFile('big.txt', big)
    const source = createProjectQueryToolSource(cwd)
    const result = (await source.tools()[0].execute({ path: 'big.txt' })) as string
    expect(result).toContain('[提示：文件超过 1MB，仅读取前 1MB]')
    expect(result.length).toBeLessThan(1024 * 1024 + 200)
    expect(result.startsWith('x'.repeat(1024 * 1024))).toBe(true)
  })

  it('读取不存在的文件报错', async () => {
    const source = createProjectQueryToolSource(cwd)
    await expect(source.tools()[0].execute({ path: 'missing.txt' })).rejects.toThrow()
  })
})

describe('grep', () => {
  it('按行匹配并输出 文件:行号: 内容 摘要', async () => {
    writeFile('src/x.ts', 'const a = 1\n// payment gateway\nconst pay = 2\n')
    writeFile('README.md', '# readme\nno match here\n')
    const source = createProjectQueryToolSource(cwd)
    const grep = source.tools()[1]
    const result = (await grep.execute({ pattern: 'pay' })) as { results: string[]; count: number; truncated: boolean }
    expect(result.count).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.results).toContain('src/x.ts:2: // payment gateway')
    expect(result.results).toContain('src/x.ts:3: const pay = 2')
  })

  it('跳过 node_modules 与 .git', async () => {
    writeFile('node_modules/dep/index.js', 'const pay = 1\n')
    writeFile('.git/config', 'pay = 1\n')
    writeFile('src/ok.js', 'const pay = 1\n')
    const source = createProjectQueryToolSource(cwd)
    const grep = source.tools()[1]
    const result = (await grep.execute({ pattern: 'pay' })) as { results: string[] }
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toContain('src/ok.js')
  })

  it('达到 maxResults 提前停止并标记 truncated', async () => {
    for (let i = 0; i < 5; i++) writeFile(`f${i}.txt`, 'match\n')
    const source = createProjectQueryToolSource(cwd)
    const grep = source.tools()[1]
    const result = (await grep.execute({ pattern: 'match', maxResults: 2 })) as {
      results: string[]
      truncated: boolean
    }
    expect(result.results).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('非法正则报错', async () => {
    const source = createProjectQueryToolSource(cwd)
    await expect(source.tools()[1].execute({ pattern: '(' })).rejects.toThrow(/非法正则/)
  })
})

describe('glob', () => {
  it('通配匹配文件列表', async () => {
    writeFile('src/a.ts', '')
    writeFile('src/b.ts', '')
    writeFile('src/c.js', '')
    writeFile('README.md', '')
    const source = createProjectQueryToolSource(cwd)
    const glob = source.tools()[2]
    const result = (await glob.execute({ pattern: 'src/*.ts' })) as string[]
    expect(result.sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('支持 ** 匹配任意层目录', async () => {
    writeFile('src/deep/nested/a.ts', '')
    writeFile('src/b.ts', '')
    writeFile('lib/c.ts', '')
    const source = createProjectQueryToolSource(cwd)
    const glob = source.tools()[2]
    const result = (await glob.execute({ pattern: '**/*.ts' })) as string[]
    expect(result.sort()).toEqual(['lib/c.ts', 'src/b.ts', 'src/deep/nested/a.ts'])
  })

  it('无匹配时返回空数组', async () => {
    writeFile('a.txt', '')
    const source = createProjectQueryToolSource(cwd)
    const result = (await source.tools()[2].execute({ pattern: '*.md' })) as string[]
    expect(result).toEqual([])
  })

  it('纯字面量路径存在时返回该路径', async () => {
    writeFile('src/a.ts', '')
    const source = createProjectQueryToolSource(cwd)
    const result = (await source.tools()[2].execute({ pattern: 'src/a.ts' })) as string[]
    expect(result).toEqual(['src/a.ts'])
  })

  it('越界模式拒绝', async () => {
    const source = createProjectQueryToolSource(cwd)
    await expect(source.tools()[2].execute({ pattern: '../x' })).rejects.toThrow(/越界/)
  })
})

describe('list_dir', () => {
  it('列出条目（名称 + isDir + 大小），depth 默认 1 不递归', async () => {
    writeFile('a.txt', '12345')
    writeFile('sub/b.txt', 'x')
    const source = createProjectQueryToolSource(cwd)
    const listDir = source.tools()[3]
    const result = (await listDir.execute({})) as Array<{ name: string; isDir: boolean; size: number | null }>
    const names = result.map((e) => e.name)
    expect(names).toContain('a.txt')
    expect(names).toContain('sub/')
    expect(names).not.toContain('sub/b.txt')
    const file = result.find((e) => e.name === 'a.txt')
    expect(file?.isDir).toBe(false)
    expect(file?.size).toBe(5)
    const dir = result.find((e) => e.name === 'sub/')
    expect(dir?.isDir).toBe(true)
    expect(dir?.size).toBeNull()
  })

  it('depth 控制递归层数', async () => {
    writeFile('a/b/c.txt', 'x')
    const source = createProjectQueryToolSource(cwd)
    const listDir = source.tools()[3]
    const shallow = (await listDir.execute({ depth: 1 })) as Array<{ name: string }>
    expect(shallow.map((e) => e.name)).not.toContain('a/b/c.txt')
    const deep = (await listDir.execute({ depth: 3 })) as Array<{ name: string }>
    expect(deep.map((e) => e.name)).toContain('a/b/c.txt')
  })
})
