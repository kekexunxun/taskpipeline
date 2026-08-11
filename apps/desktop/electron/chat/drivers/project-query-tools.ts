/**
 * ProjectQueryToolSource — 项目对话的只读文件查询工具集。
 *
 * 背景：
 *  对话模式（chat）在注入 `toolSource` 前，OpenAI driver 不传 tools，模型只能输出
 *  "计划文本" 后结束（表现为没响应）。给项目对话（有 workingDirectory）注入一组只读
 *  查询工具后，模型可以真正读取代码来回答"这项目支持了哪些支付方式"这类问题。
 *
 * 设计：
 *  - 全部工具标 `readOnlyHint: true`，不提供 bash / 写文件，避免对话模式执行危险操作；
 *  - 所有路径统一相对 cwd 解析，`resolveWithin` 校验防目录穿越；
 *  - `describeResult` 恒返回 undefined（查询工具不会创建任务，不触发 task-created）；
 *  - `close()` 无资源可释放（纯 node:fs 实现，无 MCP client / HTTP pool）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { ChatTaskCreationResult } from '../chat-types.js'
import type { ToolDeclaration, ToolSource } from './tool-source.js'

/** read_file 单次读取的字节上限：超过 1MB 截断并提示，避免一次性把超大文件塞进上下文。 */
const MAX_READ_BYTES = 1024 * 1024

/** grep 扫描时跳过的目录（构建产物 / 依赖 / VCS 元数据）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist'])

/** grep 递归扫描的最大深度（相对起点目录）。 */
const GREP_MAX_DEPTH = 6

/** grep 默认 / 上限匹配条数。 */
const GREP_DEFAULT_MAX = 50
const GREP_HARD_MAX = 500

/** glob 返回的匹配路径上限。 */
const GLOB_MAX_RESULTS = 200

/** grep 单行内容截断长度（保持摘要可读）。 */
const LINE_MAX = 300

/** 文本探测 / 行匹配时单文件读取上限（超过视为二进制或过大，跳过）。 */
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * 把用户给的路径解析到 cwd 内；越界（目录穿越 / 绝对路径指向外部）直接拒绝。
 * 返回绝对路径；目录不存在等错误由调用方通过 fs 报出。
 */
