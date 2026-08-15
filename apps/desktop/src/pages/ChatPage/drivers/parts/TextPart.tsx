import { MessageResponse } from '@/components/ai-elements/message'
import { cn } from '@/lib/utils'
import type { DriverPart } from '@/api'

/**
 * 渲染 driver 推上来的 text part(流式 markdown)。
 *
 * 设计:即使 part 的 driverId 是 "qoder" / "openai",只要 type === "text" 都可以走
 * `MessageResponse` (Streamdown) 流式 markdown。这样 Qoder 助手文本和 OpenAI 助手
 * 文本用同一份渲染器,UI 一致。
 */
export function TextPart({
  part,
  isAnimating
}: {
  part: Extract<DriverPart, { type: 'text' }>
  isAnimating?: boolean
}) {
  // 整个对话区统一使用 text-xs (12px) — 与思考/工具区字号对齐,长文本更易扫读。
  return (
    <div className={cn(isAnimating && 'animate-pulse', 'w-full text-xs leading-relaxed')}>
      <MessageResponse>{part.text}</MessageResponse>
    </div>
  )
}
