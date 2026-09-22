import { ShieldAlertIcon, ShieldCheckIcon, ShieldXIcon, SparklesIcon, ScanSearchIcon, WrenchIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DriverPart } from '@/api'

type ReviewResultPart = Extract<DriverPart, { type: 'chat.review-result' }>

/** 结论态视觉映射：标题 / 图标 / 边框与徽标配色。 */
const OUTCOME_META: Record<
  ReviewResultPart['outcome'],
  { title: string; icon: typeof ShieldCheckIcon; tone: string; headerClass: string }
> = {
  passed: {
    title: '代码审查通过',
    icon: ShieldCheckIcon,
    tone: 'text-emerald-500',
    headerClass: 'border-emerald-500/30 bg-emerald-500/5'
  },
  fixed: {
    title: '自动修订后复审通过',
    icon: ShieldCheckIcon,
    tone: 'text-emerald-500',
    headerClass: 'border-emerald-500/30 bg-emerald-500/5'
  },
  blocked: {
    title: '发现阻断问题',
    icon: ShieldAlertIcon,
    tone: 'text-amber-500',
    headerClass: 'border-amber-500/30 bg-amber-500/5'
  },
  failed: {
    title: '自动修订后仍有阻断',
    icon: ShieldXIcon,
    tone: 'text-destructive',
    headerClass: 'border-destructive/30 bg-destructive/5'
  }
}

/** 意见 severity → 色点（与阻断级别口径一致的直观着色）。 */
function severityDot(severity?: string): string {
  switch ((severity ?? '').toLowerCase()) {
    case 'critical':
      return 'bg-red-500'
    case 'high':
      return 'bg-orange-500'
    case 'error':
      return 'bg-orange-500'
    case 'medium':
      return 'bg-amber-500'
    case 'low':
      return 'bg-sky-500'
    default:
      return 'bg-muted-foreground/40'
  }
}

/** 级别 → 中文标签。 */
function levelLabel(level: ReviewResultPart['level']): string {
  if (level === 'critical') return '仅 Critical'
  if (level === 'medium') return 'Medium 及以上'
  return 'High 及以上'
}

/**
 * CodeReview 结论卡 —— 展示本轮代码评审的终态：结论徽标 + 覆盖范围/修订轮次 + 阻断意见列表。
 *
 * 数据来自主进程评审编排（`chat-review.ts` → `chat-service.runChatReview`），作为持久 part 随
 * assistant 消息落盘；多轮自动修订时以「替换式」保持单卡，故这里只呈现最终结论。
 */
export function ReviewResultCard({ part, className }: { part: ReviewResultPart; className?: string }) {
  const meta = OUTCOME_META[part.outcome]
  const Icon = meta.icon
  const hasComments = part.comments.length > 0

  return (
    <div
      className={cn('not-prose w-full overflow-hidden rounded-md border border-border/40 bg-muted/20', className)}
      data-review-outcome={part.outcome}
    >
      {/* Header：结论 + 元信息 */}
      <div className={cn('flex items-center gap-1.5 border-b px-3 py-1.5', meta.headerClass, 'border-border/30')}>
        <Icon size={13} className={cn('shrink-0', meta.tone)} />
        <span className="text-[11px] font-medium text-foreground/80">{meta.title}</span>
        <span className="rounded-full bg-foreground/5 px-1.5 py-px text-[10px] text-muted-foreground/80">
          {levelLabel(part.level)}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground/70 tabular-nums">
          <span className="inline-flex items-center gap-1" title="本轮评审覆盖的文件数">
            <ScanSearchIcon size={11} className="shrink-0" />
            {part.filesReviewed} 文件
          </span>
          {part.fixRounds > 0 && (
            <span className="inline-flex items-center gap-1" title="自动修订执行的轮数">
              <WrenchIcon size={11} className="shrink-0" />
              修订 {part.fixRounds} 轮
            </span>
          )}
        </span>
      </div>

      {/* Body：阻断意见列表（通过态为空则不渲染列表区） */}
      {hasComments ? (
        <ul className="divide-y divide-border/20">
          {part.comments.map((comment, index) => (
            <li
              key={`${comment.path ?? 'c'}-${comment.line ?? 0}-${index}`}
              className="flex items-start gap-2 px-3 py-1.5"
            >
              <span
                className={cn('mt-1 inline-block size-1.5 shrink-0 rounded-full', severityDot(comment.severity))}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {comment.severity && (
                    <span className="rounded bg-foreground/5 px-1 py-px text-[10px] font-medium text-muted-foreground uppercase">
                      {comment.severity}
                    </span>
                  )}
                  {comment.path && (
                    <code className="truncate font-mono text-[10px] text-muted-foreground/80">
                      {comment.path}
                      {comment.line != null ? `:${comment.line}` : ''}
                    </code>
                  )}
                </div>
                {comment.message && (
                  <p className="mt-0.5 text-xs leading-5 break-words text-muted-foreground">{comment.message}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground/70">
          <SparklesIcon size={12} className="shrink-0 text-emerald-500" />
          {part.outcome === 'passed' ? '无阻断级问题' : '所有阻断意见已解决'}
        </div>
      )}

      {/* 自动修订未启用/不可用时的提示：阻断仍在但本轮不再自动处理 */}
      {hasComments && !part.autoFix && (
        <div className="border-t border-border/20 px-3 py-1.5 text-[10px] text-muted-foreground/60">
          自动修订未开启，请手动处理以上问题
        </div>
      )}
    </div>
  )
}
