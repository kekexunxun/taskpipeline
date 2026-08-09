import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Memory, MemoryScope, MemorySearchHit, RepoWikiDoc, RepoWikiSearchHit } from "./types.js";

/**
 * 将 LLM 提取的关键词数组转成 FTS5 MATCH 表达式。
 *
 * 背景：
 * - FTS5 原来用 unicode61 分词器处理中文按码点切，召回率极低。
 * - 现已迁移到 `tokenize='trigram'`，但 trigram 至少需要 3 字符才能建索引；
 *   短词 (<3 字符) 单独查不到，靠 OR 合并里的"长尾词"兜住。
 * - 多个关键词用 `OR` 合并，配合 `bm25()` 自然排序，比单关键词 AND 召回更高。
 */
function ftsQuery(keywords: string[]): string {
  const cleaned = keywords
    .map((keyword) => keyword.trim().replace(/"/g, '""'))
    .filter((keyword) => keyword.length > 0);
  if (!cleaned.length) return "";
  return cleaned
    .map((keyword) => (keyword.length <= 2 ? `"${keyword}"` : `"${keyword}"*`))
    .join(" OR ");
}

/**
 * 启动时迁移：检测现有 FTS5 表是否仍用旧 unicode61 分词器；
 * 若是，删除并用 trigram 重建（同时从原始表重新填充）。
 * 项目未上线，数据库可随意重建，不需要保留旧索引。
 */
function migrateFtsToTrigram(db: Database.Database): void {
  const memoriesFts = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'")
    .get() as { sql?: string } | undefined;
  if (memoriesFts?.sql && !memoriesFts.sql.includes("tokenize='trigram'")) {
    db.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TABLE IF EXISTS memories_fts;
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        title, content, tags,
        content='memories', content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      INSERT INTO memories_fts(rowid, title, content, tags) SELECT rowid, title, content, tags FROM memories;
    `);
  }
  const wikiFts = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='repo_wiki_docs_fts'")
    .get() as { sql?: string } | undefined;
  if (wikiFts?.sql && !wikiFts.sql.includes("tokenize='trigram'")) {
    db.exec(`
      DROP TRIGGER IF EXISTS repo_wiki_docs_ai;
      DROP TRIGGER IF EXISTS repo_wiki_docs_ad;
      DROP TRIGGER IF EXISTS repo_wiki_docs_au;
      DROP TABLE IF EXISTS repo_wiki_docs_fts;
      CREATE VIRTUAL TABLE repo_wiki_docs_fts USING fts5(
        title, content,
        content='repo_wiki_docs', content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE TRIGGER repo_wiki_docs_ai AFTER INSERT ON repo_wiki_docs BEGIN
        INSERT INTO repo_wiki_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
      CREATE TRIGGER repo_wiki_docs_ad AFTER DELETE ON repo_wiki_docs BEGIN
        INSERT INTO repo_wiki_docs_fts(repo_wiki_docs_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
      END;
      CREATE TRIGGER repo_wiki_docs_au AFTER UPDATE ON repo_wiki_docs BEGIN
        INSERT INTO repo_wiki_docs_fts(repo_wiki_docs_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
        INSERT INTO repo_wiki_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
      INSERT INTO repo_wiki_docs_fts(rowid, title, content) SELECT rowid, title, content FROM repo_wiki_docs;
    `);
  }
}

export class MemoryStore {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT, repository_id TEXT, conversation_id TEXT,
        title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title, content, tags,
        content='memories', content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      CREATE TABLE IF NOT EXISTS repo_wiki_docs (
        id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, path TEXT NOT NULL,
        title TEXT NOT NULL, content TEXT NOT NULL, mtime TEXT, hash TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS repo_wiki_docs_fts USING fts5(
        title, content,
        content='repo_wiki_docs', content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS repo_wiki_docs_ai AFTER INSERT ON repo_wiki_docs BEGIN
        INSERT INTO repo_wiki_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS repo_wiki_docs_ad AFTER DELETE ON repo_wiki_docs BEGIN
        INSERT INTO repo_wiki_docs_fts(repo_wiki_docs_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS repo_wiki_docs_au AFTER UPDATE ON repo_wiki_docs BEGIN
        INSERT INTO repo_wiki_docs_fts(repo_wiki_docs_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
        INSERT INTO repo_wiki_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
    `);
    migrateFtsToTrigram(db);
  }

  private now(): string { return new Date().toISOString(); }

  private parseMemory(row: Record<string, unknown>): Memory {
    return {
      id: String(row.id), scope: String(row.scope) as MemoryScope,
      userId: row.user_id ? String(row.user_id) : undefined,
      repositoryId: row.repository_id ? String(row.repository_id) : undefined,
      conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
      title: String(row.title), content: String(row.content),
      tags: JSON.parse(String(row.tags)),
      pinned: Number(row.pinned) === 1, importance: Number(row.importance),
      source: String(row.source) as Memory["source"],
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  createMemory(input: Omit<Memory, "id" | "createdAt" | "updatedAt">): Memory {
    const memory: Memory = { ...input, id: randomUUID(), createdAt: this.now(), updatedAt: this.now() };
    this.db.prepare(`INSERT INTO memories (id,scope,user_id,repository_id,conversation_id,title,content,tags,pinned,importance,source,created_at,updated_at)
      VALUES (@id,@scope,@userId,@repositoryId,@conversationId,@title,@content,@tags,@pinned,@importance,@source,@createdAt,@updatedAt)`).run({ ...memory, userId: memory.userId ?? null, repositoryId: memory.repositoryId ?? null, conversationId: memory.conversationId ?? null, tags: JSON.stringify(memory.tags), pinned: memory.pinned ? 1 : 0 });
    return memory;
  }

  updateMemory(id: string, patch: Partial<Omit<Memory, "id" | "createdAt" | "updatedAt">>): Memory {
    const current = this.getMemory(id);
    if (!current) throw new Error(`Memory not found: ${id}`);
    const next: Memory = { ...current, ...patch, updatedAt: this.now() };
    this.db.prepare(`UPDATE memories SET scope=@scope,user_id=@userId,repository_id=@repositoryId,conversation_id=@conversationId,title=@title,content=@content,tags=@tags,pinned=@pinned,importance=@importance,source=@source,updated_at=@updatedAt WHERE id=@id`).run({ ...next, tags: JSON.stringify(next.tags), pinned: next.pinned ? 1 : 0 });
    return next;
  }

  deleteMemory(id: string): void { this.db.prepare("DELETE FROM memories WHERE id = ?").run(id); }

  deleteMemories(filter: { repositoryId?: string; conversationId?: string; scope?: MemoryScope } = {}): number {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.repositoryId) { clauses.push("repository_id = ?"); params.push(filter.repositoryId); }
    if (filter.conversationId) { clauses.push("conversation_id = ?"); params.push(filter.conversationId); }
    if (filter.scope) { clauses.push("scope = ?"); params.push(filter.scope); }
    if (!clauses.length) return 0;
    return this.db.prepare(`DELETE FROM memories WHERE ${clauses.join(" AND ")}`).run(...params).changes;
  }

  getMemory(id: string): Memory | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.parseMemory(row) : undefined;
  }

  listMemories(filter: { scope?: MemoryScope; scopes?: MemoryScope[]; repositoryId?: string; userId?: string; conversationId?: string } = {}): Memory[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.scopes?.length) { clauses.push(`scope IN (${filter.scopes.map(() => "?").join(",")})`); params.push(...filter.scopes); }
    if (filter.scope) { clauses.push("scope = ?"); params.push(filter.scope); }
    if (filter.repositoryId) { clauses.push("repository_id = ?"); params.push(filter.repositoryId); }
    if (filter.userId) { clauses.push("user_id = ?"); params.push(filter.userId); }
    if (filter.conversationId) { clauses.push("conversation_id = ?"); params.push(filter.conversationId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM memories ${where} ORDER BY pinned DESC, updated_at DESC`).all(...params) as Record<string, unknown>[]).map((row) => this.parseMemory(row));
  }

  searchMemories(input: { keywords: string[]; scopes?: MemoryScope[]; repositoryId?: string; userId?: string; conversationId?: string; limit?: number }): MemorySearchHit[] {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    const query = ftsQuery(input.keywords);
    if (!query) return [];
    const clauses = ["memories_fts MATCH ?"];
    const params: unknown[] = [query];
    if (input.scopes?.length) { clauses.push(`memories.scope IN (${input.scopes.map(() => "?").join(",")})`); params.push(...input.scopes); }
    if (input.repositoryId) { clauses.push("memories.repository_id = ?"); params.push(input.repositoryId); }
    if (input.userId) { clauses.push("memories.user_id = ?"); params.push(input.userId); }
    if (input.conversationId) { clauses.push("memories.conversation_id = ?"); params.push(input.conversationId); }
    params.push(limit);
    const rows = this.db.prepare(`SELECT memories.*, CAST(-bm25(memories_fts) * 100 AS INTEGER) AS score FROM memories_fts JOIN memories ON memories.rowid = memories_fts.rowid WHERE ${clauses.join(" AND ")} ORDER BY memories.pinned DESC, score DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...this.parseMemory(row), score: Number(row.score) }));
  }

  private parseRepoWikiDoc(row: Record<string, unknown>): RepoWikiDoc {
    return {
      id: String(row.id), repositoryId: String(row.repository_id), path: String(row.path),
      title: String(row.title), content: String(row.content),
      mtime: row.mtime ? String(row.mtime) : undefined, hash: String(row.hash),
      updatedAt: String(row.updated_at)
    };
  }

  upsertRepoWikiDoc(doc: Omit<RepoWikiDoc, "id" | "updatedAt"> & { id?: string }): RepoWikiDoc {
    const row = doc.id
      ? this.db.prepare("SELECT * FROM repo_wiki_docs WHERE id = ?").get(doc.id) as Record<string, unknown> | undefined
      : this.db.prepare("SELECT * FROM repo_wiki_docs WHERE repository_id = ? AND path = ?").get(doc.repositoryId, doc.path) as Record<string, unknown> | undefined;
    if (row) {
      const current = this.parseRepoWikiDoc(row);
      this.db.prepare("UPDATE repo_wiki_docs SET title=@title,content=@content,mtime=@mtime,hash=@hash,updated_at=@updatedAt WHERE id=@id").run({ ...doc, id: current.id, updatedAt: this.now() });
      return { ...current, ...doc, updatedAt: this.now() };
    }
    const next: RepoWikiDoc = { ...doc, id: doc.id ?? randomUUID(), updatedAt: this.now() };
    this.db.prepare("INSERT INTO repo_wiki_docs (id,repository_id,path,title,content,mtime,hash,updated_at) VALUES (@id,@repositoryId,@path,@title,@content,@mtime,@hash,@updatedAt)").run({ ...next, mtime: next.mtime ?? null });
    return next;
  }

  deleteRepoWikiDoc(id: string): void { this.db.prepare("DELETE FROM repo_wiki_docs WHERE id = ?").run(id); }
  clearRepoWikiDocs(repositoryId: string): void { this.db.prepare("DELETE FROM repo_wiki_docs WHERE repository_id = ?").run(repositoryId); }

  listRepoWikiDocs(repositoryId: string): RepoWikiDoc[] {
    return (this.db.prepare("SELECT * FROM repo_wiki_docs WHERE repository_id = ? ORDER BY path").all(repositoryId) as Record<string, unknown>[]).map((row) => this.parseRepoWikiDoc(row));
  }

  searchRepoWikiDocs(input: { repositoryId: string; keywords: string[]; limit?: number }): RepoWikiSearchHit[] {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    const query = ftsQuery(input.keywords);
    if (!query) return [];
    const rows = this.db.prepare(`SELECT docs.*, CAST(-bm25(repo_wiki_docs_fts) * 100 AS INTEGER) AS score FROM repo_wiki_docs_fts JOIN repo_wiki_docs docs ON docs.rowid = repo_wiki_docs_fts.rowid WHERE repo_wiki_docs_fts MATCH ? AND docs.repository_id = ? ORDER BY score DESC LIMIT ?`).all(query, input.repositoryId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...this.parseRepoWikiDoc(row), score: Number(row.score) }));
  }
}
