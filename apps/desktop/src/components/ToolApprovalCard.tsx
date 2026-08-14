import { useEffect } from 'react'
import { ShieldAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

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
 * 工具调用 HITL 确认卡片（内联版，对话板块 / 任务板块共用）。
 *
 * 取代全局模态确认框：卡片渲染在触发工具调用的消息流底部，
 * 并行对话/任务各自展示自己的确认卡片，归属清晰、不打断阅读。
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
  // 重复响应幂等无副作用），卡片到时自动消失，避免"等待中"误导。
  useEffect(() => {
    const timeout = approval.timeout
    if (!timeout || timeout <= 0) return
    const timer = setTimeout(() => onRespond(false), timeout)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval.id, approval.timeout])

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3.5">
      <div className="flex items-start gap-2.5">
        <ShieldAlertIcon size={16} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{approval.title ?? '工具调用需要确认'}</p>
          {approval.message ? (
            <p className="mt-1 max-h-[30vh] overflow-auto text-xs leading-5 break-all whitespace-pre-wrap text-muted-foreground">
              {approval.message}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={() => onRespond(false)}>
          拒绝
        </Button>
        <Button size="sm" onClick={() => onRespond(true)}>
          允许
        </Button>
      </div>
    </div>
  )
}
