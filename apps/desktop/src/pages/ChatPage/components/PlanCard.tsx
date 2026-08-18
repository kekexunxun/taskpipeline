import { useState, useCallback } from 'react'
import {
  FileTextIcon,
  PlayIcon,
  Loader2Icon,
  CheckCircleIcon,
  XCircleIcon,
  ChevronRightIcon,
  ClipboardListIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from '@/components/ui/sheet'
import { MessageResponse } from '@/components/ai-elements/message'
import type { ChatPlan, ChatPlanStatus } from '@/api'
import { cn } from '@/lib/utils'

/**
 * 从计划 ID 和时间戳生成展示名称。
 * 格式：Plan_MMdd_HHmmss_xxxx（取 ID 后 4 位作为唯一标识）
 */
function getPlanDisplayName(plan: ChatPlan): string {
  const date = new Date(plan.createdAt)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  const unique = plan.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6)
  return `Plan_${mm}${dd}_${hh}${mi}${ss}_${unique}`
}

/**
 * PlanCard — 紧凑风格的计划卡片（参考 BashToolBlock 设计）。
 *
 * 设计：
 *  - 仅显示计划名称 + 状态徽章，不展示计划内容；
 *  - 点击打开 Sheet 预览完整计划内容；
 *  - Sheet 内提供"开始执行"按钮；
 *  - executing 状态显示旋转 loading 动画。
 */
export function PlanCard({
  plan,
  onExecute,
  disabled
}: {
  plan: ChatPlan
  onExecute?: (plan: ChatPlan) => void
  disabled?: boolean
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const statusConfig = getStatusConfig(plan.status)
  const StatusIcon = statusConfig.icon
  const displayName = getPlanDisplayName(plan)

  const handleExecute = useCallback(() => {
    onExecute?.(plan)
    setSheetOpen(false)
  }, [onExecute, plan])

  return (
    <>
      {/* 紧凑卡片：类似 BashToolBlock 风格 */}
      <button
        type="button"
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[10px]! transition-colors',
          'hover:bg-muted/30',
          plan.status === 'failed' ? 'border-red-500/20 bg-red-500/5' : 'border-border/40 bg-muted/20'
        )}
        onClick={() => setSheetOpen(true)}
      >
        <ClipboardListIcon size={13} className="shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/80">{displayName}</span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px]',
            statusConfig.className
          )}
        >
          <StatusIcon className={cn('size-3', plan.status === 'executing' && 'animate-spin')} />
          <span>{statusConfig.label}</span>
        </span>
        <ChevronRightIcon
          size={12}
          className="shrink-0 text-muted-foreground/40 transition-transform group-hover:text-muted-foreground/60"
        />
      </button>

      {/* Sheet：计划预览 */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FileTextIcon className="size-4 text-primary" />
              {displayName}
            </SheetTitle>
            <SheetDescription className="flex items-center gap-1.5">
              <StatusIcon className={cn('size-3', plan.status === 'executing' && 'animate-spin')} />
              {statusConfig.label}
            </SheetDescription>
          </SheetHeader>

          {/* 计划内容预览 */}
          <div className="flex-1 overflow-y-auto rounded-md border border-border/40 bg-muted/10 p-4">
            <div className="text-xs leading-relaxed">
              <MessageResponse>{plan.content}</MessageResponse>
            </div>
          </div>

          {/* 底部操作区 */}
          <SheetFooter>
            {plan.status === 'pending' && onExecute && (
              <Button
                size="sm"
                onClick={handleExecute}
                disabled={disabled}
                className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <PlayIcon className="size-3.5" />
                开始执行
              </Button>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}

function getStatusConfig(status: ChatPlanStatus): {
  icon: typeof FileTextIcon
  label: string
  className: string
} {
  switch (status) {
    case 'pending':
      return {
        icon: CheckCircleIcon,
        label: '待执行',
        className: 'bg-muted text-muted-foreground'
      }
    case 'executing':
      return {
        icon: Loader2Icon,
        label: '生成中',
        className: 'bg-blue-500/15 text-blue-400'
      }
    case 'completed':
      return {
        icon: CheckCircleIcon,
        label: '已完成',
        className: 'bg-green-500/15 text-green-400'
      }
    case 'failed':
      return {
        icon: XCircleIcon,
        label: '失败',
        className: 'bg-red-500/15 text-red-400'
      }
    case 'cancelled':
      return {
        icon: XCircleIcon,
        label: '已取消',
        className: 'bg-muted text-muted-foreground/60'
      }
  }
}
