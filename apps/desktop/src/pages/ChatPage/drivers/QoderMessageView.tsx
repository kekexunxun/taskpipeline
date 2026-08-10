import { PartRenderer } from './PartRenderer'
import type { ChatMessage } from '@/api'

/**
 * Qoder 专属消息视图。
 *
 * 设计:
 *  - 全部走 `PartRenderer` 按 `DriverPart.type` 路由;Qoder 特有的 part
 *    (thinking / tool-use / tool-result / session) 在 `parts/*` 里有专门组件。
 *  - 不在此处叠加 metadata (status / taskCreation),那些由共享的 `ChatMessageView`
 *    统一加在外层。
 */
export function QoderMessageView({ message, isAnimating }: { message: ChatMessage; isAnimating?: boolean }) {
  return <PartRenderer parts={message.parts} isStreaming={isAnimating} />
}
