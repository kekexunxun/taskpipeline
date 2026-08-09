import { AlertCircleIcon, KeyRoundIcon, Loader2Icon } from 'lucide-react'
import type { CredentialCheckResult } from '@/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

/**
 * 凭据失效提示弹窗：进入系统时统一检查 Qoder / GitLab / Jira / Confluence 配置，
 * 发现失效项在此列出，用户可一键跳转系统设置对应 Tab 重新配置。
 */
export function CredentialCheckDialog({
  failures,
  pending,
  open,
  onOpenChange,
  onOpenSettings
}: {
  failures: CredentialCheckResult[]
  /** 仍在检查中的项，展示加载行，用户无需干等结果。 */
  pending: Array<Pick<CredentialCheckResult, 'key' | 'label'>>
  open: boolean
  onOpenChange(open: boolean): void
  onOpenSettings(failures: CredentialCheckResult[]): void
}) {
  const hasFailures = failures.length > 0
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[min(440px,calc(100vw-32px))] !max-w-[440px] gap-0 p-0">
        <DialogHeader className="space-y-1 border-b px-5 pt-4 pb-3">
          <DialogTitle className="flex items-center gap-1.5 text-sm">
            <KeyRoundIcon size={14} className="text-muted-foreground" />
            凭据检查提醒
          </DialogTitle>
          <DialogDescription>
            {hasFailures
              ? '以下配置项检查未通过，可能已过期或失效，请重新配置后使用相关功能。'
              : '正在检查各项配置凭据，可先关闭，出结果后另行通知。'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 px-5 py-4">
          {failures.map((item) => (
            <div
              key={item.key}
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5"
            >
              <AlertCircleIcon size={14} className="mt-0.5 shrink-0 text-destructive" />
              <div className="min-w-0 space-y-0.5">
                <div className="text-xs font-medium text-foreground">{item.label}</div>
                {item.message && (
                  <div className="text-[11px] leading-4 break-words text-muted-foreground">{item.message}</div>
                )}
              </div>
            </div>
          ))}
          {pending.map((item) => (
            <div key={item.key} className="flex items-center gap-2 rounded-md border px-3 py-2.5">
              <Loader2Icon size={14} className="shrink-0 animate-spin-slow text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{item.label} 检查中，可先关闭，出结果后另行通知</span>
            </div>
          ))}
        </div>
        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {hasFailures ? '忽略' : '知道了'}
          </Button>
          {hasFailures && (
            <Button size="sm" onClick={() => onOpenSettings(failures)}>
              前往设置
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
