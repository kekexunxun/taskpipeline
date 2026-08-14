import type { ChatApprovalRequest } from '../hooks/useChat'
import { ChatMessageView } from './ChatMessage'
import { ToolApprovalCard } from '@/components/ToolApprovalCard'
import type { ChatMessage } from '@/api'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'

export function ChatConversation({
  messages,
  streaming,
  hint,
  approvals,
  onRespondApproval,
  onExecuteJira
}: {
  messages: ChatMessage[]
  streaming?: boolean
  /** 阶段提示（关键词提取/记忆检索中…），仅展示在最后一条在飞消息上。 */
  hint?: string
  /** 该对话待确认的 HITL 请求（内联卡片，渲染在消息流底部）。 */
  approvals?: ChatApprovalRequest[]
  onRespondApproval?(id: string, confirmed: boolean): void
  onExecuteJira?(taskKey: string): Promise<void>
}) {
  const lastIndex = messages.length - 1
  return (
    <Conversation className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
      <ConversationContent className="mx-auto w-full max-w-3xl gap-5 px-5 py-5">
        {messages.map((message, index) => (
          <ChatMessageView
            key={message.id}
            message={message}
            isAnimating={streaming && !message.metadata?.status && index === lastIndex}
            hint={index === lastIndex ? hint : undefined}
            onExecuteJira={onExecuteJira}
          />
        ))}
        {approvals?.map((approval) => (
          <ToolApprovalCard
            key={approval.id}
            approval={approval}
            onRespond={(confirmed) => onRespondApproval?.(approval.id, confirmed)}
          />
        ))}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}
