import { useEffect } from 'react'
import { ShieldAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'

/**
 * 工具调用 HITL 确认请求（对话板块 / 任务板块共用协议形态）。
 * 字段与主进程 requestUi 事件对齐（main.ts onToolPermission / onPermissionRequest 的 payload）。
 */
export type ChatApprovalRequest = {
  id: string
  method: 'confirm' | 'select' | 'input' | 'editor'
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  timeout?: number
  conversationId?: string
  taskId?: string
}

/**
 * 工具调用 HITL 确认对话框（Dialog 风格）。
 *
 * 使用模态 Dialog 覆盖层展示确认请求，突出显示操作区域，
 * 用户必须明确选择允许/拒绝才能继续。
 * 响应走现有 respondTaskUi 通道（与 UiRequestDialog 同一协议）。
 */
export function ToolApprovalCard({
  approval,
  onRespond
}: {
  approval: ChatApprovalRequest
  onRespond(confirmed: boolean): void
}) {
  // 与主进程 requestUi 超时兜底对齐：超时未确认默认拒绝（主进程同样 resolve cancelled，
  // 重复响应幂等无副作用），对话框到时自动关闭。
  useEffect(() => {
    const timeout = approval.timeout
    if (!timeout || timeout <= 0) return
    const timer = setTimeout(() => onRespond(false), timeout)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval.id, approval.timeout])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onRespond(false)
      }}
    >
      <DialogContent className="max-w-md gap-0 p-0 sm:rounded-xl">
        {/* 顶部警示区 */}
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
            <ShieldAlertIcon size={18} className="text-amber-500" />
          </div>
          <DialogHeader className="flex-1 gap-0">
            <DialogTitle>{approval.title ?? '工具调用需要确认'}</DialogTitle>
            {approval.message && (
              <DialogDescription className="mt-1 line-clamp-3">{approval.message}</DialogDescription>
            )}
          </DialogHeader>
        </div>

        {/* 详情区（可滚动） */}
        {approval.message && (
          <div className="max-h-[30vh] overflow-y-auto px-5 py-3">
            <pre className="m-0 font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
              {approval.message}
            </pre>
          </div>
        )}

        {/* 操作区 */}
        <DialogFooter className="gap-2 border-t px-5 py-3 sm:justify-end">
          <Button variant="outline" size="sm" onClick={() => onRespond(false)} className="min-w-[72px]">
            拒绝
          </Button>
          <Button size="sm" onClick={() => onRespond(true)} className="min-w-[72px]">
            允许
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
