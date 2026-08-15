import { DownloadIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react'
import { useAutoUpdate } from '../hooks/useAutoUpdate'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * 顶栏自动更新指示器。
 * - 发现新版本：显示下载图标，点击开始下载
 * - 下载中：显示进度百分比 + 旋转动画
 * - 下载完成：显示重启图标，点击安装并重启
 * - 检查中/无更新/错误：不显示（静默处理）
 */
export function UpdateIndicator() {
  const { status, downloadUpdate, installUpdate } = useAutoUpdate()

  if (status.state === 'available') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="下载更新" className="text-blue-400" onClick={downloadUpdate}>
            <DownloadIcon size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>发现新版本 v{status.version}，点击下载</TooltipContent>
      </Tooltip>
    )
  }

  if (status.state === 'downloading') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="正在下载更新" className="relative">
            <Loader2Icon size={14} className="animate-spin text-blue-400" />
            <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] font-medium text-blue-400">
              {status.progress}%
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          正在下载 v{status.version}… {status.progress}%
        </TooltipContent>
      </Tooltip>
    )
  }

  if (status.state === 'downloaded') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="重启并更新"
            className="text-emerald-400"
            onClick={installUpdate}
          >
            <RefreshCwIcon size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>更新已就绪，点击重启应用 v{status.version}</TooltipContent>
      </Tooltip>
    )
  }

  // checking / not-available / error 均不显示 UI
  return null
}
