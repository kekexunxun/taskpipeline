import { useCallback, useEffect, useState } from 'react'
import { api, type UpdateStatus } from '../api'

/**
 * 自动更新状态 Hook。
 * - 应用启动时监听主进程推送的更新状态
 * - 提供手动检查更新、下载、安装方法
 */
export function useAutoUpdate() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'checking' })

  useEffect(() => {
    // 获取当前状态快照
    void api
      .getUpdateStatus()
      .then(setStatus)
      .catch(() => undefined)
    // 监听后续状态变更
    const unsubscribe = api.onUpdateStatus(setStatus)
    return unsubscribe
  }, [])

  const checkForUpdate = useCallback(() => {
    void api.checkForUpdate()
  }, [])

  const downloadUpdate = useCallback(() => {
    void api.downloadUpdate()
  }, [])

  const installUpdate = useCallback(() => {
    void api.installUpdate()
  }, [])

  return { status, checkForUpdate, downloadUpdate, installUpdate }
}
