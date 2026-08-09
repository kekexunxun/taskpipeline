import { AlertTriangleIcon, Code2Icon, SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function TopBar({
  onOpenSettings,
  credentialIssueCount = 0,
  onOpenCredentials
}: {
  onOpenSettings(): void
  /** 凭据检查失效项数量，>0 时展示常驻角标，点击回看弹窗。 */
  credentialIssueCount?: number
  onOpenCredentials?(): void
}) {
  return (
    <header className="window-drag flex items-center justify-between border-b bg-card/80 px-3 pl-[80px]">
      <div className="flex items-center gap-2 text-xs">
        <span className="grid size-6 place-items-center rounded-md border border-border bg-muted text-foreground">
          <Code2Icon size={13} />
        </span>
        <strong className="font-semibold">TaskPipeline</strong>
      </div>
      <div className="window-no-drag flex items-center gap-1">
        {credentialIssueCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="凭据异常"
                className="text-destructive hover:text-destructive"
                onClick={onOpenCredentials}
              >
                <AlertTriangleIcon size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{credentialIssueCount} 项凭据配置异常，点击查看详情</TooltipContent>
          </Tooltip>
        )}
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
