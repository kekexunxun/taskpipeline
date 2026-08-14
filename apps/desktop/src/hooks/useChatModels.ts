import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ChatModelGroup } from '../api'

export type ChatModelsSnapshot = {
  modelGroups: ChatModelGroup[]
  loading: boolean
  refresh(): Promise<void>
}

// ── 模块级缓存：多个 useChatModels 实例共享同一次 IPC 结果，避免每个页面 mount 都重复请求 ──
const CACHE_TTL = 10_000 // 10s
let cachedPromise: Promise<ChatModelGroup[]> | null = null
let cachedAt = 0

function fetchModels(): Promise<ChatModelGroup[]> {
  const now = Date.now()
  if (cachedPromise && now - cachedAt < CACHE_TTL) return cachedPromise
  cachedPromise = api
    .listChatModels()
    .then((groups) => {
      cachedAt = Date.now()
      return groups
    })
    .catch((error) => {
      // 请求失败时清除缓存，下次重试
      cachedPromise = null
      cachedAt = 0
      throw error
    })
  return cachedPromise
}

/** 强制失效缓存，供事件驱动刷新使用（跳过 TTL 检查）。 */
function invalidateCache(): void {
  cachedPromise = null
  cachedAt = 0
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
      const groups = await fetchModels()
      setModelGroups(groups)
    } catch {
      // 静默失败，保留旧数据
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [])

  // 事件驱动的刷新需要跳过 TTL 缓存，否则短时间内的事件触发拿到的仍是旧数据
  const refreshForce = useCallback(async () => {
    invalidateCache()
    await refresh()
  }, [refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 设置中增删/修改模型配置（OpenAI-Compatible profile）后广播 `app:models-changed`，
  // 已挂载的对话页 / 详情页 / Agent 弹窗据此刷新模型列表，否则弹窗会一直显示旧快照。
  useEffect(() => {
    window.addEventListener('app:models-changed', refreshForce)
    return () => window.removeEventListener('app:models-changed', refreshForce)
  }, [refreshForce])

  // Qoder 连接/启用状态变化（主进程探测后广播 `qoder_status_changed`）同样会改变
  // listModels 结果（未连接时 qoder driver 直接返回空列表），需要刷新，
  // 否则用户明明选择了 Qoder-Lite，模型选择栏却一直显示"没有模型"。
  useEffect(() => {
    const off = api.onTaskEvent((event: unknown) => {
      const type = (event as { type?: string } | undefined)?.type
      if (type === 'qoder_status_changed') void refreshForce()
    })
    return off
  }, [refreshForce])

  return { modelGroups, loading, refresh }
}
