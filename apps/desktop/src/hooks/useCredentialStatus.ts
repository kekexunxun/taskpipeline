import { useCallback, useEffect, useState } from 'react'
import { api, type CredentialState } from '../api'

/** 顶栏指示灯聚合态：red=有异常；green=已配置项全部通过；gray=未配置；checking=探测中。 */
export type CredentialOverall = 'red' | 'green' | 'gray' | 'checking'

export type CredentialStatusSnapshot = {
  items: CredentialState[]
  overall: CredentialOverall
  /** 手动触发一轮探测。 */
  recheck(): Promise<void>
}

/** 聚合态推导：任一 failed → red；有 checking → checking；有已配置且无失败 → green；全未配置 → gray。 */
export function deriveCredentialOverall(items: CredentialState[]): CredentialOverall {
  if (items.length === 0) return 'gray'
  if (items.some((item) => item.status === 'failed')) return 'red'
  if (items.some((item) => item.status === 'checking')) return 'checking'
  return items.some((item) => item.status === 'ok') ? 'green' : 'gray'
}

/**
 * 全局凭据状态：主进程单一数据源，挂载时拉快照 + 订阅变化广播。
 * 顶栏指示灯与各页面共用这一份状态，其它调用处无需重复探测。
 */
export function useCredentialStatus(): CredentialStatusSnapshot {
  const [items, setItems] = useState<CredentialState[]>([])

  useEffect(() => {
    let cancelled = false
    const unsubscribe = api.onCredentialStateChange((states) => {
      if (!cancelled) setItems(states)
    })
    api
      .getCredentialState()
      .then((states) => {
        if (!cancelled) setItems(states)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const recheck = useCallback(async () => {
    try {
      setItems(await api.checkCredentials())
    } catch {
      // 探测失败时各项结果已通过 state-changed 事件回写为 failed，这里无需兜底。
    }
  }, [])

  return { items, overall: deriveCredentialOverall(items), recheck }
}
