import { ShieldAlertIcon, CheckIcon, XIcon } from 'lucide-react'
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
  /** 工具名称（用于专用卡片渲染） */
  toolName?: string
  /** 工具输入参数（用于专用卡片渲染） */
  toolInput?: Record<string, unknown>
}

/**
 * 工具调用 HITL 确认卡片（内联卡片风格）。
 *
 * 以对话流内联卡片形式展示确认请求，不阻断用户操作，
 * 用户可在对话流中直接允许/拒绝。
 * 响应走现有 respondTaskUi 通道（与 UiRequestDialog 同一协议）。
 *
 * 只显示操作按钮，工具详情在消息流中已展示，避免重复渲染。
 */
export function ToolApprovalCard({
  approval,
  onRespond,
  widthClass = 'w-[78%]'
}: {
  approval: ChatApprovalRequest
  onRespond(confirmed: boolean): void
  /** 宽度 class，默认 'w-[78%]' 与消息气泡对齐 */
  widthClass?: string
}) {
  // 简洁操作条：只显示工具名 + 确认/取消按钮
  return (
    <div
      className={`flex ${widthClass} items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2`}
    >
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <ShieldAlertIcon size={14} className="shrink-0 text-amber-500" />
        <span className="truncate font-medium">{approval.title ?? '需要确认'}</span>
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRespond(false)}
          className="h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive"
        >
          <XIcon size={12} className="mr-1" />
          拒绝
        </Button>
        <Button size="sm" onClick={() => onRespond(true)} className="h-7 px-2.5 text-xs">
          <CheckIcon size={12} className="mr-1" />
          允许
        </Button>
      </div>
    </div>
  )
}
