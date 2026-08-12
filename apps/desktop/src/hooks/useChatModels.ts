import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ChatModelGroup } from '../api'

export type ChatModelsSnapshot = {
  modelGroups: ChatModelGroup[]
  loading: boolean
  refresh(): Promise<void>
}

export function useChatModels(): ChatModelsSnapshot {
  const [modelGroups, setModelGroups] = useState<ChatModelGroup[]>([])
  const [loading, setLoading] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const groups = await api.listChatModels()
      setModelGroups(groups)
    } catch {
      // 静默失败，保留旧数据
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 设置中增删/修改模型配置（OpenAI-Compatible profile）后广播 `app:models-changed`，
  // 已挂载的对话页 / 详情页 / Agent 弹窗据此刷新模型列表，否则弹窗会一直显示旧快照。
  useEffect(() => {
    window.addEventListener('app:models-changed', refresh)
    return () => window.removeEventListener('app:models-changed', refresh)
  }, [refresh])

  // Qoder 连接/启用状态变化（主进程探测后广播 `qoder_status_changed`）同样会改变
  // listModels 结果（未连接时 qoder driver 直接返回空列表），需要刷新，
  // 否则用户明明选择了 Qoder-Lite，模型选择栏却一直显示"没有模型"。
  useEffect(() => {
    const off = api.onTaskEvent((event: unknown) => {
      const type = (event as { type?: string } | undefined)?.type
      if (type === 'qoder_status_changed') void refresh()
    })
    return off
  }, [refresh])

  return { modelGroups, loading, refresh }
}
