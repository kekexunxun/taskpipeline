/**
 * HITL 档位管理：全局默认 + 对话级缓存。
 *
 * **三档只对对话路径成立**（`chat/chat-init.ts` 的 `canUseTool` 会区分 `isWriteTool` / `isBuiltinWriteTool`）：
 * - ask（默认）：所有写操作需确认
 * - auto：仅危险操作需确认
 * - yolo：全部自动放行
 *
 * 任务执行路径不再读档位：它固定走 `@task-pipeline/core` 的 `evaluateExecutionPermission`
 * （L1 硬阻断 + 其余放行，命中直接 deny 不弹框），因此 `contextType === 'task'` 恒返回 `'yolo'`。
 * `Task.hitlMode` 字段已删（`tasks.hitl_mode` 列保留但停止读写），也没有任何地方再写任务级档位。
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
 * 获取指定上下文的 HITL 档位。
 * - conversation: 从缓存读取，未设置则回退 globalHitlMode
 * - task: **恒返回 'yolo'** —— 执行期边界由 L1 判定单独承担，不再分档
 * - 无 context: 直接返回 globalHitlMode
 */
export function getHitlModeForContext(contextType?: 'conversation' | 'task', contextId?: string): HitlMode {
  if (contextType === 'task') return 'yolo'
  if (!contextType || !contextId) return globalHitlMode
  if (contextType === 'conversation') {
    return conversationHitlModeCache.get(contextId) ?? globalHitlMode
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
