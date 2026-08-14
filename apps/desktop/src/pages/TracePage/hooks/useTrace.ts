import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSpan, TraceDashboardStats, TraceSummary } from '@task-pipeline/core'
import type { ChatConversationMeta } from '@/api'
import { api } from '@/api'

/**
 * Trace 页面数据 hook（v2）。
 * - 挂载即拉列表 + 仪表盘统计，5 分钟轮询 + task:event 推送触发重拉；
 * - 详情按需加载（getTrace → AgentSpan 列表，前端组瀑布树）。
 * - 同时拉取会话列表，用于将 chat 类 Trace 标题解析为会话名称。
 */
export function useTrace() {
  const [summaries, setSummaries] = useState<TraceSummary[]>([])
  const [chatMetas, setChatMetas] = useState<ChatConversationMeta[]>([])
  const [dashboard, setDashboard] = useState<TraceDashboardStats | undefined>(undefined)
  const [detail, setDetail] = useState<AgentSpan[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)

  /** chat-<conversationId> → 会话标题，用于将 Trace 标题与会话/任务名称保持一致。 */
  const chatTitleMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const meta of chatMetas) {
      map.set(`chat-${meta.id}`, meta.title)
    }
    return map
  }, [chatMetas])

  /** 解析 Trace 展示标题：chat 类优先取会话标题，task 类保持原 title。 */
  const resolveTitle = useCallback(
    (summary: TraceSummary) => {
      if (summary.kind === 'chat') {
        return chatTitleMap.get(summary.traceId) ?? summary.title
      }
      return summary.title
    },
    [chatTitleMap]
  )

  const reload = useCallback(async () => {
    const [list, stats, chats] = await Promise.all([api.listTrace(), api.dashboardTrace(), api.listChats()])
    if (!mounted.current) return
    setSummaries(list)
    setDashboard(stats)
    setChatMetas(chats)
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

  return { summaries, dashboard, detail, detailLoading, loading, loadDetail, clearDetail, remove, resolveTitle }
}
