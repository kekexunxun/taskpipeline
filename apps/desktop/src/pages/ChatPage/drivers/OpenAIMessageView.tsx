import { PartRenderer } from './PartRenderer'
import type { ChatMessage, ChatPlan } from '@/api'

/**
 * OpenAI 专属消息视图。
 *
 * 设计:
 *  - 走 `PartRenderer` 同样的路由,但 OpenAI 主要产出 `text` (markdown) +
 *    偶发 `openai.tool-call` / `openai.tool-result` (任务创建后端场景)。
 *  - 没有 thinking / session 之类的 Qoder 专属 part,所以视觉上比 Qoder 简洁。
 */
export function OpenAIMessageView({
  message,
  isAnimating,
  onExecutePlan,
  followingUserTexts
}: {
  message: ChatMessage
  isAnimating?: boolean
  onExecutePlan?: (plan: ChatPlan) => void
  /** 本消息之后的用户消息文本：供 pending 计划失效判定。 */
  followingUserTexts?: string[]
}) {
  const isPlanMode = message.metadata?.isPlanMode === true
  return (
    <PartRenderer
      parts={message.parts}
      isStreaming={isAnimating}
      isPlanMode={isPlanMode}
      messageStatus={message.metadata?.status}
      followingUserTexts={followingUserTexts}
      planWaiting={message.metadata?.planWaiting === true}
      onExecutePlan={onExecutePlan}
    />
  )
}
