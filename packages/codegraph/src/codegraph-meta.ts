/**
 * 索引元数据持久化。
 *
 * 每个仓库的索引状态保存在 dataDir/codegraph/<hash>/meta.json。
 * 同时在内存中维护 metaCache 以避免频繁磁盘读取。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoIndexMeta } from './types.js'

/** meta.json 文件名 */
const META_FILENAME = 'meta.json'

/**
 * 从磁盘加载单个仓库的索引元数据。
 */
export function loadMeta(indexDir: string): RepoIndexMeta | null {
  const metaPath = join(indexDir, META_FILENAME)
  if (!existsSync(metaPath)) return null
  try {
    const content = readFileSync(metaPath, 'utf-8')
    return JSON.parse(content) as RepoIndexMeta
  } catch {
    return null
  }
}

/**
 * 将仓库索引元数据持久化到磁盘。
 */
export function saveMeta(indexDir: string, meta: RepoIndexMeta): void {
  mkdirSync(indexDir, { recursive: true })
  const metaPath = join(indexDir, META_FILENAME)
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
}

/**
 * 删除仓库的索引元数据文件。
 */
export function deleteMeta(indexDir: string): void {
  const metaPath = join(indexDir, META_FILENAME)
  if (existsSync(metaPath)) {
    rmSync(metaPath, { force: true })
  }
}

/**
 * 扫描索引根目录，加载所有仓库的元数据。
 */
export function loadAllMeta(indexRoot: string): Map<string, RepoIndexMeta> {
  const result = new Map<string, RepoIndexMeta>()
  if (!existsSync(indexRoot)) return result

  const entries = readdirSync(indexRoot, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const indexDir = join(indexRoot, entry.name)
    const meta = loadMeta(indexDir)
    if (meta) {
      // 使用 repositoryId 作为 key（而非 hash）
      result.set(meta.repositoryId, meta)
    }
  }

  return result
}
