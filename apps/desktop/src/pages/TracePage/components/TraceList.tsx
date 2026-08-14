import { CheckCircleIcon, XCircleIcon, LoaderIcon, BotIcon, MessageSquareIcon, Trash2Icon } from 'lucide-react'
import type { TraceSummary } from '@task-pipeline/core'
import type { StatusFilter, TimeRangeFilter } from './TraceFilters'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function shortId(traceId: string): string {
  return traceId.length > 16 ? `${traceId.slice(0, 8)}…${traceId.slice(-4)}` : traceId
}

function matches(
  summary: TraceSummary,
  timeRange: TimeRangeFilter,
  status: StatusFilter,
  agent: string,
  query: string
): boolean {
  if (timeRange === 'today') {
    const start = Date.now() - 24 * 60 * 60 * 1000
    if (Date.parse(summary.startedAt) < start) return false
  } else if (timeRange === 'week') {
    const start = Date.now() - 7 * 24 * 60 * 60 * 1000
    if (Date.parse(summary.startedAt) < start) return false
  }
  // 两态口径：'running'/'ended' 按状态过滤（存量 'success'/'error' 摘要非 running 即已结束）；
  // 'error' 按 errorCount 过滤「含错误步骤」的记录。
  if (status === 'running' && summary.status !== 'running') return false
  if (status === 'ended' && summary.status === 'running') return false
  if (status === 'error' && !(summary.errorCount > 0)) return false
  if (agent && summary.agentName !== agent) return false
  if (query) {
    const haystack = `${summary.traceId} ${summary.title} ${summary.agentName ?? ''}`.toLowerCase()
    if (!haystack.includes(query.toLowerCase())) return false
  }
  return true
}

// 两态状态列：进行中 / 已结束（无"失败"，错误量以独立的错误计数标记呈现）。
const statusMeta = {
  running: { label: '进行中', className: 'text-sky-400', Icon: LoaderIcon },
  ended: { label: '已结束', className: 'text-muted-foreground', Icon: CheckCircleIcon }
} as const

/** 左列 Trace 列表：仪表盘下的会话概览。 */
export function TraceList({
  summaries,
  timeRange,
  status,
  agent,
  query,
  activeId,
  resolveTitle,
  onSelect,
  onDelete
}: {
  summaries: TraceSummary[]
  timeRange: TimeRangeFilter
  status: StatusFilter
  agent: string
  query: string
  activeId?: string
  resolveTitle(summary: TraceSummary): string
  onSelect(summary: TraceSummary): void
  onDelete(summary: TraceSummary): void
}) {
  const filtered = summaries.filter((s) => matches(s, timeRange, status, agent, query))

  if (filtered.length === 0) {
    return <div className="px-4 py-6 text-center text-xs text-muted-foreground">暂无 Trace 记录</div>
  }

  return (
    <ul className="divide-y">
      {filtered.map((summary) => {
        // 存量摘要的 'success'/'error' 状态按「非 running 即已结束」兼容展示。
        const meta = summary.status === 'running' ? statusMeta.running : statusMeta.ended
        return (
          <li key={summary.traceId} className="group relative">
            <button
              type="button"
              onClick={() => onSelect(summary)}
              className={cn(
                'flex w-full flex-col gap-1 px-4 py-2.5 pr-9 text-left transition-colors hover:bg-accent/50',
                activeId === summary.traceId && 'bg-accent'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  {summary.kind === 'task' ? (
                    <BotIcon size={12} className="shrink-0 text-violet-400" />
                  ) : (
                    <MessageSquareIcon size={12} className="shrink-0 text-sky-400" />
                  )}
                  <span className="truncate text-xs font-medium">
                    {resolveTitle(summary) || shortId(summary.traceId)}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
                  <meta.Icon size={11} className={cn(meta.className, summary.status === 'running' && 'animate-spin')} />
                  {meta.label}
                  {summary.errorCount > 0 && (
                    <span
                      className="flex items-center gap-0.5 text-rose-400"
                      title={`${summary.errorCount} 个错误步骤`}
                    >
                      <XCircleIcon size={10} />
                      {summary.errorCount} 个错误步骤
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
                {summary.model && (
                  <Badge
                    variant="outline"
                    className="max-w-40 shrink-0 px-1 py-0 font-mono text-[10px]"
                    title={summary.model}
                  >
                    {summary.model}
                  </Badge>
                )}
              </div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
                <span title={summary.traceId}>
                  {shortId(summary.traceId)} · {formatTime(summary.startedAt)}
                </span>
                <span className="flex items-center gap-1.5">
                  {summary.durationMs !== undefined && <span>{formatDuration(summary.durationMs)}</span>}
                  {summary.tokens?.total !== undefined && <span>{summary.tokens.total.toLocaleString()} tok</span>}
                  {summary.costUsd !== undefined && <span>${summary.costUsd.toFixed(4)}</span>}
                </span>
              </div>
            </button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`删除 Trace ${resolveTitle(summary) || shortId(summary.traceId)}`}
                  className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Trash2Icon size={12} />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>删除 Trace？</AlertDialogTitle>
                  <AlertDialogDescription>
                    将永久删除「{resolveTitle(summary) || shortId(summary.traceId)}」的执行记录（span
                    数据），此操作无法撤销。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onDelete(summary)}>删除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </li>
        )
      })}
    </ul>
  )
}
