/**
 * SQLite schema DDL for mini-Atlas code index。
 *
 * 全部 CREATE ... IF NOT EXISTS，幂等，支持对已有库增量初始化（对齐 memory/schema.ts 风格）。
 * 单库容纳多仓：以 repo_id 列区分（决策 #13：包不建库、不感知 dbPath，repo 归属由调用方传入）。
 */

/** 符号节点表。file_path 存「仓内相对路径」，行列为整文件 1-based 坐标。 */
export const NODE_DDL = `
  CREATE TABLE IF NOT EXISTS node (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    start_col INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    end_col INTEGER NOT NULL,
    signature TEXT,
    visibility TEXT,
    exported INTEGER NOT NULL DEFAULT 0,
    extra TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_node_repo ON node(repo_id);
  CREATE INDEX IF NOT EXISTS idx_node_name ON node(name);
  CREATE INDEX IF NOT EXISTS idx_node_kind ON node(kind);
  CREATE INDEX IF NOT EXISTS idx_node_file ON node(repo_id, file_path);
  CREATE INDEX IF NOT EXISTS idx_node_lang ON node(language);
`

/** 关系边表。to_node 可为空（未解析目标），此时用 to_name 记录意图。 */
export const EDGE_DDL = `
  CREATE TABLE IF NOT EXISTS edge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    from_node TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    to_node TEXT REFERENCES node(id) ON DELETE CASCADE,
    to_name TEXT,
    file_path TEXT,
    line INTEGER,
    provenance TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_edge_repo ON edge(repo_id);
  CREATE INDEX IF NOT EXISTS idx_edge_from ON edge(from_node);
  CREATE INDEX IF NOT EXISTS idx_edge_to ON edge(to_node);
  CREATE INDEX IF NOT EXISTS idx_edge_kindname ON edge(kind, to_name);
`

/** 文件索引记录：增量对账（mtime+size+hash）依据。 */
export const FILE_RECORD_DDL = `
  CREATE TABLE IF NOT EXISTS file_record (
    repo_id TEXT NOT NULL,
    path TEXT NOT NULL,
    language TEXT,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, path)
  );
`

/** 符号全文索引（trigram，与 memory 字面检索降级通道同源策略）。 */
export const NODE_FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
    name, qualified_name, signature,
    content='node', content_rowid='rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS node_fts_ai AFTER INSERT ON node BEGIN
    INSERT INTO node_fts(rowid, name, qualified_name, signature)
    VALUES (new.rowid, new.name, new.qualified_name, new.signature);
  END;

  CREATE TRIGGER IF NOT EXISTS node_fts_ad AFTER DELETE ON node BEGIN
    INSERT INTO node_fts(node_fts, rowid, name, qualified_name, signature)
    VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature);
  END;

  CREATE TRIGGER IF NOT EXISTS node_fts_au AFTER UPDATE ON node BEGIN
    INSERT INTO node_fts(node_fts, rowid, name, qualified_name, signature)
    VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature);
    INSERT INTO node_fts(rowid, name, qualified_name, signature)
    VALUES (new.rowid, new.name, new.qualified_name, new.signature);
  END;
`

export const ALL_DDL = [NODE_DDL, EDGE_DDL, FILE_RECORD_DDL, NODE_FTS_DDL]
