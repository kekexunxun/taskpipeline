import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ActivityIcon } from 'lucide-react'
import type { TraceSummary } from '@task-pipeline/core'
import { useTrace } from './hooks/useTrace'
import { TraceFilters, type StatusFilter, type TimeRangeFilter } from './components/TraceFilters'
import { TraceList } from './components/TraceList'
import { TraceDetail } from './components/TraceDetail'
import { DashboardCards } from './components/DashboardCards'

/**
 * Trace 页面（v2）：会话概览仪表盘 + 瀑布图详情 + Payload Inspector。
 * - `/trace`：仪表盘（统计卡片 + 列表）；
 * - `/trace/:kind/:traceId`：下钻瀑布图（kind 兼容旧路由，仅作 URL 占位）。
 */
export default function TracePage() {
  const navigate = useNavigate()
  const { kind, traceId } = useParams()
  const trace = useTrace()
  const [timeRange, setTimeRange] = useState<TimeRangeFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [agent, setAgent] = useState('')
  const [query, setQuery] = useState('')

  const activeTraceId = traceId ?? undefined

  useEffect(() => {
    if (activeTraceId) void trace.loadDetail(kind ?? 'chat', activeTraceId)
    else trace.clearDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTraceId])

  const agents = useMemo(() => {
    const set = new Set<string>()
    for (const s of trace.summaries) if (s.agentName) set.add(s.agentName)
    return [...set]
  }, [trace.summaries])

  const activeSummary: TraceSummary | undefined = useMemo(
    () => (activeTraceId ? trace.summaries.find((s) => s.traceId === activeTraceId) : undefined),
    [trace.summaries, activeTraceId]
  )

  const handleDelete = async (summary: TraceSummary) => {
    try {
      await trace.remove(summary.kind, summary.traceId)
      // 删除的正是当前详情 → 回到列表态
      if (activeTraceId === summary.traceId) navigate('/trace')
    } catch (error) {
      console.error('[trace] 删除失败:', error)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部：标题 + 统计卡片一排 */}
      <header className="flex shrink-0 flex-col border-b bg-card/40">
        <div className="flex items-center gap-2 px-4 py-2.5">
          <ActivityIcon size={15} className="text-emerald-500" />
          <h1 className="text-sm font-semibold">Trace</h1>
          <span className="text-[10px] text-muted-foreground">执行轨迹总览</span>
        </div>
        <DashboardCards stats={trace.dashboard} />
      </header>
      {/* 下面：左右结构（左侧列表 + 右侧详情） */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-96 shrink-0 flex-col border-r bg-card/40">
          <TraceFilters
            timeRange={timeRange}
            onTimeRangeChange={setTimeRange}
            status={status}
            onStatusChange={setStatus}
            agent={agent}
            onAgentChange={setAgent}
            agents={agents}
            query={query}
            onQueryChange={setQuery}
          />
          <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
            {trace.loading ? (
              <div className="p-4 text-xs text-muted-foreground">加载中…</div>
            ) : (
              <TraceList
                summaries={trace.summaries}
                timeRange={timeRange}
                status={status}
                agent={agent}
                query={query}
                activeId={activeTraceId}
                onSelect={(summary) => navigate(`/trace/${summary.kind}/${summary.traceId}`)}
                onDelete={handleDelete}
              />
            )}
          </div>
        </aside>
        <main className="min-w-0 flex-1">
          {activeTraceId ? (
            <TraceDetail
              traceId={activeTraceId}
              spans={trace.detail}
              loading={trace.detailLoading}
              summary={activeSummary}
              onBack={() => navigate('/trace')}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <ActivityIcon size={26} />
              <strong className="text-sm">选择左侧一条 Trace</strong>
              <span className="text-xs">查看一次提问 / 任务执行的完整执行树（瀑布图）</span>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
