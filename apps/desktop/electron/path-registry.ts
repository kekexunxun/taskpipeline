/**
 * PathRegistry — 路径级索引注册表。
 *
 * 以本地路径为唯一键，统一管理仓库和对话文件夹的元数据。
 * 与 TaskStore 共享同一个 SQLite 数据库文件（path_registry 表）。
 */
import type Database from 'better-sqlite3'

export type PathRegistryEntry = {
  path: string
  name: string
  hasRepo: boolean
  hasConversation: boolean
  repositoryId?: string
  repositoryName?: string
  defaultBranch?: string
  wikiDocCount: number
  updatedAt: string
}

type RepoInput = {
  id: string
  name: string
  localPath: string
  defaultBranch: string
}

type DirGroupInput = {
  directories: string[]
}

/** 从路径中提取最后一段作为显示名。 */
function baseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

export class PathRegistry {
  constructor(private readonly db: Database.Database) {}

  /**
   * 全量重建 path_registry 表（事务内执行）。
   *
   * @param repos     仓库配置列表
   * @param dirGroups directory 类型的 chatGroup 列表
   * @param wikiCounts repositoryId → wiki 文档数 映射
   */
  refresh(repos: RepoInput[], dirGroups: DirGroupInput[], wikiCounts: Record<string, number>): void {
    const now = new Date().toISOString()

    const insertEntry = this.db.prepare(`
      INSERT INTO path_registry (path, name, has_repo, has_conversation, repository_id, repository_name, default_branch, wiki_doc_count, updated_at)
      VALUES (@path, @name, @hasRepo, @hasConversation, @repositoryId, @repositoryName, @defaultBranch, @wikiDocCount, @updatedAt)
    `)

    const updateConversation = this.db.prepare(`
      UPDATE path_registry SET has_conversation = 1, updated_at = @updatedAt WHERE path = @path
    `)

    const transaction = () => {
      this.db.exec('DELETE FROM path_registry')

      // 1. 仓库 → 插入条目（has_repo = 1）
      for (const repo of repos) {
        insertEntry.run({
          path: repo.localPath,
          name: repo.name,
          hasRepo: 1,
          hasConversation: 0,
          repositoryId: repo.id,
          repositoryName: repo.name,
          defaultBranch: repo.defaultBranch,
          wikiDocCount: wikiCounts[repo.id] ?? 0,
          updatedAt: now
        })
      }

      // 2. 对话文件夹 → 若已存在则标记 has_conversation，否则新建
      for (const group of dirGroups) {
        const dir = group.directories[0]
        if (!dir) continue
        const existing = this.db.prepare('SELECT path FROM path_registry WHERE path = ?').get(dir) as
          | { path: string }
          | undefined
        if (existing) {
          updateConversation.run({ path: dir, updatedAt: now })
        } else {
          insertEntry.run({
            path: dir,
            name: baseName(dir),
            hasRepo: 0,
            hasConversation: 1,
            repositoryId: null,
            repositoryName: null,
            defaultBranch: null,
            wikiDocCount: 0,
            updatedAt: now
          })
        }
      }
    }

    this.db.transaction(transaction)()
  }

  /** 查询全部条目。 */
  listEntries(): PathRegistryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT path, name, has_repo as hasRepo, has_conversation as hasConversation,
                repository_id as repositoryId, repository_name as repositoryName,
                default_branch as defaultBranch, wiki_doc_count as wikiDocCount,
                updated_at as updatedAt
         FROM path_registry ORDER BY name`
      )
      .all() as Array<Record<string, unknown>>

    return rows.map((row) => ({
      path: String(row.path),
      name: String(row.name),
      hasRepo: Number(row.hasRepo) === 1,
      hasConversation: Number(row.hasConversation) === 1,
      repositoryId: row.repositoryId ? String(row.repositoryId) : undefined,
      repositoryName: row.repositoryName ? String(row.repositoryName) : undefined,
      defaultBranch: row.defaultBranch ? String(row.defaultBranch) : undefined,
      wikiDocCount: Number(row.wikiDocCount ?? 0),
      updatedAt: String(row.updatedAt)
    }))
  }

  /** 单独更新 wiki 文档数。 */
  updateWikiCount(path: string, count: number): void {
    this.db
      .prepare('UPDATE path_registry SET wiki_doc_count = ?, updated_at = ? WHERE path = ?')
      .run(count, new Date().toISOString(), path)
  }

  /** 清除仓库标志；若同时无对话则删行。 */
  removeRepo(path: string): void {
    const row = this.db.prepare('SELECT has_conversation FROM path_registry WHERE path = ?').get(path) as
      | { has_conversation: number }
      | undefined
    if (!row) return
    if (row.has_conversation) {
      this.db
        .prepare(
          'UPDATE path_registry SET has_repo = 0, repository_id = NULL, repository_name = NULL, default_branch = NULL, wiki_doc_count = 0, updated_at = ? WHERE path = ?'
        )
        .run(new Date().toISOString(), path)
    } else {
      this.db.prepare('DELETE FROM path_registry WHERE path = ?').run(path)
    }
  }

  /** 清除对话标志；若同时无仓库则删行。 */
  removeConversation(path: string): void {
    const row = this.db.prepare('SELECT has_repo FROM path_registry WHERE path = ?').get(path) as
      | { has_repo: number }
      | undefined
    if (!row) return
    if (row.has_repo) {
      this.db
        .prepare('UPDATE path_registry SET has_conversation = 0, updated_at = ? WHERE path = ?')
        .run(new Date().toISOString(), path)
    } else {
      this.db.prepare('DELETE FROM path_registry WHERE path = ?').run(path)
    }
  }
}
