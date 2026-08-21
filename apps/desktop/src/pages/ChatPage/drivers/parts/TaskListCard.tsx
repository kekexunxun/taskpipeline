import { CheckCircle2Icon, CircleIcon, ListChecksIcon, Loader2Icon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 任务卡片 —— 展示 TaskCreate 聚合的全部任务条目（常驻展开，作为执行看板）。
 *
 * TaskCreate 初次产卡（条目均为 pending 状态），
 * 后续每次 TaskUpdate 产卡：use 阶段加载动画 → result 阶段完成态。
 */
export function TaskListCard({
  header,
  items,
  updatedTaskId,
  updatePhase,
  className
}: {
  header: string
  items: Array<{ taskId: string; subject: string; completed?: boolean }>
  /** 本次更新的任务 #N。 */
  updatedTaskId?: string
  /** 更新阶段：use=加载动画，result=完成态。 */
  updatePhase?: 'use' | 'result'
  className?: string
}) {
  if (items.length === 0) return null

  const isUpdating = (taskId: string) => taskId === updatedTaskId && updatePhase === 'use'

  return (
    <div className={cn('not-prose w-full overflow-hidden rounded-md border border-border/40 bg-muted/20', className)}>
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b border-border/30 px-3 py-1.5">
        <ListChecksIcon size={13} className="shrink-0 text-violet-400" />
        <span className="text-[11px] font-medium text-muted-foreground">{header}</span>
        <span className="ml-auto rounded-full bg-foreground/5 px-1.5 py-px text-[10px] text-muted-foreground/70 tabular-nums">
          {items.length}
        </span>
      </div>
      {/* Items */}
      <div className="space-y-1.5 px-3 py-2">
        {items.map((item) => (
          <div
            key={item.taskId}
            className={cn(
              'flex items-center gap-2 text-xs',
              item.completed ? 'text-muted-foreground/50' : 'text-muted-foreground/80'
            )}
          >
            {isUpdating(item.taskId) ? (
              <Loader2Icon size={14} className="shrink-0 animate-spin text-amber-500" />
            ) : item.completed ? (
              <CheckCircle2Icon size={14} className="shrink-0 text-emerald-500" />
            ) : (
              <CircleIcon size={14} className="shrink-0 text-muted-foreground/30" />
            )}
            <span className="min-w-0 truncate">{item.subject}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
