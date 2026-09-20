/**
 * codebase_search 的有界输出格式化（决策 #7 / #11：30KB 硬顶、不返完整源码）。
 *
 * 为什么单独一层：QoderSession 跨 plan/impl/test 共享上下文、每步重发整段历史，
 * 胖输出会被反复付费。这里把检索命中渲染成「指针 + 极短片段」，逐块累加、触顶即截，
 * 保证任何命中规模下输出都有界。纯逻辑 + 注入 FileSystem，可脱离 Electron 单测。
 */

import type { FileSystem, SearchHit } from '../types.js'

/** 输出硬上限（字节）。留 1KB 余量给收尾，实际略小于此值即停。 */
export const DEFAULT_MAX_BYTES = 30 * 1024
/** 每个命中附带的源码行数（从 startLine 起）。 */
export const DEFAULT_SNIPPET_LINES = 5
/** 单行片段截断宽度，防压缩过的巨型单行撑爆。 */
const MAX_LINE_CHARS = 200

export interface BoundedFormatOptions {
  maxBytes?: number
  snippetLines?: number
  /** repoId → 展示用仓名（指针前缀，避免近名串仓翻车）。 */
  repoNames?: Record<string, string>
  /** repoId → 工作目录绝对路径；提供且传 fs 时才读片段，否则只出指针。 */
  rootDirs?: Record<string, string>
  fs?: FileSystem
}

export interface BoundedFormatResult {
  /** 渲染后的文本（可能为空串，表示无命中）。 */
  text: string
  /** 实际渲染进输出的命中数。 */
  included: number
  /** 参与渲染的候选命中总数。 */
  total: number
  /** 是否因触顶或候选耗尽而未全部展开。 */
  truncated: boolean
}

function join(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`
}

/** 从文件内容切 [fromLine, ..) 共 count 行（1-based）。 */
function sliceSnippet(content: string, fromLine: number, count: number): string[] {
  const lines = content.split('\n')
  const start = Math.max(0, fromLine - 1)
  const out: string[] = []
  for (let i = start; i < Math.min(lines.length, start + count); i++) {
    const raw = lines[i] ?? ''
    out.push(raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS - 1)}…` : raw)
  }
  return out
}

/**
 * 渲染有界检索输出。命中的先后顺序即渲染顺序（调用方负责按相关度排好）。
 * 同 (repo, file, line, kind, name) 去重。逐块累加，加下一块会越界即停并标 truncated。
 */
export function formatBoundedSearch(hits: SearchHit[], options: BoundedFormatOptions = {}): BoundedFormatResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const snippetLines = options.snippetLines ?? DEFAULT_SNIPPET_LINES
  const fs = options.fs
  const rootDirs = options.rootDirs
  const canSnippet = !!(fs && rootDirs)

  const total = hits.length
  const seen = new Set<string>()
  const chunks: string[] = []
  const contentCache = new Map<string, string[] | null>()
  let used = 0
  let included = 0
  let truncated = false

  const readLines = (repoId: string, relPath: string): string[] | null => {
    const key = `${repoId}\u0000${relPath}`
    if (contentCache.has(key)) return contentCache.get(key) ?? null
    const root = rootDirs?.[repoId]
    let lines: string[] | null = null
    if (root && fs) {
      try {
        lines = fs.readFile(join(root, relPath)).split('\n')
      } catch {
        lines = null
      }
    }
    contentCache.set(key, lines)
    return lines
  }

  for (const h of hits) {
    const dedupe = `${h.repoId}\u0000${h.filePath}\u0000${h.startLine}\u0000${h.kind}\u0000${h.name}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)

    const repoName = options.repoNames?.[h.repoId] ?? h.repoId
    const label = h.qualifiedName && h.qualifiedName !== h.name ? `${h.name} (${h.qualifiedName})` : h.name
    let block = `${repoName}/${h.filePath}:${h.startLine}  [${h.kind}] ${label}`
    const sig = h.signature?.trim()
    if (sig && sig !== label) block += `\n  $ ${sig}`

    if (canSnippet) {
      const lines = readLines(h.repoId, h.filePath)
      if (lines) {
        const snippet = sliceSnippet(lines.join('\n'), h.startLine, snippetLines)
        if (snippet.length) {
          block += '\n' + snippet.map((l, i) => `  ${h.startLine + i} | ${l.replace(/\s+$/, '')}`).join('\n')
        }
      }
    }

    const cost = Buffer.byteLength(block, 'utf8') + (chunks.length ? 1 : 0)
    if (used + cost > maxBytes) {
      truncated = included < total
      break
    }
    chunks.push(block)
    used += cost
    included++
  }

  if (!truncated && included < total) truncated = true

  const text =
    truncated && included > 0 ? `${chunks.join('\n')}\n…(结果已达上限截断，请用更精确的符号名收窄)` : chunks.join('\n')
  return { text, included, total, truncated }
}
