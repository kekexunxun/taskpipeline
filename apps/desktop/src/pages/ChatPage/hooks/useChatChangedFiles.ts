import { useState, useCallback, useEffect, useRef } from 'react'
import type { ChatChangedFile } from '@/api'
import { api } from '@/api'

/**
 * 对话级 Git 文件变更 hook。
 * 根据 workingDirectory 查询工作区 git status，支持手动刷新。
 * - workingDirectory 变化时自动重新查询
 * - 流式结束后（streaming false）自动刷新一次
 */
export function useChatChangedFiles(workingDirectory?: string, streaming?: boolean) {
  const [files, setFiles] = useState<ChatChangedFile[]>([])
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)

  const refresh = useCallback(async () => {
    if (!workingDirectory) {
      setFiles([])
      return
    }
    setLoading(true)
    try {
      const result = await api.getChatChangedFiles(workingDirectory)
      if (mountedRef.current) setFiles(result)
    } catch {
      if (mountedRef.current) setFiles([])
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [workingDirectory])

  // workingDirectory 变化时重新查询
  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  // 流式结束后自动刷新一次（AI 可能修改了文件）
  const prevStreaming = useRef(streaming)
  useEffect(() => {
    if (prevStreaming.current && !streaming) {
      void refresh()
    }
    prevStreaming.current = streaming
  }, [streaming, refresh])

  return { files, loading, refresh }
}
