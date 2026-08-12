/**
 * 阶段显示名映射（渲染层共用）—— agent.run 阶段容器按 meta.phase / trigger / round
 * 映射为阶段链语义名，Waterfall 类型标签与执行 Tab 阶段卡共用同一份规则。
 *
 * 阶段模型：阶段实例是按时间追加的序列（首跑：关键词提取→Plan→Exec→CodeReview→TestCase→Finish；
 * 恢复/续接在末尾追加新的 Exec/Plan 实例），同 phase 多实例各自成卡。
 */

import type { AgentSpan } from './types.js'

/**
 * agent.run span 的阶段显示名：
 * - keyword → 关键词提取并注入；planning → Plan；review → CodeReview；
 *   test_generation → TestCase；finish → Finish；memory → 记忆整理；chat → 对话生成；
 * - implementation → Exec；meta.round ≥ 1 → ReExec #n（auto-fix 重跑）；
 *   meta.trigger = resume → 执行（续接）；followup → 执行（追加指令）。
 * 非 agent.run 或无 phase 时返回 undefined（调用方回退通用标签）。
 */
export function agentStageLabel(span: Pick<AgentSpan, 'type' | 'meta'>): string | undefined {
  if (span.type !== 'agent.run') return undefined
  const meta = (span.meta ?? {}) as Record<string, unknown>
  const phase = typeof meta.phase === 'string' ? meta.phase : undefined
  if (!phase) return undefined
  const round = typeof meta.round === 'number' ? meta.round : 0
  const trigger = typeof meta.trigger === 'string' ? meta.trigger : undefined
  switch (phase) {
    case 'keyword':
      return '关键词提取并注入'
    case 'chat':
      return '对话生成'
    case 'planning':
      return 'Plan'
    case 'implementation':
      if (trigger === 'resume') return '执行（续接）'
      if (trigger === 'followup') return '执行（追加指令）'
      return round >= 1 ? `ReExec #${round}` : 'Exec'
    case 'review':
      return 'CodeReview'
    case 'test_generation':
      return 'TestCase'
    case 'finish':
      return 'Finish'
    case 'memory':
      return '记忆整理'
    default:
      return phase
  }
}
