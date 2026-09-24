/** Electron 装配层：应用级单例、数据库位置与创建/清理策略；索引运行逻辑在 package。 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import {
  CodeIndexRegistry,
  CodeIndexService,
  NodeFileSystem,
  WebTreeSitterBackend,
  indexKeyFor,
  type IndexSummary
} from '@task-pipeline/codeindex'
import { NodeIndexWatcher } from '@task-pipeline/codeindex/node-watcher'

let instance: CodeIndexService | undefined

export function initCodeIndex(dataDir: string): CodeIndexService {
  if (!instance) {
    const indexRootDir = join(dataDir, 'codeindex')
    const registry = new CodeIndexRegistry({
      // 保持原路径与 key，canonical 和 worktree 各自独立，数据库不写入用户仓库。
      dbPathFor: (dir) => join(indexRootDir, indexKeyFor(dir), 'graph.db'),
      openDatabase: (dbPath) => {
        mkdirSync(dirname(dbPath), { recursive: true })
        return new Database(dbPath)
      },
      deleteDatabase: (dbPath) => rmSync(dirname(dbPath), { recursive: true, force: true })
    })
    instance = new CodeIndexService({
      registry,
      backend: new WebTreeSitterBackend(),
      fs: new NodeFileSystem(),
      createWatcher: (options) => new NodeIndexWatcher(options),
      onError: (error, context) => {
        console.warn(`[codeindex] ${context.phase === 'index' ? '首扫对账' : '增量同步'}失败:`, error)
      },
      indexRootDir,
      // 临时打开 DB 用（不创建父目录）
      openDatabase: (dbPath) => new Database(dbPath)
    })
  }
  return instance
}

export function getCodeIndex(): CodeIndexService | undefined {
  return instance
}

// ── 索引管理 API（供 IPC handler 调用）─────────────────────────────────────

export async function listCodeIndexeses(): Promise<IndexSummary[]> {
  return instance?.listIndexes() ?? []
}

export async function deleteCodeIndex(dir: string): Promise<void> {
  await instance?.deleteIndex(dir)
}

export async function rebuildCodeIndex(dir: string): Promise<void> {
  await instance?.rebuildIndex(dir)
}
