import { MapIcon, MessageSquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ChatConversationMode } from '@/api'

/**
 * 「计划模式」开关。
 *
 * plan 模式下 Agent 只做只读分析和计划输出，不执行修改操作。
 * 与任务创建模式互斥：切换到 plan 时自动关闭 taskCreation。
 */
export function ChatModeToggle({
  mode,
  disabled,
  onChange
}: {
  mode: ChatConversationMode
  disabled?: boolean
  onChange(mode: ChatConversationMode): void
}) {
  const isPlanMode = mode === 'plan'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="计划模式"
          aria-pressed={isPlanMode}
          disabled={disabled}
          className={cn(
            'h-6 gap-1 px-1.5 font-normal text-muted-foreground hover:text-foreground',
            isPlanMode && 'bg-primary/12 text-primary hover:bg-primary/16 hover:text-primary'
          )}
          onClick={() => onChange(isPlanMode ? 'normal' : 'plan')}
        >
          {isPlanMode ? <MapIcon size={11} /> : <MessageSquareIcon size={11} />}
          <span>{isPlanMode ? '计划模式' : '普通模式'}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {isPlanMode ? '已开启计划模式，Agent 将只做分析不执行修改' : '切换到计划模式（只读分析）'}
      </TooltipContent>
    </Tooltip>
  )
}
