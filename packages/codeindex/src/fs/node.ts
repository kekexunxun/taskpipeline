/**
 * 默认 FileSystem 实现（基于 node:fs）。
 *
 * 说明：包的核心索引逻辑只依赖 types.ts 里的 FileSystem 接口，本文件只是「开箱即用」的默认实现，
 * 供纯 Node（CLI / 服务端 / vitest）直接复用；Electron 接线层可注入自己的实现（例如带权限沙箱、
 * 大小写规范化、跨平台路径处理）。真正被禁止的是包耦合 Electron API / 自持 chokidar / 写死 dbPath，
 * 而非「不能用 node:fs」——CLI headless 复用同样需要 fs。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { FileSystem, FileStat } from '../types.js'

export class NodeFileSystem implements FileSystem {
  readFile(path: string): string {
    return readFileSync(path, 'utf8')
  }
  stat(path: string): FileStat | null {
    try {
      const s = statSync(path)
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() }
    } catch {
      return null
    }
  }
  readDir(path: string): string[] {
    return readdirSync(path)
  }
  exists(path: string): boolean {
    return existsSync(path)
  }
  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }
}

export function createNodeFileSystem(): FileSystem {
  return new NodeFileSystem()
}
