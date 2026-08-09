import { useCallback, useEffect, useState } from 'react'
import type { TraceEntry, TraceKind, TraceSummary } from '@task-pipeline/core'
import { api } from '../../../api'

/**
 * Trace 页面数据 hook。
 * - summaries：四路数据源聚合的列表（60s 轮询）；
 * - detail：单条 trace 完整轨迹；
 * - 实时刷新：复用现有 `task:event` 推送（任务状态变化时触发重拉），不新增推送通道。
 */
export function useTrace() {
  const [summaries, setSummaries] = useState<TraceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<TraceEntry[]>([])
  const [detailLoading, setDetailLoading] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setSummaries(await api.listTrace())
    } catch {
      /* 拉取失败静默，保留旧数据 */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  // 任务执行事件 → 实时刷新
  useEffect(() => {
    const off = api.onTaskEvent((event) => {
      if (['task_changed', 'agent_end', 'agent_error', 'process_exit'].includes(event.type)) void refresh()
    })
    return off
  }, [refresh])

  const loadDetail = useCallback(async (kind: TraceKind, traceId: string) => {
    setDetailLoading(true)
    try {
      setDetail(await api.getTrace(kind, traceId))
    } catch {
      setDetail([])
    } finally {
      setDetailLoading(false)
    }
  }, [])

  return { summaries, loading, detail, detailLoading, refresh, loadDetail, setDetail }
}
