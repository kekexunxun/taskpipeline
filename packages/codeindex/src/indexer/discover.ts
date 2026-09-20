/**
 * 文件发现：决定「哪些文件该被索引」。
 *
 * 规则（决策 #12，与 codegraph 有意分歧）：
 *  - 纯 `.gitignore` 驱动：有则尊之（支持嵌套 + `!` 取反），无 `.gitignore` 或非 git 仓 → 全量。
 *  - 永远硬跳开一批产物/依赖目录（即使没写进 .gitignore）。
 *  - **不采用 codegraph 的「仅 git-tracked」过滤**——否则 Task agent 刚写、还没 commit 的代码查不到。
 *  - 单文件体积上限（默认 1MB）。
 *  - 拒绝危险 root（文件系统根 / 用户家目录）。
 *
 * 只通过注入的 FileSystem 接口访问磁盘，保持可换实现 / 可测。
 */

import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Ignore } from 'ignore'
import ignoreMod from 'ignore'
import type { FileSystem, Language } from '../types.js'
import { resolveByExtension } from '../backend/grammars.js'

// `ignore` 是 CJS 且把工厂挂在 module.exports/.default 上；NodeNext 下默认导入不一定可调用，做 interop 兜底。
type IgnoreFactory = (options?: { ignorecase?: boolean }) => Ignore
const createIgnore: IgnoreFactory =
  (ignoreMod as unknown as { default?: IgnoreFactory }).default ?? (ignoreMod as unknown as IgnoreFactory)

/** 无论如何都跳过的目录名（产物 / 依赖 / 缓存）。 */
export const DEFAULT_HARD_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.idea',
  '.sass-cache'
])

export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024 // 1MB

export interface DiscoverOptions {
  fs: FileSystem
  /** 绝对路径（工作目录 / 仓根 / worktree 根）。 */
  rootDir: string
  respectGitignore?: boolean
  maxFileSizeBytes?: number
  hardSkipDirs?: Set<string>
  /** 额外追加的忽略模式（等价 .gitignore 片段）。 */
  extraIgnore?: string[]
  /** 递归深度保护。 */
  maxDepth?: number
}

export interface DiscoveredFile {
  absPath: string
  /** 仓内相对路径（POSIX `/` 分隔）。 */
  relPath: string
  language: Language
  size: number
  mtimeMs: number
}

/** 判定不安全索引根：文件系统根、用户家目录、或过浅的系统级目录。返回拒绝理由或 null。 */
export function unsafeIndexRootReason(rootDir: string): string | null {
  const abs = resolve(rootDir)
  const home = resolve(homedir())
  if (abs === sep && (process.platform !== 'win32' || rootDir.length <= 3)) {
    return '索引根是文件系统根目录，拒绝（避免全盘扫描）。'
  }
  if (abs === home) {
    return '索引根是用户家目录，拒绝（避免索引家目录下全部文件）。'
  }
  return null
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/** 递归发现可索引文件。 */
export function discoverFiles(opts: DiscoverOptions): DiscoveredFile[] {
  const { fs } = opts
  const rootAbs = resolve(opts.rootDir)
  if (opts.respectGitignore !== false) {
    const reason = unsafeIndexRootReason(rootAbs)
    if (reason) throw new Error(`[codeindex] ${reason}`)
  }
  const respect = opts.respectGitignore !== false
  const maxSize = opts.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE
  const hardSkip = opts.hardSkipDirs ?? DEFAULT_HARD_SKIP_DIRS
  const maxDepth = opts.maxDepth ?? 24

  const out: DiscoveredFile[] = []
  // 祖先 ignore 栈：每项记录其所属目录（相对 root）与 matcher。
  const stack: Array<{ relDir: string; ig: Ignore }> = []

  const makeMatcher = (dirAbs: string, relDir: string): { relDir: string; ig: Ignore } | null => {
    const giPath = resolve(dirAbs, '.gitignore')
    const ig = createIgnore()
    let hasRules = false
    if (fs.exists(giPath)) {
      try {
        ig.add(fs.readFile(giPath))
        hasRules = true
      } catch {
        /* ignore 读失败 */
      }
    }
    if (relDir === '' && opts.extraIgnore?.length) {
      ig.add(opts.extraIgnore)
      hasRules = true
    }
    return hasRules ? { relDir, ig } : null
  }

  const rootMatcher = makeMatcher(rootAbs, '')
  if (respect && rootMatcher) stack.push(rootMatcher)
  else if (!respect && opts.extraIgnore?.length) {
    const ig = createIgnore().add(opts.extraIgnore)
    stack.push({ relDir: '', ig })
  }

  const isIgnored = (relPath: string): boolean => {
    for (const { relDir, ig } of stack) {
      const rel = relDir ? relPath.slice(relDir.length + 1) : relPath
      if (ig.ignores(rel)) return true
    }
    return false
  }

  const walk = (dirAbs: string, dirRel: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = fs.readDir(dirAbs)
    } catch {
      return
    }
    for (const name of entries) {
      const childAbs = resolve(dirAbs, name)
      const childRel = dirRel ? `${dirRel}/${name}` : name
      if (hardSkip.has(name)) continue
      const st = fs.stat(childAbs)
      if (!st) continue
      if (st.isDirectory) {
        if (respect && isIgnored(childRel)) continue // 目录级忽略：整棵剪枝
        const m = respect ? makeMatcher(childAbs, childRel) : null
        if (m) stack.push(m)
        walk(childAbs, childRel, depth + 1)
        if (m) stack.pop()
        continue
      }
      if (!st.isFile) continue // 跳过符号链接目标/管道等（statSync 不跟随? 这里按普通文件处理）
      const ext = name.slice(name.lastIndexOf('.'))
      const mapped = resolveByExtension(ext.toLowerCase())
      if (!mapped) continue
      if (st.size > maxSize) continue
      if (respect && isIgnored(childRel)) continue
      out.push({
        absPath: childAbs,
        relPath: toPosix(isAbsolute(childAbs) ? relativePosix(rootAbs, childAbs) : childRel),
        language: mapped.language,
        size: st.size,
        mtimeMs: Math.floor(st.mtimeMs)
      })
    }
  }

  walk(rootAbs, '', 0)
  return out
}

function relativePosix(root: string, child: string): string {
  const r = toPosix(root)
  const c = toPosix(child)
  return c.startsWith(r + '/') ? c.slice(r.length + 1) : c
}
