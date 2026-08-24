/**
 * HITL 模式管理：全局默认 + 对话级缓存 + 任务级。
 *
 * - ask（默认）：所有写操作需确认
 * - auto：仅危险操作需确认
 * - yolo：全部自动放行
 */
import type { TaskStore } from '@task-pipeline/core'

export type HitlMode = 'ask' | 'auto' | 'yolo'

/** 全局默认 HITL 模式（新对话/任务的初始值） */
let globalHitlMode: HitlMode = 'ask'

/** 对话级 HITL 模式缓存（conversationId → hitlMode），避免异步读取存储 */
const conversationHitlModeCache = new Map<string, HitlMode>()

/** 从设置存储加载全局默认 HITL 模式（启动时调用一次） */
export function loadHitlModeFromStore(store: TaskStore): void {
  const stored = store.getSetting('hitlMode')
  if (stored === 'ask' || stored === 'auto' || stored === 'yolo') {
    globalHitlMode = stored
  }
}

/**
 * 获取指定上下文的 HITL 模式。
 * - conversation: 从缓存读取，未设置则回退 globalHitlMode
 * - task: 从 Task 读取 hitlMode，未设置则回退 globalHitlMode
 * - 无 context: 直接返回 globalHitlMode
 */
export function getHitlModeForContext(
  contextType?: 'conversation' | 'task',
  contextId?: string,
  store?: TaskStore
): HitlMode {
  if (!contextType || !contextId) return globalHitlMode
  if (contextType === 'conversation') {
    return conversationHitlModeCache.get(contextId) ?? globalHitlMode
  }
  if (contextType === 'task' && store) {
    const task = store.getTask(contextId)
    return task?.hitlMode ?? globalHitlMode
  }
  return globalHitlMode
}

export function setGlobalHitlMode(mode: HitlMode): void {
  globalHitlMode = mode
}

export function getGlobalHitlMode(): HitlMode {
  return globalHitlMode
}

export function setConversationHitlMode(conversationId: string, mode: HitlMode): void {
  conversationHitlModeCache.set(conversationId, mode)
}

export function getConversationHitlModeCache(): Map<string, HitlMode> {
  return conversationHitlModeCache
}