function resolveWithin(cwd: string, p: string): string {
  const resolved = path.resolve(cwd, p)
  const rel = path.relative(cwd, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界，拒绝访问: ${p}（只能访问工作目录内的文件）`)
  }
  return resolved
}

/** 相对 cwd 的可读路径（正斜杠形式，便于模型直接回填工具参数）。 */
function relPath(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs)
  return rel.split(path.sep).join('/')
}

/** 只读一个文件（> MAX_READ_BYTES 时只取前段），返回内容与是否截断。 */
async function readFileContent(absPath: string): Promise<{ content: string; truncated: boolean }> {
  const stats = await fs.promises.stat(absPath)
  if (!stats.isFile()) throw new Error(`${absPath} 不是文件`)
  if (stats.size <= MAX_READ_BYTES) {
    return { content: await fs.promises.readFile(absPath, 'utf8'), truncated: false }
  }
  const handle = await fs.promises.open(absPath, 'r')
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES)
    await handle.read(buf, 0, MAX_READ_BYTES, 0)
    return { content: buf.toString('utf8'), truncated: true }
  } finally {
    await handle.close()
  }
}

/** 读取一行内容摘要（去行尾空白 + 超长截断）。 */
function lineSummary(line: string): string {
  const trimmed = line.replace(/\r$/, '')
  return trimmed.length > LINE_MAX ? `${trimmed.slice(0, LINE_MAX)}…` : trimmed
}

/**
 * 递归扫描起点目录（跳过 SKIP_DIRS / 超深 / 超大文件），对文本文件逐行正则匹配。
 * 达到 maxResults 即提前停止。
 */
async function grepScan(opts: {
  cwd: string
  root: string
  depth: number
  regex: RegExp
  maxResults: number
}): Promise<{ results: string[]; truncated: boolean }> {
  const out: string[] = []
  let truncated = false
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= opts.maxResults || depth > opts.depth) return
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return // 无权限 / 已删除的目录直接跳过
    }
    for (const entry of entries) {
      if (out.length >= opts.maxResults) break
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(dir, entry.name), depth + 1)
      } else if (entry.isFile()) {
        const abs = path.join(dir, entry.name)
        const rel = relPath(opts.cwd, abs)
        let text: string
        try {
          const stats = await fs.promises.stat(abs)
          if (stats.size > GREP_MAX_FILE_BYTES) continue
          text = await fs.promises.readFile(abs, 'utf8')
        } catch {
          continue // 读失败（权限 / 占用 / 竞态删除）跳过
        }
        if (text.includes('\0')) continue // 二进制文件
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && out.length < opts.maxResults; i++) {
          const line = lines[i] ?? ''
          if (opts.regex.test(line)) {
            out.push(`${rel}:${i + 1}: ${lineSummary(line)}`)
          }
        }
        if (out.length >= opts.maxResults) {
          truncated = true
          break
        }
      }
    }
  }
  await walk(opts.root, 0)
  return { results: out, truncated }
}

/** 把单个 glob 段翻译成正则（支持 `*` / `?` / `[...]`；`**` 由调用方单独处理）。 */
function globSegmentToRegex(segment: string): RegExp {
  let source = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? ''
    if (ch === '*') {
      source += '[^/]*'
    } else if (ch === '?') {
      source += '[^/]'
    } else if (ch === '[') {
      // 字符类原样保留（glob 与正则语法一致），非法类回退为字面量
      const close = segment.indexOf(']', i + 1)
      if (close === -1) {
        source += '\\['
      } else {
        const inner = segment.slice(i + 1, close)
        source += `[${inner.replace(/[\\^]/g, '\\$&')}]`
        i = close
      }
    } else {
      source += /[.+^${}()|\\]/.test(ch) ? `\\${ch}` : ch
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * 基于路径段的 glob 扫描：先切出通配符前的固定前缀目录，再从该目录递归，
 * 剩余段逐个用段正则匹配；`**` 段匹配任意层目录。返回相对 cwd 的路径列表。
 */
async function globScan(cwd: string, pattern: string): Promise<string[]> {
  const segments = pattern.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return []
  // 固定前缀：第一个含通配符的段之前的所有段
  const firstWildcard = segments.findIndex((s) => /[*?[]/.test(s))
  if (firstWildcard === -1) {
    // 纯字面量路径：存在即返回，否则空
    const abs = resolveWithin(cwd, pattern)
    try {
      const stats = await fs.promises.stat(abs)
      return stats.isFile() || stats.isDirectory() ? [relPath(cwd, abs)] : []
    } catch {
      return []
    }
  }
  const fixedSegments = segments.slice(0, firstWildcard)
  const matchers = segments.slice(firstWildcard) // 含 `**` 特殊段
  const rootAbs = path.resolve(cwd, ...fixedSegments)
  const out: string[] = []

  const walk = async (dir: string, baseRel: string, rest: string[]): Promise<void> => {
    if (out.length >= GLOB_MAX_RESULTS || rest.length === 0) return
    const [head, ...tail] = rest
    if (head === '**') {
      // `**` 匹配零层：直接继续消费 tail
      if (tail.length === 0) {
        out.push(baseRel || '.')
      } else {
        await walk(dir, baseRel, tail)
      }
      // `**` 匹配一层及以上：下探所有子目录，rest 保持 `**` 开头
      let entries
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (out.length >= GLOB_MAX_RESULTS) break
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
        const childRel = baseRel ? `${baseRel}/${entry.name}` : entry.name
        await walk(path.join(dir, entry.name), childRel, rest)
      }
      return
    }
    const regex = globSegmentToRegex(head ?? '')
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= GLOB_MAX_RESULTS) break
      if (!regex.test(entry.name)) continue
      const childRel = baseRel ? `${baseRel}/${entry.name}` : entry.name
      if (tail.length === 0) {
        if (entry.isFile() || entry.isDirectory()) out.push(childRel)
      } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        await walk(path.join(dir, entry.name), childRel, tail)
      }
    }
  }

  try {
    await walk(rootAbs, fixedSegments.join('/'), matchers)
  } catch {
    // 固定前缀不存在 / 无权限：空结果
  }
  return out
}

/** 递归列目录条目（名称 + isDir + 大小），depth 为总层数（1 = 只列根层条目）。 */
async function listDirRecursive(absDir: string, baseRel: string, depth: number): Promise<unknown[]> {
  const entries = await fs.promises.readdir(absDir, { withFileTypes: true })
  const out: unknown[] = []
  for (const entry of entries) {
    const rel = baseRel ? `${baseRel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push({ name: `${rel}/`, isDir: true, size: null })
      if (depth > 1) {
        try {
          out.push(...(await listDirRecursive(path.join(absDir, entry.name), rel, depth - 1)))
        } catch {
          /* 子目录无权限：跳过其内容 */
        }
      }
    } else if (entry.isFile()) {
      try {
        const stats = await fs.promises.stat(path.join(absDir, entry.name))
        out.push({ name: rel, isDir: false, size: stats.size })
      } catch {
        out.push({ name: rel, isDir: false, size: null })
      }
    }
  }
  return out
}

