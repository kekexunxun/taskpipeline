import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  Code2Icon,
  KeyRoundIcon,
  Loader2Icon,
  MoonIcon,
  RefreshCwIcon,
  SettingsIcon,
  SunIcon
} from 'lucide-react'
import type { CredentialState } from '../api'
import { useCredentialStatusContext } from '../hooks/useCredentialStatusContext'
import type { CredentialOverall } from '../hooks/useCredentialStatus'
import { useTheme } from '@/hooks/useTheme'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** 指示灯圆点配色：红=有异常；绿=全部通过；灰=未配置；脉冲=探测中。 */
const OVERALL_DOT_CLASS: Record<CredentialOverall, string> = {
  red: 'bg-destructive',
  green: 'bg-emerald-500',
  gray: 'bg-muted-foreground/50',
  checking: 'animate-pulse bg-muted-foreground'
}

const OVERALL_TOOLTIP: Record<CredentialOverall, string> = {
  red: '存在凭据异常，点击查看详情',
  green: '凭据检查全部通过',
  gray: '凭据未配置',
  checking: '正在检查凭据'
}

/** checkedAt → 相对时间（刚刚 / N 分钟前 / N 小时前）。 */
function formatCheckedAt(checkedAt?: number): string {
  if (!checkedAt) return ''
  const diff = Date.now() - checkedAt
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return `${Math.floor(diff / 3_600_000)} 小时前`
}

/** 单项状态图标：与顶栏聚合态同色系。 */
function CredentialItemIcon({ status }: { status: CredentialState['status'] }) {
  if (status === 'ok') return <CheckCircle2Icon size={14} className="shrink-0 text-emerald-500" />
  if (status === 'failed') return <AlertCircleIcon size={14} className="shrink-0 text-destructive" />
  if (status === 'checking')
    return <Loader2Icon size={14} className="shrink-0 animate-spin-slow text-muted-foreground" />
  return <CircleDashedIcon size={14} className="shrink-0 text-muted-foreground" />
}

/**
 * 凭据状态 Popover：四项凭据各自的状态 / 失败原因 / 检查时间，
 * 底部提供「重新检查」，failed 项可跳转设置对应 Tab。
 */
function CredentialStatusPopover({
  onOpenCredentialSettings
}: {
  onOpenCredentialSettings(failures: CredentialState[]): void
}) {
  const { items, overall, recheck } = useCredentialStatusContext()
  const failedCount = items.filter((item) => item.status === 'failed').length
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="凭据状态" className="relative">
              <span className={cn('block size-2 rounded-full', OVERALL_DOT_CLASS[overall])} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {failedCount > 0 ? `${failedCount} 项凭据异常，点击查看详情` : OVERALL_TOOLTIP[overall]}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <div className="flex items-center gap-1.5 border-b px-4 py-2.5 text-xs font-medium">
          <KeyRoundIcon size={13} className="text-muted-foreground" />
          凭据状态
        </div>
        <div className="space-y-1 px-3 py-2">
          {items.map((item) => (
            <div key={item.key} className="rounded-md px-2 py-1.5 hover:bg-muted/60">
              <div className="flex items-center gap-2">
                <CredentialItemIcon status={item.status} />
                <span className="text-xs font-medium">{item.label}</span>
                {item.checkedAt && item.status !== 'checking' && (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {formatCheckedAt(item.checkedAt)}
                  </span>
                )}
              </div>
              {item.message && (
                <div className="mt-0.5 pl-6 text-[11px] leading-4 break-words text-muted-foreground">
                  {item.message}
                </div>
              )}
              {item.status === 'failed' && (
                <div className="mt-1 pl-6">
                  <Button size="sm" variant="ghost" onClick={() => onOpenCredentialSettings([item])}>
                    前往设置
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="border-t px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={overall === 'checking'}
            onClick={() => void recheck()}
          >
            <RefreshCwIcon size={12} className={overall === 'checking' ? 'animate-spin-slow' : undefined} />
            {overall === 'checking' ? '检查中…' : '重新检查'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function TopBar({
  onOpenSettings,
  onOpenCredentialSettings
}: {
  onOpenSettings(): void
  /** 凭据失败项跳转设置对应 Tab。 */
  onOpenCredentialSettings(failures: CredentialState[]): void
}) {
  const { theme, toggleTheme } = useTheme()
  return (
    <header className="window-drag flex items-center justify-between border-b bg-card/80 px-3 pl-[80px]">
      <div className="flex items-center gap-2 text-xs">
        <span className="grid size-6 place-items-center rounded-md border border-border bg-muted text-foreground">
          <Code2Icon size={13} />
        </span>
        <strong className="font-semibold">TaskPipeline</strong>
      </div>
      <div className="window-no-drag flex items-center gap-1">
        <CredentialStatusPopover onOpenCredentialSettings={onOpenCredentialSettings} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <SunIcon size={14} /> : <MoonIcon size={14} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{theme === 'dark' ? '切换到亮色' : '切换到暗色'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="设置" onClick={onOpenSettings}>
              <SettingsIcon size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>设置</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
