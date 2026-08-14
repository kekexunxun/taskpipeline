import { Loader2Icon, UserRoundIcon } from 'lucide-react'
import type { ChatApprovalRequest } from '../hooks/useChat'
import { ChatMessageView, MESSAGE_WIDTH_CLASS } from './ChatMessage'
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
    <Conversation className="min-h-0 flex-1 overflow-hidden">
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
            widthClass={MESSAGE_WIDTH_CLASS}
            onRespond={(confirmed) => onRespondApproval?.(approval.id, confirmed)}
          />
        ))}
        {streaming && approvals && approvals.length > 0 && (
          <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
            <UserRoundIcon className="size-3.5 shrink-0" />
            <span>等待用户输入...</span>
          </div>
        )}
        {streaming && (!approvals || approvals.length === 0) && (
          <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
            <span>正在处理...</span>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}
