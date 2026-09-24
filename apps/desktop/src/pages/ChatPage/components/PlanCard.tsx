import { useMemo, useState } from 'react'
import {
  FileTextIcon,
  PlayIcon,
  Loader2Icon,
  CheckCircleIcon,
  XCircleIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  BanIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
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

/** 提取轻量文本预览，保留内容换行，去除常见 Markdown 标记。 */
function getPlanPreview(content: string): string {
  return content
    .replace(/^\s*(```|~~~).*$/gm, '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, '• ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    )
    .filter((line) => line && !/^([-*_]\s*){3,}$/.test(line))
    .join('\n')
}

/**
 * PlanCard — 紧凑风格的计划卡片（参考 BashToolBlock 设计）。
 *
 * 设计：
 *  - 显示计划名称 + 状态徽章 + 最多五行内容预览 + 执行/取消操作按钮；
 *  - 点击标题或内容预览打开 Sheet 查看完整计划内容；
 *  - pending 状态下卡片内提供“执行”与“取消”两个操作；
 *  - executing 状态显示旋转 loading 动画。
 */
export function PlanCard({
  plan,
  onExecute,
  onCancel,
  disabled,
  statusText
}: {
  plan: ChatPlan
  onExecute?: (plan: ChatPlan) => void
  onCancel?: (plan: ChatPlan) => void
  disabled?: boolean
  /** 状态文案覆盖（流式生成中的临时卡片用“生成中”，默认按 status 取文案）。 */
  statusText?: string
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const statusConfig = getStatusConfig(plan.status)
  const StatusIcon = statusConfig.icon
  const displayName = getPlanDisplayName(plan)
  const preview = useMemo(() => getPlanPreview(plan.content), [plan.content])
  // 仅待执行且有回调时展示操作行（行在卡片内，“明显”可见）。
  const showActions = plan.status === 'pending' && Boolean(onExecute || onCancel)

  return (
    <>
      {/* 紧凑卡片：类似 BashToolBlock 风格 */}
      <div
        className={cn(
          'group w-full overflow-hidden rounded-md border text-[10px]! transition-colors',
          plan.status === 'failed' ? 'border-red-500/20 bg-red-500/5' : 'border-border/40 bg-muted/20',
          // 已取消/已失效的计划弱化展示（对话已推进，旧计划不可再执行）。
          plan.status === 'cancelled' && 'opacity-60'
        )}
      >
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/30"
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
            <span>{statusText ?? statusConfig.label}</span>
          </span>
          <ChevronRightIcon
            size={12}
            className="shrink-0 text-muted-foreground/40 transition-transform group-hover:text-muted-foreground/60"
          />
        </button>

        {preview && (
          <button
            type="button"
            aria-label="查看完整计划"
            className="block w-full px-3 pb-2.5 text-left transition-colors hover:bg-muted/30"
            onClick={() => setSheetOpen(true)}
          >
            <span className="line-clamp-5 text-xs leading-5 break-words whitespace-pre-line text-muted-foreground">
              {preview}
            </span>
          </button>
        )}

        {showActions && (
          <div className="flex items-center gap-1.5 px-3 pb-2.5">
            {onExecute && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onExecute(plan)}
                disabled={disabled}
                className="h-5.5 gap-1 bg-primary px-2 text-[11px]! text-primary-foreground shadow-none hover:bg-primary/90"
              >
                <PlayIcon className="size-2.5" />
                执行
              </Button>
            )}
            {onCancel && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onCancel(plan)}
                disabled={disabled}
                className="h-5.5 gap-1 border-input bg-background px-2 text-[11px]! text-foreground shadow-none hover:bg-accent"
              >
                <BanIcon className="size-2.5" />
                取消
              </Button>
            )}
          </div>
        )}
      </div>

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
              {statusText ?? statusConfig.label}
            </SheetDescription>
          </SheetHeader>

          {/* 计划内容预览 */}
          <div className="flex-1 overflow-y-auto rounded-md border border-border/40 bg-muted/10 p-4">
            <div className="text-xs leading-relaxed">
              <MessageResponse>{plan.content}</MessageResponse>
            </div>
          </div>
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
        label: '执行中',
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
