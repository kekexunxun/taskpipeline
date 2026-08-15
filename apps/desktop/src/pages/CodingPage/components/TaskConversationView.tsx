import { BotIcon, Loader2Icon } from 'lucide-react'
import { PartRenderer } from '../../ChatPage/drivers/PartRenderer'
import type { DriverPart } from '@/api'

/**
 * 任务执行对话视图 —— 直接复用 ChatPage 的 PartRenderer 渲染链路。
 *
 * 数据由 useTasks 以 DriverPart[] 形态提供（历史 events 一次性转换 + 流式 live parts），
 * 本组件不做任何数据转换，只负责布局：
 * - PartRenderer 输出为执行内容（markdown + 工具行 + 子任务卡）
 * - 空状态占位 + live 指示器
 */
export function TaskConversationView({ parts, live }: { parts: DriverPart[]; live?: boolean }) {
  if (parts.length === 0) {
    return (
      <div className="flex min-h-44 flex-col items-center justify-center gap-2 text-muted-foreground">
        <BotIcon size={24} />
        <strong className="text-xs">暂无执行记录</strong>
      </div>
    )
  }

  return (
    <div className="px-5 py-4 pb-16">
      <PartRenderer parts={parts} isStreaming={live} />

      {/* live 指示器 */}
      {live && (
        <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
          <span>正在处理...</span>
        </div>
      )}
    </div>
  )
}
