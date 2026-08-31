/**
 * 粒度路由器：根据 TaskIntent 决定检索的粒度层优先级。
 *
 * 设计参考 AME 的 intent-aware retrieval：
 * - bug_fix → proposition（精确约束）→ paragraph（上下文）
 * - architecture_review → summary（全局视图）→ paragraph（细节）
 * - feature_implementation → chunk（代码块）→ proposition（约束）
 * - general → paragraph → chunk（均衡）
 */
import type { GranularityLayer, TaskIntent } from '../types.js'

/** 每种 intent 对应的粒度层优先级（第一个为首选） */
const INTENT_LAYER_MAP: Record<TaskIntent, GranularityLayer[]> = {
  bug_fix: ['proposition', 'paragraph'],
  architecture_review: ['summary', 'paragraph'],
  feature_implementation: ['chunk', 'proposition'],
  general: ['paragraph', 'chunk']
}

/**
 * 根据任务意图获取检索粒度层（按优先级排序）。
 */
export function getGranularityLayers(intent: TaskIntent): GranularityLayer[] {
  return INTENT_LAYER_MAP[intent] ?? INTENT_LAYER_MAP.general
}

/**
 * 获取首选粒度层。
 */
export function getPrimaryLayer(intent: TaskIntent): GranularityLayer {
  return getGranularityLayers(intent)[0]!
}
