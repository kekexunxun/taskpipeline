import { DiamondIcon, Loader2Icon, UserRoundIcon } from 'lucide-react'
import { useMemo } from 'react'
import type { ChatApprovalRequest } from '../hooks/useChat'
import { ChatMessageView, MESSAGE_WIDTH_CLASS } from './ChatMessage'
// TODO: 进度条效果待优化，暂时隐藏
// import { ChatProgressIndicator } from './ChatProgressIndicator'
import { ToolApprovalCard, AskUserQuestionCard } from '@/components/ToolApprovalCard'
import type { AnsweredApproval } from '@/components/ToolApprovalCard'
import type { ChatMessage, ChatPlan } from '@/api'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'

export function ChatConversation({
  messages,
  streaming,
  hint,
  approvals,
  answered,
  onRespondApproval,
  onExecuteJira,
  onExecutePlan
}: {
  messages: ChatMessage[]
  streaming?: boolean
  /** 阶段提示（关键词提取/记忆检索中…），仅展示在最后一条在飞消息上。 */
  hint?: string
  /** 该对话待确认的 HITL 请求（内联卡片，渲染在消息流底部）。 */
  approvals?: ChatApprovalRequest[]
  /** 该对话已回答的 AskUserQuestion（保留展示已选结果）。 */
  answered?: AnsweredApproval[]
  onRespondApproval?(id: string, response: { confirmed: boolean } | { value: string | string[] }): void
  onExecuteJira?(taskKey: string): Promise<void>
  /** 执行计划回调：切换 chatMode 为 normal 并发送执行指令。 */
  onExecutePlan?(plan: ChatPlan): void
}) {
  const lastIndex = messages.length - 1

  // 计算轮次：每条 user 消息开启一轮，后续 assistant 消息属于同一轮
  const turnMap = useMemo(() => {
    const map = new Map<string, number>()
    let turn = -1
    for (const msg of messages) {
      if (msg.role === 'user') turn++
      map.set(msg.id, Math.max(0, turn))
    }
    return map
  }, [messages])

  const _turnCount = useMemo(() => {
    if (turnMap.size === 0) return 0
    let max = 0
    for (const v of turnMap.values()) if (v > max) max = v
    return max + 1
  }, [turnMap])

  // 每轮的用户消息文本（用于右侧进度条卡片展示）
  const _turnUserMessages = useMemo(() => {
    const map = new Map<number, string>()
    for (const msg of messages) {
      if (msg.role === 'user') {
        const turn = turnMap.get(msg.id)
        if (turn != null && !map.has(turn)) {
          map.set(
            turn,
            msg.parts
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join(' ')
          )
        }
      }
    }
    return map
  }, [messages, turnMap])

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
            onExecutePlan={onExecutePlan}
            turnIndex={turnMap.get(message.id)}
          />
        ))}
        {approvals?.map((approval) =>
          approval.method === 'ask-user' ? (
            <AskUserQuestionCard
              key={approval.id}
              approval={approval}
              widthClass={MESSAGE_WIDTH_CLASS}
              onRespond={(value) => onRespondApproval?.(approval.id, { value })}
            />
          ) : (
            <ToolApprovalCard
              key={approval.id}
              approval={approval}
              widthClass={MESSAGE_WIDTH_CLASS}
              onRespond={(confirmed) => onRespondApproval?.(approval.id, { confirmed })}
            />
          )
        )}
        {answered?.map((item) => (
          <AskUserQuestionCard
            key={`answered-${item.id}`}
            approval={item.approval}
            selections={item.selections}
            widthClass={MESSAGE_WIDTH_CLASS}
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
            <DiamondIcon className="size-3.5 shrink-0 animate-spin" />
            <span>正在处理...</span>
          </div>
        )}
      </ConversationContent>
      {/* TODO: 进度条效果待优化，暂时隐藏 */}
      {/* <ChatProgressIndicator turnCount={turnCount} turnUserMessages={turnUserMessages} /> */}
      <ConversationScrollButton />
    </Conversation>
  )
}
