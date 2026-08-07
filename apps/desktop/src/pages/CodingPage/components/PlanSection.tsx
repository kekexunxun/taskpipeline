import { useMemo } from 'react'
import { LoaderCircleIcon, MessageSquareTextIcon } from 'lucide-react'
import type { Task } from '@coding-agent/core'
import { normalizeTimelineItems, type TimelineItem } from './Timeline'
import { readablePlanContent } from './planContent'
import { MessageResponse } from '@/components/ai-elements/message'
import { cn } from '@/lib/utils'
import { formatTime } from '@/utils/format'

/**
 * 计划面板：生成中给"扫光 + 呼吸边框 + 跳点"动效；内容进入使用渐显上滑；调整记录交错入场。
 * 视觉上避免单一段落文本的生硬感，同时保持紧凑字号（11–14px 规范）。
 */
export function PlanSection({
  task,
  compact = false,
  events = []
}: {
  task: Task
  compact?: boolean
  events?: TimelineItem[]
}) {
  const planFeedback = useMemo(
    () => normalizeTimelineItems(events).filter((item) => item.title.trim() === '计划调整意见'),
    [events]
  )
  const revision = task.planRevision ?? 0
  const isRevising = task.state === 'planning' && Boolean(task.planContent)
  const isGenerating = !task.planContent && (task.state === 'planning' || task.state === 'awaiting_plan_approval')
  const planContent = readablePlanContent(task.planContent)
  if (!task.planContent && !['planning', 'awaiting_plan_approval'].includes(task.state)) return null

  return (
    <section className={cn('thin-scrollbar min-h-0 flex-1 overflow-y-auto', compact ? 'px-4 py-3' : 'px-6 py-5')}>
      <div className="mx-auto w-full max-w-4xl">
        <div className={cn('mb-3 flex items-center justify-between font-semibold', compact ? 'text-xs' : 'text-sm')}>
          <span
            key={`${task.state}-${revision}`}
            className={cn(
              'inline-flex animate-plan-fade-up items-center gap-1.5 text-xs text-muted-foreground',
              isRevising && 'text-foreground/80'
            )}
          >
            {isRevising && (
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inset-0 animate-plan-breathe rounded-full bg-amber-400/80" />
              </span>
            )}
            {isRevising ? `正在生成第 ${revision + 1} 版` : `第 ${revision} 版`}
          </span>
        </div>
        {planFeedback.length > 0 && (
          <div className={cn('mb-4 border-l-2 border-border', compact ? 'pl-3' : 'pl-4')}>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <MessageSquareTextIcon size={12} />
              计划调整记录
            </div>
            <div className="space-y-2" data-plan-feedback>
              {planFeedback.map((item, index) => (
                <div
                  className="grid animate-plan-fade-up grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs"
                  key={item.id}
                  style={{ animationDelay: `${Math.min(index, 6) * 60}ms` }}
                >
                  <div className="min-w-0">
                    <span className="mr-2 font-medium text-foreground">第 {index + 1} 次调整</span>
                    <span className="break-words whitespace-pre-wrap text-muted-foreground">{item.detail}</span>
                  </div>
                  <time className="text-muted-foreground">{formatTime(item.createdAt)}</time>
                </div>
              ))}
            </div>
          </div>
        )}
        {isRevising && (
          <div
            key={`revising-${revision}`}
            className="mb-3 flex animate-plan-fade-up items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200"
          >
            <LoaderCircleIcon className="shrink-0 animate-spin-slow" size={13} />
            <span className="flex-1">正在根据最近的调整意见生成新计划，当前仍展示第 {revision} 版供参考</span>
            <span className="inline-flex items-center gap-0.5 text-amber-200/80" aria-hidden>
              <span className="plan-dot" />
              <span className="plan-dot" />
              <span className="plan-dot" />
            </span>
          </div>
        )}
        {planContent ? (
          <div
            key={`plan-${revision}-${task.state}`}
            className={cn(
              'animate-plan-fade-up rounded-md border bg-background text-xs leading-5',
              compact ? 'p-3' : 'p-5'
            )}
          >
            <MessageResponse controls={false}>{planContent}</MessageResponse>
          </div>
        ) : task.planContent ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 text-xs leading-5 text-amber-200">
            当前版本的计划内容格式异常，无法恢复原文。请在下方填写调整意见并重新生成计划。
          </div>
        ) : isGenerating ? (
          <div
            className="relative overflow-hidden rounded-md border border-dashed border-primary/40 bg-muted/20 p-8 text-center text-xs text-muted-foreground"
            aria-live="polite"
          >
            <div
              className="plan-shimmer-overlay pointer-events-none absolute inset-0 animate-plan-shimmer"
              aria-hidden
            />
            <div className="relative flex flex-col items-center gap-2.5">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-primary/40 text-primary">
                <LoaderCircleIcon className="animate-spin-slow" size={14} />
              </span>
              <span className="text-foreground/80">正在生成计划</span>
              <span className="inline-flex items-center gap-1 text-muted-foreground/80" aria-hidden>
                <span className="plan-dot" />
                <span className="plan-dot" />
                <span className="plan-dot" />
              </span>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-8 text-center text-xs text-muted-foreground">
            等待生成计划
          </div>
        )}
      </div>
    </section>
  )
}
