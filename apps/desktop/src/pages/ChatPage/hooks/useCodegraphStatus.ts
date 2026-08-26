import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type CodegraphIndexStatus } from '@/api'

/**
 * 查询指定工作目录的 codegraph 索引状态。
 * - workingDirectory 变化时自动查询
 * - 暴露 build() 触发构建并刷新状态
 */
export function useCodegraphStatus(workingDirectory?: string) {
  const [status, setStatus] = useState<CodegraphIndexStatus | undefined>(undefined)
  const [building, setBuilding] = useState(false)
  const mountedRef = useRef(true)

  // workingDirectory 变化时重新查询
  useEffect(() => {
    if (!workingDirectory) {
      setStatus(undefined)
      return
    }
    let cancelled = false
    void api.codegraphStatusForPath(workingDirectory).then((result) => {
      if (!cancelled && mountedRef.current) setStatus(result)
    })
    return () => {
      cancelled = true
    }
  }, [workingDirectory])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const build = useCallback(async () => {
    if (!workingDirectory || building) return
    setBuilding(true)
    try {
      const result = await api.codegraphRebuildForPath(workingDirectory)
      if (mountedRef.current) setStatus(result)
    } catch (error) {
      console.warn('[useCodegraphStatus] build failed:', error)
    } finally {
      if (mountedRef.current) setBuilding(false)
    }
  }, [workingDirectory, building])

  return { status, building, build }
}
