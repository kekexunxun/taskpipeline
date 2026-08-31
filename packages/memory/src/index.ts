/**
 * @task-pipeline/memory — Memory Engine
 *
 * 参考 Agent Memory Engine (AME) 设计，TypeScript 原生实现。
 * 直接嵌入 Electron 主进程，零外部依赖。
 */

// 核心引擎
export { MemoryEngine } from './memory-engine.js'

// 存储层
export { MemoryNodeStore } from './memory-node-store.js'
export { EvidenceStore } from './evidence-store.js'
export { KnowledgeStore } from './knowledge-store.js'

// 知识摄入
export { splitMarkdown, estimateTokens } from './knowledge/markdown-chunker.js'
export { splitCode } from './knowledge/code-chunker.js'
export {
  extractPropositions,
  extractPropositionsFromCode,
  extractPropositionsFromMarkdown
} from './knowledge/proposition-extractor.js'
export type { MarkdownChunk } from './knowledge/markdown-chunker.js'
export type { CodeChunk } from './knowledge/code-chunker.js'
export type { ExtractedProposition } from './knowledge/proposition-extractor.js'

// 检索流水线
export { RetrievalPipeline, tokenize } from './retrieval-pipeline.js'
export { reciprocalRankFusion } from './retrieval/rrf.js'
export { getGranularityLayers, getPrimaryLayer } from './retrieval/granularity-router.js'
export { buildContextPack } from './retrieval/context-pack.js'
export type { RetrievalInput } from './retrieval-pipeline.js'
export type { RrfInput } from './retrieval/rrf.js'
export type { BuildContextPackInput } from './retrieval/context-pack.js'

// 反思流水线
export { ReflectionPipeline } from './reflection-pipeline.js'
export { checkGate, countCandidates, DEFAULT_GATE_CONFIG } from './reflection/gate-check.js'
export {
  computeTitleSimilarity,
  findBestMatch,
  decideAction,
  executePromotion
} from './reflection/promotion-strategies.js'
export type {
  CandidateGenerator,
  CandidateGenerationInput,
  ReflectionInput,
  ReflectionOutput
} from './reflection-pipeline.js'
export type { GateCheckInput, GateConfig } from './reflection/gate-check.js'
export type { MatchResult } from './reflection/promotion-strategies.js'

// 生命周期管理
export { RetentionService, DEFAULT_RETENTION_CONFIG } from './lifecycle/retention-service.js'
export type { RetentionConfig, RetentionResult } from './lifecycle/retention-service.js'

// 迁移桥接
export { migrateMemories, migrateWikiDocs } from './bridge/legacy-bridge.js'
export type { LegacyMemory, LegacyWikiDoc, MigrationResult } from './bridge/legacy-bridge.js'

// Schema（供高级用法 / 迁移脚本）
export { ALL_DDL } from './schema.js'

// 类型
export type {
  // MemoryNode
  MemoryNode,
  MemoryNodeType,
  MemoryNodeStatus,
  CreateMemoryNodeInput,
  UpdateMemoryNodeInput,
  MemoryScope,

  // Evidence
  EvidenceLink,
  EvidenceType,
  CreateEvidenceLinkInput,

  // Knowledge
  KnowledgeDocument,
  KnowledgeSourceType,
  KnowledgeChunk,
  KnowledgeParagraph,
  KnowledgeProposition,
  KnowledgeSummary,
  PropositionType,
  SourcePattern,

  // Retrieval
  TaskIntent,
  GranularityLayer,
  RetrievalHit,
  ContextPack,
  RetrievalTraceEntry,

  // Reflection
  PromotionAction,
  MemoryCandidate,
  GateCheckResult,
  PromotionResult
} from './types.js'

// 常量
export { PROTECTED_NODE_TYPES, ACTIVE_STATUSES, PENALIZED_STATUSES } from './types.js'
