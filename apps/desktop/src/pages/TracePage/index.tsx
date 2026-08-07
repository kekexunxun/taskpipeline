import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ActivityIcon } from 'lucide-react'
import type { TraceKind } from '@coding-agent/core'
import { useTrace } from './hooks/useTrace'
import { TraceFilters, type TraceKindFilter } from './components/TraceFilters'
import { TraceList } from './components/TraceList'
import { TraceDetail } from './components/TraceDetail'

const VALID_KINDS: TraceKind[] = ['task', 'chat', 'pi_session']

/**
 * Trace 页面：展示所有对话 / 任务 / Pi 会话的整体执行轨迹。
 * - `/trace`：列表视图（类型筛选 + 关键词搜索）；
 * - `/trace/:kind/:traceId`：下钻详情（复用 CodingPage 的 Timeline 渲染）。
 */
export default function TracePage() {
  const navigate = useNavigate()
  const { kind, traceId } = useParams()
  const trace = useTrace()
  const [kindFilter, setKindFilter] = useState<TraceKindFilter>('all')
  const [query, setQuery] = useState('')

  const activeKind: TraceKind | undefined = VALID_KINDS.includes(kind as TraceKind) ? (kind as TraceKind) : undefined

  // URL 参数 → 加载详情；无参数时清空详情
  useEffect(() => {
    if (activeKind && traceId) void trace.loadDetail(activeKind, traceId)
    else trace.setDetail([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKind, traceId])

  const activeId = activeKind ? (activeKind === 'task' ? traceId : `${activeKind}/${traceId}`) : undefined
  const activeSummary = useMemo(
    () =>
      activeKind && traceId ? trace.summaries.find((s) => s.kind === activeKind && s.traceId === traceId) : undefined,
    [trace.summaries, activeKind, traceId]
  )

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 shrink-0 flex-col border-r bg-card/40">
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <ActivityIcon size={15} className="text-emerald-500" />
          <h1 className="text-sm font-semibold">Trace</h1>
          <span className="text-[10px] text-muted-foreground">执行轨迹总览</span>
        </div>
        <TraceFilters kind={kindFilter} onKindChange={setKindFilter} query={query} onQueryChange={setQuery} />
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
          {trace.loading ? (
            <div className="p-4 text-xs text-muted-foreground">加载中…</div>
          ) : (
            <TraceList summaries={trace.summaries} kind={kindFilter} query={query} activeId={activeId} />
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {activeKind && traceId ? (
          <TraceDetail
            kind={activeKind}
            traceId={traceId}
            entries={trace.detail}
            loading={trace.detailLoading}
            summary={activeSummary}
            onBack={() => navigate('/trace')}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <ActivityIcon size={26} />
            <strong className="text-sm">选择左侧一条 Trace</strong>
            <span className="text-xs">查看任务、对话或 Pi 会话的完整执行轨迹</span>
          </div>
        )}
      </main>
    </div>
  )
}
