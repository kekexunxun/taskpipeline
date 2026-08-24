import { PartRenderer } from './PartRenderer'
import type { ChatMessage, ChatPlan } from '@/api'

/**
 * Qoder 专属消息视图。
 *
 * 设计:
 *  - 全部走 `PartRenderer` 按 `DriverPart.type` 路由;Qoder 特有的 part
 *    (thinking / tool-use / tool-result / session) 在 `parts/*` 里有专门组件。
 *  - 不在此处叠加 metadata (status / taskCreation),那些由共享的 `ChatMessageView`
 *    统一加在外层。
 */
export function QoderMessageView({
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
