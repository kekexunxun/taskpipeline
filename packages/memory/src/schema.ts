/**
 * SQLite schema DDL for Memory Engine。
 *
 * 所有表在 MemoryEngine 构造时通过 CREATE TABLE IF NOT EXISTS 创建，
 * 幂等安全，支持已有数据库增量初始化。
 */

/** MemoryNode 表 + 索引 */
export const MEMORY_NODES_DDL = `
  CREATE TABLE IF NOT EXISTS memory_nodes (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES memory_nodes(id),
    node_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    confidence REAL NOT NULL DEFAULT 0.5,
    importance REAL NOT NULL DEFAULT 0.5,
    scope TEXT NOT NULL,
    user_id TEXT,
    repository_id TEXT,
    conversation_id TEXT,
    branch_name TEXT,
    metadata TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_nodes_status ON memory_nodes(status);
  CREATE INDEX IF NOT EXISTS idx_memory_nodes_scope ON memory_nodes(scope);
  CREATE INDEX IF NOT EXISTS idx_memory_nodes_user ON memory_nodes(user_id);
  CREATE INDEX IF NOT EXISTS idx_memory_nodes_repo ON memory_nodes(repository_id);
  CREATE INDEX IF NOT EXISTS idx_memory_nodes_branch ON memory_nodes(branch_name);
  CREATE INDEX IF NOT EXISTS idx_memory_nodes_type ON memory_nodes(node_type);
  CREATE INDEX IF NOT EXISTS idx_memory_nodes_parent ON memory_nodes(parent_id);
`

/** MemoryNode FTS5 索引（trigram 分词，字面检索降级通道） */
export const MEMORY_NODES_FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
    title, summary, tags,
    content='memory_nodes', content_rowid='rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS memory_nodes_fts_ai AFTER INSERT ON memory_nodes BEGIN
    INSERT INTO memory_nodes_fts(rowid, title, summary, tags)
    VALUES (new.rowid, new.title, new.summary, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_nodes_fts_ad AFTER DELETE ON memory_nodes BEGIN
    INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, title, summary, tags)
    VALUES ('delete', old.rowid, old.title, old.summary, old.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_nodes_fts_au AFTER UPDATE ON memory_nodes BEGIN
    INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, title, summary, tags)
    VALUES ('delete', old.rowid, old.title, old.summary, old.tags);
    INSERT INTO memory_nodes_fts(rowid, title, summary, tags)
    VALUES (new.rowid, new.title, new.summary, new.tags);
  END;
`

/** Evidence 链接表 */
export const EVIDENCE_LINKS_DDL = `
  CREATE TABLE IF NOT EXISTS evidence_links (
    id TEXT PRIMARY KEY,
    memory_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL,
    source_id TEXT,
    source_ref TEXT,
    content TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_evidence_memory ON evidence_links(memory_node_id);
`

/** Knowledge 文档表 */
export const KNOWLEDGE_DOCUMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    source_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    repository_id TEXT,
    redacted INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_docs_repo ON knowledge_documents(repository_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_docs_hash ON knowledge_documents(content_hash);
  CREATE INDEX IF NOT EXISTS idx_knowledge_docs_path ON knowledge_documents(source_path);
`

/** Knowledge 分片表 */
export const KNOWLEDGE_CHUNKS_DDL = `
  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    token_count INTEGER,
    start_line INTEGER,
    end_line INTEGER,
    symbol_names TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(document_id);
`

/** Knowledge 段落表 */
export const KNOWLEDGE_PARAGRAPHS_DDL = `
  CREATE TABLE IF NOT EXISTS knowledge_paragraphs (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    heading_path TEXT,
    token_count INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_paras_doc ON knowledge_paragraphs(document_id);
`

/** Knowledge 原子事实表 */
export const KNOWLEDGE_PROPOSITIONS_DDL = `
  CREATE TABLE IF NOT EXISTS knowledge_propositions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    paragraph_id TEXT REFERENCES knowledge_paragraphs(id),
    content TEXT NOT NULL,
    proposition_type TEXT NOT NULL,
    source_pattern TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_props_doc ON knowledge_propositions(document_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_props_type ON knowledge_propositions(proposition_type);
`

/** Knowledge 模块摘要表 */
export const KNOWLEDGE_SUMMARIES_DDL = `
  CREATE TABLE IF NOT EXISTS knowledge_summaries (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    key_symbols TEXT,
    token_count INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_summ_doc ON knowledge_summaries(document_id);
`

/** Knowledge FTS5 索引（每个粒度层各一张） */
export const KNOWLEDGE_FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
    content, tokenize='trigram'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_paragraphs_fts USING fts5(
    content, tokenize='trigram'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_propositions_fts USING fts5(
    content, tokenize='trigram'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_summaries_fts USING fts5(
    content, tokenize='trigram'
  );
`

/** 增量索引 manifest 表 */
export const INDEX_MANIFEST_DDL = `
  CREATE TABLE IF NOT EXISTS index_manifest (
    source_path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    last_indexed_at TEXT NOT NULL
  );
`

/** 全部 DDL 汇总（按依赖顺序） */
export const ALL_DDL = [
  MEMORY_NODES_DDL,
  MEMORY_NODES_FTS_DDL,
  EVIDENCE_LINKS_DDL,
  KNOWLEDGE_DOCUMENTS_DDL,
  KNOWLEDGE_CHUNKS_DDL,
  KNOWLEDGE_PARAGRAPHS_DDL,
  KNOWLEDGE_PROPOSITIONS_DDL,
  KNOWLEDGE_SUMMARIES_DDL,
  KNOWLEDGE_FTS_DDL,
  INDEX_MANIFEST_DDL
]
