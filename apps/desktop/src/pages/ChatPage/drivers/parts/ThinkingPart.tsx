import { BrainIcon, ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { DriverPart } from '@/api'

/**
 * 折叠式 thinking / reasoning part。
 *  - Qoder: `type === "qoder.thinking"` (text + 可选 signature)
 *  - OpenAI 兼容: `type === "openai.thinking"` (text)
 *
 * 设计:流式时默认展开(让用户看到推理过程),流结束后默认收起(只保留"思考过程"
 * 摘要);用户可以随时手动展开/收起,且一旦用户主动点过,后续以用户选择为准 —
 * 避免流式持续重渲染时把用户手动改过的状态"刷"回默认。
 *
 * Label 区分"思考中…" vs "思考过程":流式期间文案暗示仍在思考、配合脑图标
 * 给用户实时反馈;流结束后文案改为"思考过程"以表明推理已完成,避免误判为挂起。
 */
export function ThinkingPart({
  part,
  isStreaming
}: {
  part: Extract<DriverPart, { type: 'qoder.thinking' | 'openai.thinking' }>
  isStreaming?: boolean
}) {
  // 用户的点击一旦发生(非 null)就以用户选择为准,不再被 isStreaming 覆盖。
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? Boolean(isStreaming)
  const label = isStreaming ? '思考中…' : '思考过程'
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setUserOpen(next)}
      className={cn('not-prose my-2 w-full rounded-md border bg-muted/30 text-foreground', 'border-border/60')}
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 text-xs">
          <BrainIcon size={12} className="text-muted-foreground" />
          <span className="font-medium">{label}</span>
        </span>
        <ChevronDownIcon size={12} className={cn('transition-transform', open ? 'rotate-180' : 'rotate-0')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border/40 px-4 py-3 text-foreground/80">
        <pre className="m-0 font-sans text-xs leading-6 break-words whitespace-pre-wrap">{part.text}</pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
