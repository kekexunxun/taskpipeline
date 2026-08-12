import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSpan, TraceDashboardStats, TraceSummary } from '@task-pipeline/core'
import { api } from '@/api'

/**
 * Trace 页面数据 hook（v2）。
 * - 挂载即拉列表 + 仪表盘统计，5 分钟轮询 + task:event 推送触发重拉；
 * - 详情按需加载（getTrace → AgentSpan 列表，前端组瀑布树）。
 */
export function useTrace() {
  const [summaries, setSummaries] = useState<TraceSummary[]>([])
  const [dashboard, setDashboard] = useState<TraceDashboardStats | undefined>(undefined)
  const [detail, setDetail] = useState<AgentSpan[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)

  const reload = useCallback(async () => {
    const [list, stats] = await Promise.all([api.listTrace(), api.dashboardTrace()])
    if (!mounted.current) return
    setSummaries(list)
    setDashboard(stats)
    setLoading(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    void reload()
    const timer = setInterval(() => void reload(), 5 * 60 * 1000)
    const unsubscribe = api.onTaskEvent?.((event: { type?: string }) => {
      // 新 span / 任务状态变更 → 重拉列表与统计
      if (event?.type === 'trace_span' || event?.type === 'agent_end' || event?.type === 'agent_error') void reload()
    })
    return () => {
      mounted.current = false
      clearInterval(timer)
      unsubscribe?.()
    }
  }, [reload])

  const loadDetail = useCallback(async (kind: string, traceId: string) => {
    setDetailLoading(true)
    try {
      const spans = await api.getTrace(kind, traceId)
      if (mounted.current) setDetail(spans ?? [])
    } finally {
      if (mounted.current) setDetailLoading(false)
    }
  }, [])

  const clearDetail = useCallback(() => {
    setDetail([])
  }, [])

  /** 删除一条 trace 并重拉列表与统计（删除当前详情时由页面负责清空路由）。 */
  const remove = useCallback(
    async (kind: string, traceId: string) => {
      await api.deleteTrace(kind, traceId)
      await reload()
    },
    [reload]
  )

  return { summaries, dashboard, detail, detailLoading, loading, loadDetail, clearDetail, remove }
}
