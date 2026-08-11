import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ActivityIcon, Code2Icon, MessageSquareTextIcon, SparklesIcon, type LucideIcon } from 'lucide-react'
import type { TraceKind, TraceSummary } from '@task-pipeline/core'
import type { TraceKindFilter } from './TraceFilters'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { formatDuration, formatTime, formatTokens } from '@/utils/format'
import { statusLabels } from '@/utils/status'

const kindMeta: Record<TraceKind, { label: string; icon: LucideIcon; className: string }> = {
  task: { label: '任务', icon: Code2Icon, className: 'text-sky-500' },
  chat: { label: '对话', icon: MessageSquareTextIcon, className: 'text-violet-500' },
  pi_session: { label: 'Pi 会话', icon: ActivityIcon, className: 'text-emerald-500' },
  // 「其它」分类：目前承接 AI 生成 Agent 模板等非任务 / 非对话 / 非 Pi 会话事件。
  other: { label: '其它', icon: SparklesIcon, className: 'text-amber-500' }
}

function matches(summary: TraceSummary, kind: TraceKindFilter, query: string): boolean {
  if (kind !== 'all' && summary.kind !== kind) return false
  if (!query.trim()) return true
  const haystack = [summary.title, summary.traceId, summary.state, summary.linkedTaskId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(query.trim().toLowerCase())
}

/** 统计摘要：模型 / Token / 成本。 */
function StatsBadges({ stats }: { stats: TraceSummary['stats'] }) {
  if (!stats) return null
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
      {stats.model && (
        <Badge variant="outline" className="max-w-36 truncate px-1 py-0 font-mono text-[9px]">
          {stats.model}
        </Badge>
      )}
      {stats.tokens && stats.tokens.total > 0 && (
        <span title={`输入 ${stats.tokens.input} · 输出 ${stats.tokens.output}`}>
          ↑{formatTokens(stats.tokens.input)} ↓{formatTokens(stats.tokens.output)}
        </span>
      )}
      {typeof stats.costUsd === 'number' && stats.costUsd > 0 && (
        <span className="text-emerald-600 dark:text-emerald-400">${stats.costUsd.toFixed(4)}</span>
      )}
      {typeof stats.durationMs === 'number' && stats.durationMs > 0 && <span>{formatDuration(stats.durationMs)}</span>}
    </span>
  )
}

/** 左列 Trace 列表：聚合任务 / 对话 / Pi 会话。 */
export function TraceList({
  summaries,
  kind,
  query,
  activeId
}: {
  summaries: TraceSummary[]
  kind: TraceKindFilter
  query: string
  activeId?: string
}) {
  const navigate = useNavigate()
  const visible = useMemo(() => summaries.filter((item) => matches(item, kind, query)), [summaries, kind, query])

  if (visible.length === 0) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-1 text-center text-muted-foreground">
        <ActivityIcon size={22} />
        <strong className="text-xs">暂无 Trace 记录</strong>
        <span className="text-xs">任务执行、对话或 Pi 会话都会出现在这里</span>
      </div>
    )
  }

  return (
    <ul className="divide-y">
      {visible.map((summary) => {
        const meta = kindMeta[summary.kind]
        const Icon = meta.icon
        const active =
          summary.kind === 'task' ? activeId === summary.traceId : `${summary.kind}/${summary.traceId}` === activeId
        return (
          <li key={`${summary.kind}:${summary.traceId}`}>
            <button
              type="button"
              onClick={() => navigate(`/trace/${summary.kind}/${summary.traceId}`)}
              className={cn(
                'flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-accent/60',
                active && 'bg-accent'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border bg-background',
                  meta.className
                )}
              >
                <Icon size={13} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{summary.title}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                    {meta.label}
                  </Badge>
                  {summary.state && (
                    <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                      {statusLabels[summary.state] ?? summary.state}
                    </Badge>
                  )}
                  <span>{formatTime(summary.updatedAt)}</span>
                  <span>· {summary.entryCount} 条</span>
                </span>
                {summary.stats && <StatsBadges stats={summary.stats} />}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
