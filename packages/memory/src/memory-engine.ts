/**
 * MemoryEngine 入口类。
 *
 * 职责：
 * 1. 初始化所有 SQLite 表（幂等 DDL）
 * 2. 暴露各存储层实例（MemoryNodeStore / EvidenceStore / KnowledgeStore）
 * 3. 提供检索流水线快捷入口
 * 4. 提供反思流水线创建入口
 * 5. 提供生命周期管理入口
 * 6. 提供统一的 dispose 方法
 */
import type Database from 'better-sqlite3'
import { ALL_DDL } from './schema.js'
import { MemoryNodeStore } from './memory-node-store.js'
import { EvidenceStore } from './evidence-store.js'
import { KnowledgeStore } from './knowledge-store.js'
import { RetrievalPipeline } from './retrieval-pipeline.js'
import type { RetrievalInput } from './retrieval-pipeline.js'
import { ReflectionPipeline, type CandidateGenerator } from './reflection-pipeline.js'
import { RetentionService, type RetentionConfig } from './lifecycle/retention-service.js'
import type { ContextPack } from './types.js'

/** Knowledge 粒度层的 FTS 表（迁移/重建时需要逐个处理） */
const KNOWLEDGE_FTS_TABLES = [
  'knowledge_chunks_fts',
  'knowledge_paragraphs_fts',
  'knowledge_propositions_fts',
  'knowledge_summaries_fts'
] as const

/**
 * Knowledge FTS 表一次性迁移：旧版是独立 FTS（无 content= 关联），rowid 与粒度表
 * 分别自增、删除重建后会错配。检测到旧版定义时直接 DROP，由幂等 DDL 重建为
 * external content 表 + 触发器，再对存量数据执行 rebuild。
 *
 * 返回本次新建（或迁移重建）的 FTS 表名，调用方需要对这些表做 rebuild 回填存量行。
 */
function migrateKnowledgeFts(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name, COALESCE(sql, '') AS sql FROM sqlite_master WHERE type = 'table' AND name IN (${KNOWLEDGE_FTS_TABLES.map(() => '?').join(',')})`
    )
    .all(...KNOWLEDGE_FTS_TABLES) as Array<{ name: string; sql: string }>
  const known = new Set(rows.map((row) => row.name))
  const legacy = rows.filter((row) => !/content\s*=/.test(row.sql))
  for (const table of legacy) {
    db.exec(`DROP TABLE IF EXISTS ${table.name}`)
  }
  // 本次不存在（全新或刚被 DROP）的表，DDL 后都需要 rebuild 回填存量粒度数据
  const created: string[] = legacy.map((row) => row.name)
  for (const table of KNOWLEDGE_FTS_TABLES) {
    if (!known.has(table)) created.push(table)
  }
  return created
}

export class MemoryEngine {
  readonly memoryNodes: MemoryNodeStore
  readonly evidence: EvidenceStore
  readonly knowledge: KnowledgeStore
  private _retrieval: RetrievalPipeline | null = null

  constructor(private readonly db: Database.Database) {
    // 启用 WAL 模式 + 外键约束
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // Knowledge FTS 旧版独立表迁移（需在幂等 DDL 前执行）
    const rebuilt = migrateKnowledgeFts(db)

    // 初始化所有表
    for (const ddl of ALL_DDL) {
      db.exec(ddl)
    }

    // 新建/重建的 external content FTS 表回填存量数据（触发器只管未来变更）
    for (const table of rebuilt) {
      db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`)
    }

    this.memoryNodes = new MemoryNodeStore(db)
    this.evidence = new EvidenceStore(db)
    this.knowledge = new KnowledgeStore(db)
  }

  /** 获取检索流水线实例（懒初始化） */
  get retrieval(): RetrievalPipeline {
    if (!this._retrieval) {
      this._retrieval = new RetrievalPipeline(this.memoryNodes, this.knowledge)
    }
    return this._retrieval
  }

  /** 快捷检索方法 */
  retrieve(input: RetrievalInput): ContextPack {
    return this.retrieval.execute(input)
  }

  /** 创建反思流水线（可选注入 LLM CandidateGenerator） */
  createReflection(generator?: CandidateGenerator): ReflectionPipeline {
    return new ReflectionPipeline(this.memoryNodes, this.evidence, generator)
  }

  /** 创建生命周期管理服务 */
  createRetention(config?: Partial<RetentionConfig>): RetentionService {
    return new RetentionService(this.memoryNodes, config)
  }

  /** 释放资源（关闭数据库由调用方负责，MemoryEngine 不持有 db 生命周期） */
  dispose(): void {
    this._retrieval = null
  }
}
