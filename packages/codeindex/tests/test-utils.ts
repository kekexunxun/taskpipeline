/**
 * 测试共享工具：构造已加载 grammar 的 backend + 一个纯内存 FileSystem（测 discover 用，
 * 顺带验证 FileSystem 注入接口可用）。
 */

import { WebTreeSitterBackend } from '../src/index.js'
import type { FileStat, FileSystem, ParserBackend } from '../src/types.js'

export async function makeBackend(): Promise<ParserBackend> {
  const b = new WebTreeSitterBackend()
  for (const g of ['javascript', 'typescript', 'tsx', 'vue', 'python']) {
    const ok = await b.ensureLanguage(g)
    if (!ok) throw new Error(`grammar 加载失败: ${g}`)
  }
  return b
}

/** 把 absPath→content 的扁平映射当作只读文件系统；目录由路径推断。 */
export class MemFileSystem implements FileSystem {
  private readonly fileMap: Record<string, string>
  private readonly sizes: Record<string, number>
  private readonly mtimes: Record<string, number>

  constructor(
    files: Record<string, string>,
    opts: { sizes?: Record<string, number>; mtimes?: Record<string, number> } = {}
  ) {
    this.fileMap = files
    this.sizes = opts.sizes ?? {}
    this.mtimes = opts.mtimes ?? {}
  }

  private norm(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  }

  readFile(path: string): string {
    const key = this.norm(path)
    if (key in this.fileMap) return this.fileMap[key] as string
    throw new Error(`ENOENT: ${path}`)
  }

  exists(path: string): boolean {
    const key = this.norm(path)
    if (key in this.fileMap) return true
    // 目录？
    return Object.keys(this.fileMap).some((f) => f.startsWith(key + '/'))
  }

  isDirectory(path: string): boolean {
    const key = this.norm(path)
    return !(key in this.fileMap) && Object.keys(this.fileMap).some((f) => f.startsWith(key + '/'))
  }

  stat(path: string): FileStat | null {
    const key = this.norm(path)
    if (key in this.fileMap) {
      return {
        size: this.sizes[key] ?? Buffer.byteLength(this.fileMap[key] as string),
        mtimeMs: this.mtimes[key] ?? 1000,
        isFile: true,
        isDirectory: false
      }
    }
    if (this.isDirectory(key)) {
      return { size: 0, mtimeMs: 1000, isFile: false, isDirectory: true }
    }
    return null
  }

  readDir(path: string): string[] {
    const key = this.norm(path)
    const set = new Set<string>()
    for (const f of Object.keys(this.fileMap)) {
      if (!f.startsWith(key + '/')) continue
      const rest = f.slice(key.length + 1)
      const seg = rest.split('/')[0]
      if (seg) set.add(seg)
    }
    return [...set]
  }
}
