/**
 * ReflectionPipeline：按需 LLM 的反思流水线。
 *
 * 流程：
 * 1. 门控检查（确定性）→ 不通过则跳过
 * 2. 调用 LLM 生成 MemoryCandidate（可选，外部注入）
 * 3. 匹配现有节点（确定性：标题相似度）
 * 4. 决定晋升策略（确定性）
 * 5. 执行晋升（确定性）
 *
 * LLM 解耦设计：
 * - CandidateGenerator 接口由外部实现（Electron 主进程的 LLM 服务）
 * - Pipeline 本身不依赖任何 LLM SDK
 * - 如果不需要 LLM（如从 proposition 直接生成 candidate），可跳过 LLM 步骤
 */
import type { MemoryNodeStore } from './memory-node-store.js'
import type { EvidenceStore } from './evidence-store.js'
import type { MemoryCandidate, PromotionResult } from './types.js'
import { checkGate, countCandidates, type GateConfig, DEFAULT_GATE_CONFIG } from './reflection/gate-check.js'
import { findBestMatch, decideAction, executePromotion } from './reflection/promotion-strategies.js'

/**
 * LLM 候选生成器接口（由外部实现）。
 *
 * 输入：新证据 / proposition / 对话片段
 * 输出：MemoryCandidate 数组
 */
export interface CandidateGenerator {
  generate(input: CandidateGenerationInput): Promise<MemoryCandidate[]>
}

export interface CandidateGenerationInput {
  /** 触发反思的证据内容 */
  evidence: Array<{ type: string; content: string; sourceId?: string }>
  /** 当前仓库 ID */
  repositoryId?: string
  /** 当前分支 */
  branchName?: string
}

export interface ReflectionInput {
  /** 待处理的候选记忆（如果已有，可跳过 LLM 生成） */
  candidates?: MemoryCandidate[]
  /** 触发反思的证据（用于 LLM 生成候选） */
  evidence?: Array<{ type: string; content: string; sourceId?: string }>
  /** 仓库 ID */
  repositoryId?: string
  /** 分支名 */
  branchName?: string
  /** 作用域 */
  scope?: 'user' | 'repo' | 'conversation'
  /** 距上次 reflection 的毫秒数 */
  msSinceLastReflection: number
  /** 新证据数量 */
  newEvidenceCount: number
  /** 自定义门控配置 */
  gateConfig?: Partial<GateConfig>
}

export interface ReflectionOutput {
  /** 门控是否通过 */
  gatePassed: boolean
  /** 门控详情 */
  gateReasons: string[]
  /** 处理的候选数 */
  candidateCount: number
  /** 每个候选的晋升结果 */
  results: PromotionResult[]
}

export class ReflectionPipeline {
  constructor(
    private readonly memoryStore: MemoryNodeStore,
    private readonly evidenceStore: EvidenceStore,
    /** 可选：LLM 候选生成器 */
    private readonly candidateGenerator?: CandidateGenerator
  ) {}

  /**
   * 执行反思流水线。
   */
  async reflect(input: ReflectionInput): Promise<ReflectionOutput> {
    const gateConfig = { ...DEFAULT_GATE_CONFIG, ...input.gateConfig }

    // ── 1. 门控检查 ──────────────────────────────────────────────────────
    const candidateCount = countCandidates(this.memoryStore, input.repositoryId)
    const gateResult = checkGate(
      {
        pendingCandidateCount: candidateCount + (input.candidates?.length ?? 0),
        newEvidenceCount: input.newEvidenceCount,
        msSinceLastReflection: input.msSinceLastReflection
      },
      gateConfig
    )

    if (!gateResult.passed) {
      return {
        gatePassed: false,
        gateReasons: gateResult.skipReasons,
        candidateCount: 0,
        results: []
      }
    }

    // ── 2. 获取候选 ──────────────────────────────────────────────────────
    let candidates = input.candidates ?? []

    if (candidates.length === 0 && input.evidence && input.evidence.length > 0 && this.candidateGenerator) {
      candidates = await this.candidateGenerator.generate({
        evidence: input.evidence,
        repositoryId: input.repositoryId,
        branchName: input.branchName
      })
    }

    if (candidates.length === 0) {
      return {
        gatePassed: true,
        gateReasons: gateResult.reasons,
        candidateCount: 0,
        results: []
      }
    }

    // ── 3-5. 对每个候选：匹配 → 决策 → 执行 ─────────────────────────────
    const scope = input.scope ?? 'repo'
    const results: PromotionResult[] = []

    for (const candidate of candidates) {
      const match = findBestMatch(this.memoryStore, candidate, input.repositoryId)
      const action = decideAction(candidate, match)
      const result = executePromotion(
        action,
        candidate,
        match,
        this.memoryStore,
        this.evidenceStore,
        scope,
        input.repositoryId
      )
      results.push(result)
    }

    return {
      gatePassed: true,
      gateReasons: gateResult.reasons,
      candidateCount: candidates.length,
      results
    }
  }
}
