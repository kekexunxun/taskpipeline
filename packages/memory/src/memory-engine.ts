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

export class MemoryEngine {
  readonly memoryNodes: MemoryNodeStore
  readonly evidence: EvidenceStore
  readonly knowledge: KnowledgeStore
  private _retrieval: RetrievalPipeline | null = null

  constructor(private readonly db: Database.Database) {
    // 启用 WAL 模式 + 外键约束
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // 初始化所有表
    for (const ddl of ALL_DDL) {
      db.exec(ddl)
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
