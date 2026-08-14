import { useMemo, useState } from 'react'
import { ArrowLeftIcon, ClockIcon, CpuIcon, DollarSignIcon } from 'lucide-react'
import type { AgentSpan, TraceSummary } from '@task-pipeline/core'
import { Waterfall } from './Waterfall'
import { PayloadInspector } from './PayloadInspector'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

function formatDuration(ms?: number): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 详情容器：头部统计 + 瀑布图 + Payload Inspector（点击色块滑出）。 */
export function TraceDetail({
  traceId,
  spans,
  loading,
  summary,
  resolveTitle,
  onBack
}: {
  traceId: string
  spans: AgentSpan[]
  loading: boolean
  summary?: TraceSummary
  resolveTitle(summary: TraceSummary): string
  onBack(): void
}) {
  const [selected, setSelected] = useState<AgentSpan | null>(null)
  const selectedId = selected?.spanId

  const spanIndex = useMemo(() => new Map(spans.map((span) => [span.spanId, span])), [spans])

  const stats = useMemo(() => {
    let durationMs = summary?.durationMs
    let costUsd = summary?.costUsd
    let total = summary?.tokens?.total
    if (!summary && spans.length > 0) {
      let start = Infinity
      let end = -Infinity
      let cost = 0
      let tokens = 0
      for (const span of spans) {
        if (span.startedAt < start) start = span.startedAt
        const sEnd = span.endedAt ?? span.startedAt
        if (sEnd > end) end = sEnd
        cost += span.usage?.costUsd ?? 0
        tokens += span.usage?.totalTokens ?? 0
      }
      if (Number.isFinite(start) && end > start) durationMs = end - start
      if (cost > 0) costUsd = Number(cost.toFixed(4))
      if (tokens > 0) total = tokens
    }
    return { durationMs, costUsd, total }
  }, [spans, summary])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack}>
          <ArrowLeftIcon size={14} />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{summary ? resolveTitle(summary) : traceId}</span>
            {summary && (
              <>
                <Badge variant={summary.status === 'running' ? 'outline' : 'muted'} className="px-1.5 py-0 text-[10px]">
                  {summary.status === 'running' ? '进行中' : '已结束'}
                </Badge>
                {summary.errorCount > 0 && (
                  <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                    {summary.errorCount} 个错误步骤
                  </Badge>
                )}
                {summary.interrupted && (
                  <Badge
                    variant="warning"
                    className="px-1.5 py-0 text-[10px]"
                    title="应用异常退出导致记录中断，启动时已自动收口为已结束"
                  >
                    异常中断
                  </Badge>
                )}
              </>
            )}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">{traceId}</div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground tabular-nums">
          {stats.durationMs !== undefined && (
            <span className="flex items-center gap-1">
              <ClockIcon size={11} />
              {formatDuration(stats.durationMs)}
            </span>
          )}
          {stats.total !== undefined && (
            <span className="flex items-center gap-1">
              <CpuIcon size={11} />
              {stats.total.toLocaleString()} tok
            </span>
          )}
          {stats.costUsd !== undefined && (
            <span className="flex items-center gap-1 text-amber-500">
              <DollarSignIcon size={11} />${stats.costUsd.toFixed(4)}
            </span>
          )}
          <span className="flex items-center gap-1 text-muted-foreground">
            {summary?.agentName && <span className={cn('text-violet-400')}>{summary.agentName}</span>}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {loading ? (
            <div className="p-6 text-center text-xs text-muted-foreground">加载中…</div>
          ) : (
            <Waterfall spans={spans} selectedId={selectedId} onSelect={(span) => setSelected(span)} />
          )}
        </div>
        {selected && (
          <PayloadInspector span={spanIndex.get(selected.spanId) ?? selected} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  )
}
