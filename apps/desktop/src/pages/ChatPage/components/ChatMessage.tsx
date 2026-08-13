import { ArrowRightIcon, BotIcon, Loader2Icon, UserIcon } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { QoderMessageView } from '../drivers/QoderMessageView'
import { OpenAIMessageView } from '../drivers/OpenAIMessageView'
import { MessageCopyButton } from '@/components/ai-elements/message'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ChatDriverId, ChatMessage } from '@/api'
import { cn } from '@/lib/utils'

/**
 * 顶层消息视图 —— 共享的元信息 (header / user bubble / task creation action) 在这里;
 * 真正按 part 渲染的内容交给 driver 专属的 `*MessageView` 组件。
 *
 * 路由规则:
 *  - `message.driverId === "qoder"` → `QoderMessageView`
 *  - `message.driverId === "openai"` → `OpenAIMessageView`
 *  - 用户消息 (`role === "user"`) → 不分 driver,统一走文本气泡(对齐右,纯文本)
 */
function ChatMessageImpl({
  message,
  isAnimating,
  hint,
  onExecuteJira
}: {
  message: ChatMessage
  isAnimating?: boolean
  /** 阶段提示（关键词提取/记忆检索中…）：优先于默认思考文案展示在 pending 占位里。 */
  hint?: string
  onExecuteJira?(taskKey: string): Promise<void>
}) {
  const [executing, setExecuting] = useState(false)
  const isUser = message.role === 'user'
  const time = useMemo(
    () => formatTime(message.metadata?.createdAt ?? message.createdAt),
    [message.metadata?.createdAt, message.createdAt]
  )
  // 消息级复制:拼接全部 text part(助手正文 / 用户气泡都是 text part),不含思考过程与工具调用。
  const messageText = useMemo(
    () =>
      message.parts
        .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    [message.parts]
  )
  const metaStatus = message.metadata?.status
  const isAborted = metaStatus === 'aborted'
  // 双通道:流期间异常挂在 metadata(不持久化),历史消息读落盘的 errorMessage。
  const errorMessage = message.metadata?.errorMessage ?? message.errorMessage
  const isError = metaStatus === 'error' || Boolean(errorMessage)
  const isStreaming = Boolean(isAnimating) && !isAborted && !isError
  const taskCreation = message.metadata?.taskCreation
  const taskKey = taskCreation?.externalKey
  const taskBackend = taskCreation?.backend
  const containerClass = isUser ? 'justify-end' : 'justify-start'
  // 助手消息占满可用宽度(正文/折叠块不再按内容收缩,避免"收起窄、展开宽"的跳动);
  // 用户消息保留气泡式 max-width。
  const widthClass = isUser ? 'max-w-[78%]' : 'max-w-[78%]'
  const alignClass = isUser ? 'items-end' : 'items-start'
  // 消息级操作区(shadcn MessageFooter 语义):置于消息内容下方、与消息同侧对齐。
  // 只有该消息存在可复制的正文文本时才渲染；输出(streaming)期间不展示，避免遮挡正在生成的内容。
  const copyAction =
    messageText && !isStreaming ? (
      <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
        <MessageCopyButton text={messageText} aria-label="复制消息" />
      </div>
    ) : null

  return (
    <div className={cn('flex w-full', containerClass)} data-role={message.role} data-driver-id={message.driverId}>
      <div className={cn('flex min-w-0 flex-col gap-1.5', alignClass, widthClass)}>
        <div
          className={cn(
            'flex items-center gap-1.5 text-[11px] text-muted-foreground',
            isUser ? 'flex-row-reverse' : 'flex-row'
          )}
        >
          {!isUser && (
            <span aria-hidden className="grid size-4 place-items-center rounded-md bg-muted text-muted-foreground">
              <BotIcon size={10} />
            </span>
          )}
          <strong className="font-semibold text-foreground/80">{isUser ? '你' : driverLabel(message.driverId)}</strong>
          {time && <time className="font-mono text-[10px]">{time}</time>}
          {isAborted && <Badge variant="muted">已停止</Badge>}
          {isError && <Badge variant="destructive">失败</Badge>}
          {isUser && (
            <span aria-hidden className="grid size-4 place-items-center rounded-md bg-primary/15 text-primary">
              <UserIcon size={10} />
            </span>
          )}
        </div>
        {isUser ? (
          <>
            <UserBubble message={message} />
            {copyAction}
          </>
        ) : (
          <>
            {isStreaming && message.parts.length === 0 ? (
              <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/30 px-3.5 py-2.5 text-xs text-muted-foreground">
                <Loader2Icon className="animate-spin-slow" size={12} />
                {hint ?? `${driverLabel(message.driverId)} 正在思考…`}
              </div>
            ) : (
              <>
                {/* 失败前已有产出(thinking / 正文 / 工具调用)时照常渲染,错误块追加在下方,
                    不再用错误块整体替换正文(Qoder 中途失败时避免"界面没有任何展示")。 */}
                {message.parts.length > 0 && <DriverMessageBody message={message} isAnimating={isStreaming} />}
                {isError && (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-xs leading-5 break-words whitespace-pre-wrap text-destructive">
                    {errorMessage ?? '模型返回异常，请稍后重试'}
                  </div>
                )}
              </>
            )}
            {copyAction}
            {taskCreation && taskKey && (
              <div className="flex w-full flex-wrap items-center gap-2 border-l-2 border-primary/50 pl-3 text-xs">
                <span className="font-mono font-semibold text-foreground">{taskKey}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {taskCreation.issueType} · {taskCreation.summary}
                </span>
                {onExecuteJira && taskBackend === 'jira' && (
                  <Button
                    size="sm"
                    className="h-6 shrink-0"
                    disabled={executing}
                    onClick={async () => {
                      setExecuting(true)
                      try {
                        await onExecuteJira(taskKey)
                      } catch {
                        /* 全局反馈已展示导入失败原因。 */
                      } finally {
                        setExecuting(false)
                      }
                    }}
                  >
                    {executing ? <Loader2Icon className="animate-spin-slow" size={11} /> : <ArrowRightIcon size={11} />}
                    立即执行
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 用户消息气泡(纯文本,不分 driver)。从 parts 抽出所有 text 拼起来。
 */
function UserBubble({ message }: { message: ChatMessage }) {
  const text = useMemo(
    () =>
      message.parts
        .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    [message.parts]
  )
  return (
    <div className="max-w-full rounded-2xl rounded-tr-sm border border-border/40 bg-secondary px-3.5 py-2 text-sm leading-6 break-words whitespace-pre-wrap text-foreground">
      {text}
    </div>
  )
}

/**
 * 助手消息正文 —— 按 `driverId` 路由到 driver 专属视图。
 */
function DriverMessageBody({ message, isAnimating }: { message: ChatMessage; isAnimating?: boolean }) {
  if (message.driverId === 'qoder') {
    return <QoderMessageView message={message} isAnimating={isAnimating} />
  }
  if (message.driverId === 'openai') {
    return <OpenAIMessageView message={message} isAnimating={isAnimating} />
  }
  // 未知 driver 兜底:把 parts 走 PartRenderer 的 fallback 分支
  return (
    <div className="rounded border border-dashed border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      未识别的 driver: {message.driverId}
    </div>
  )
}

function driverLabel(id: ChatDriverId): string {
  if (id === 'qoder') return 'Qoder Agent'
  if (id === 'openai') return 'OpenAI'
  return 'Agent'
}

function formatTime(value: string | number | Date | undefined): string | undefined {
  if (!value) return undefined
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

export const ChatMessageView = memo(ChatMessageImpl)