/**
 * 项目查询工具集：只读访问工作目录内的文件。
 *
 * 工具（全部 `readOnlyHint`，路径相对 cwd）：
 *  - read_file(path, offset?, limit?)：读取文件内容，支持行区间；>1MB 截断提示。
 *  - grep(pattern, path?, maxResults?)：递归正则搜索文本文件，返回 `文件:行号: 内容` 摘要。
 *  - glob(pattern)：glob 通配匹配文件 / 目录路径（支持 `**` / `*` / `?` / `[...]`）。
 *  - list_dir(path?, depth?)：列目录条目（名称 + isDir + 大小），depth 默认 1、上限 3。
 */
export class ProjectQueryToolSource implements ToolSource {
  readonly id = 'project' as const
  readonly displayName = '项目查询'

  constructor(private readonly cwd: string) {}

  systemPrompt(): string {
    return [
      '你可以使用以下只读工具查询当前工作目录内的代码与文件：',
      '- read_file(path, offset?, limit?)：读取文件内容（支持行区间 offset/limit，行号从 0 起）。',
      '- grep(pattern, path?, maxResults?)：按正则搜索文件内容，返回 文件:行号: 内容 摘要。',
      '- glob(pattern)：按通配符模式匹配文件路径（支持 **、*、?、[a-z]）。',
      '- list_dir(path?, depth?)：列出目录条目（名称 + 是否目录 + 大小）。',
      '约束：这些工具只能读取，不能修改任何文件；所有路径均相对工作目录解析，越界路径会被拒绝。'
    ].join('\n')
  }

