/**
 * Memory Engine 类型定义。
 *
 * 参考 Agent Memory Engine (AME) 的 MemoryNode 树模型设计，
 * 结合项目现有的 scope（user/repo/conversation）体系。
 */

// ── MemoryNode ──────────────────────────────────────────────────────────────

/** MemoryNode 类型：对应 AME 的 constraint / architecture / decision / incident / procedure / module */
export type MemoryNodeType =
  | 'constraint'
  | 'architecture'
  | 'decision'
  | 'incident'
  | 'procedure'
  | 'module'
  | 'security_rule'

/** MemoryNode 状态机：参考 AME 的完整生命周期 */
export type MemoryNodeStatus =
  | 'candidate' // 暂存，待晋升决策
  | 'active' // 活跃，参与检索
  | 'stale' // 过时，检索时降权
  | 'superseded' // 已被新节点替代，不参与检索
  | 'archived' // 归档，仅审计用途
  | 'compacted' // 多条记忆压缩合成
  | 'expired' // candidate 超期未晋升

/** 作用域（与现有系统保持一致） */
export type MemoryScope = 'user' | 'repo' | 'conversation'

/** MemoryNode：记忆树节点 */
export interface MemoryNode {
  id: string
  parentId: string | null
  nodeType: MemoryNodeType
  title: string
  summary: string | null
  status: MemoryNodeStatus
  confidence: number
  importance: number

  // 作用域
  scope: MemoryScope
  userId: string | null
  repositoryId: string | null
  conversationId: string | null
  branchName: string | null

  // 元数据
  metadata: Record<string, unknown> | null
  tags: string[]
  source: 'manual' | 'auto' | 'seed'

  createdAt: string
  updatedAt: string
}

/** 创建 MemoryNode 的输入（不含 id / 时间戳 / 默认值） */
export type CreateMemoryNodeInput = {
  parentId?: string | null
  nodeType: MemoryNodeType
  title: string
  summary?: string | null
  status?: MemoryNodeStatus
  confidence?: number
  importance?: number
  scope: MemoryScope
  userId?: string | null
  repositoryId?: string | null
  conversationId?: string | null
  branchName?: string | null
  metadata?: Record<string, unknown> | null
  tags?: string[]
  source?: 'manual' | 'auto' | 'seed'
}

/** 更新 MemoryNode 的输入（所有字段可选） */
export type UpdateMemoryNodeInput = Partial<Omit<CreateMemoryNodeInput, 'scope'>> & {
  status?: MemoryNodeStatus
}

// ── Evidence ────────────────────────────────────────────────────────────────

/** 证据类型 */
export type EvidenceType = 'conversation' | 'task' | 'code_ref' | 'test_output' | 'review_note' | 'git_diff'

/** 证据链接：关联 MemoryNode 到原始来源 */
export interface EvidenceLink {
  id: string
  memoryNodeId: string
  evidenceType: EvidenceType
  sourceId: string | null // conversationId / taskId / filePath
  sourceRef: string | null // 行号、commit hash 等
  content: string | null // 证据摘要
  createdAt: string
}

/** 创建 EvidenceLink 的输入 */
export type CreateEvidenceLinkInput = {
  memoryNodeId: string
  evidenceType: EvidenceType
  sourceId?: string | null
  sourceRef?: string | null
  content?: string | null
}

// ── Knowledge ───────────────────────────────────────────────────────────────

/** 知识源类型 */
export type KnowledgeSourceType = 'markdown' | 'code' | 'adr' | 'test_report' | 'log' | 'diff'

/** 知识文档 */
export interface KnowledgeDocument {
  id: string
  sourcePath: string
  sourceType: KnowledgeSourceType
  contentHash: string
  title: string | null
  content: string
  repositoryId: string | null
  redacted: boolean
  createdAt: string
  updatedAt: string
}

/** 知识分片 */
export interface KnowledgeChunk {
  id: string
  documentId: string
  content: string
  tokenCount: number | null
  startLine: number | null
  endLine: number | null
  symbolNames: string[] | null
}

/** 知识段落 */
export interface KnowledgeParagraph {
  id: string
  documentId: string
  content: string
  headingPath: string | null
  tokenCount: number | null
}

/** 原子事实（确定性提取，无 LLM） */
export type PropositionType = 'fact' | 'constraint' | 'security_rule' | 'risk' | 'decision'
export type SourcePattern =
  | 'docstring'
  | 'raise_statement'
  | 'security_comment'
  | 'markdown_bullet'
  | 'assert_statement'
  | 'todo_fixme'

export interface KnowledgeProposition {
  id: string
  documentId: string
  paragraphId: string | null
  content: string
  propositionType: PropositionType
  sourcePattern: SourcePattern
}

/** 模块摘要 */
export interface KnowledgeSummary {
  id: string
  documentId: string
  content: string
  keySymbols: string[] | null
  tokenCount: number | null
}

// ── Retrieval ───────────────────────────────────────────────────────────────

/** 检索意图（用于粒度路由） */
export type TaskIntent = 'bug_fix' | 'architecture_review' | 'feature_implementation' | 'general'

/** 检索粒度层 */
export type GranularityLayer = 'proposition' | 'paragraph' | 'chunk' | 'summary'

/** 单条检索结果 */
export interface RetrievalHit {
  layer: GranularityLayer
  content: string
  score: number
  sourcePath: string | null
  documentId: string | null
  nodeId: string | null
  nodeType: MemoryNodeType | null
  nodeTitle: string | null
  metadata: Record<string, unknown> | null
}

/** ContextPack：检索结果经 token 预算裁剪后的最终输出 */
export interface ContextPack {
  memories: RetrievalHit[]
  knowledge: RetrievalHit[]
  totalTokens: number
  retrievalTrace: RetrievalTraceEntry[]
}

/** 检索追踪（调试用） */
export interface RetrievalTraceEntry {
  layer: GranularityLayer
  signal: 'semantic' | 'lexical' | 'rrf_fusion'
  hitCount: number
  topScore: number
  latencyMs: number
}

// ── Reflection ──────────────────────────────────────────────────────────────

/** 晋升策略 */
export type PromotionAction = 'create' | 'update' | 'merge' | 'supersede' | 'discard' | 'needs_review'

/** MemoryCandidate：ReflectionSkill 生成的候选记忆 */
export interface MemoryCandidate {
  nodeType: MemoryNodeType
  title: string
  summary: string
  importance: number
  confidence: number
  tags: string[]
  evidence: CreateEvidenceLinkInput[]
}

/** 门控检查结果 */
export interface GateCheckResult {
  passed: boolean
  skipReason?: string
}

/** 晋升结果 */
export interface PromotionResult {
  action: PromotionAction
  nodeId: string | null
  mergedWithId: string | null
  notes: string
}

// ── 受保护类型 ──────────────────────────────────────────────────────────────

/** 受保护的 MemoryNode 类型：永不自动归档或压缩 */
export const PROTECTED_NODE_TYPES: readonly MemoryNodeType[] = [
  'constraint',
  'security_rule',
  'architecture',
  'decision'
] as const

/** 参与检索的活跃状态 */
export const ACTIVE_STATUSES: readonly MemoryNodeStatus[] = ['active', 'compacted'] as const

/** 降权但仍可检索的状态 */
export const PENALIZED_STATUSES: readonly MemoryNodeStatus[] = ['stale'] as const