  tools(): ToolDeclaration[] {
    const cwd = this.cwd
    const tools: ToolDeclaration[] = [
      {
        name: 'read_file',
        description: `读取文件内容（UTF-8 文本）。path 相对工作目录（${cwd}）解析；offset/limit 按行切分（offset 默认 0，limit 默认全部）；超过 1MB 只读取前 1MB 并提示截断。`,
        schema: {
          path: z.string().describe('相对工作目录的文件路径'),
          offset: z.number().int().min(0).optional().describe('起始行号，默认 0'),
          limit: z.number().int().min(1).optional().describe('最多读取的行数，默认全部')
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => this.readFile(input)
      },
      {
        name: 'grep',
        description: `在文本文件中按正则搜索（大小写敏感）。从 path（相对工作目录，默认根目录）递归扫描，跳过 node_modules/.git/dist，深度上限 6 层；返回 "文件:行号: 内容" 摘要。`,
        schema: {
          pattern: z.string().describe('正则表达式，例如 payment|pay\\|charge'),
          path: z.string().optional().describe('相对工作目录的起始目录，默认工作目录根'),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(GREP_HARD_MAX)
            .optional()
            .describe(`最多返回条数，默认 ${GREP_DEFAULT_MAX}`)
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => this.grep(input)
      },
      {
        name: 'glob',
        description: `按 glob 模式匹配工作目录内的文件 / 目录路径，返回相对路径列表（最多 ${GLOB_MAX_RESULTS} 条）。支持 **（任意层目录）、*（段内任意字符）、?（单字符）、[a-z]（字符类）。`,
        schema: {
          pattern: z.string().describe('glob 模式，例如 src/**/*.ts 或 packages/*/package.json')
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => this.glob(input)
      },
      {
        name: 'list_dir',
        description: `列出目录条目（名称 + isDir + 文件大小）。path 相对工作目录，默认根目录；depth 控制递归层数，默认 1、上限 3。`,
        schema: {
          path: z.string().optional().describe('相对工作目录的目录路径，默认根目录'),
          depth: z.number().int().min(0).max(3).optional().describe('递归层数，默认 1')
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => this.listDir(input)
      }
    ]
    return tools
  }

  /** 查询工具不会创建任务，恒返回 undefined。 */
  describeResult(_output: unknown): ChatTaskCreationResult | undefined {
    return undefined
  }

  /** 纯 node:fs 实现，无外部资源需要释放。 */
  close(): void {}

  // === 工具实现 ============================================================

  private async readFile(input: Record<string, unknown>): Promise<unknown> {
    const filePath = typeof input.path === 'string' ? input.path : ''
    if (!filePath) throw new Error('缺少 path 参数')
    const abs = resolveWithin(this.cwd, filePath)
    const { content, truncated } = await readFileContent(abs)
    // 去掉末尾换行避免产生空行（行号与内容都更直观）
    const text = content.endsWith('\n') ? content.slice(0, -1) : content
    const lines = text.split('\n')
    const offset =
      typeof input.offset === 'number' && Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0
    const limit =
      typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0
        ? input.limit
        : lines.length - offset
    const slice = lines.slice(offset, offset + limit).join('\n')
    const notices: string[] = []
    if (truncated) notices.push(`[提示：文件超过 1MB，仅读取前 1MB]`)
    if (offset > 0 || limit < lines.length - offset) {
      notices.push(`[行区间 ${offset}..${Math.min(offset + limit, lines.length)} / 共 ${lines.length} 行]`)
    }
    return notices.length ? `${slice}\n${notices.join('\n')}` : slice
  }

  private async grep(input: Record<string, unknown>): Promise<unknown> {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern) throw new Error('缺少 pattern 参数')
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (error) {
      throw new Error(`非法正则: ${error instanceof Error ? error.message : String(error)}`)
    }
    const subPath = typeof input.path === 'string' && input.path ? input.path : '.'
    const root = resolveWithin(this.cwd, subPath)
    const maxResults =
      typeof input.maxResults === 'number' && Number.isInteger(input.maxResults)
        ? Math.min(Math.max(input.maxResults, 1), GREP_HARD_MAX)
        : GREP_DEFAULT_MAX
    const { results, truncated } = await grepScan({
      cwd: this.cwd,
      root,
      depth: GREP_MAX_DEPTH,
      regex,
      maxResults
    })
    return { count: results.length, truncated, results }
  }

  private async glob(input: Record<string, unknown>): Promise<unknown> {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern) throw new Error('缺少 pattern 参数')
    if (pattern.includes('\\')) {
      throw new Error('glob 模式不支持反斜杠，请使用正斜杠分隔路径')
    }
    return globScan(this.cwd, pattern)
  }

  private async listDir(input: Record<string, unknown>): Promise<unknown> {
    const subPath = typeof input.path === 'string' && input.path ? input.path : '.'
    const depth =
      typeof input.depth === 'number' && Number.isInteger(input.depth) ? Math.min(Math.max(input.depth, 0), 3) : 1
    const abs = resolveWithin(this.cwd, subPath)
    const stats = await fs.promises.stat(abs)
    if (!stats.isDirectory()) throw new Error(`${subPath} 不是目录`)
    return listDirRecursive(abs, '', depth)
  }
}

/** 工厂：为指定工作目录创建项目查询工具集（chat-service 注入用）。 */
export function createProjectQueryToolSource(cwd: string): ToolSource {
  return new ProjectQueryToolSource(cwd)
}
