import { useEffect, type ReactNode } from 'react'
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController
} from '@/components/ai-elements/prompt-input'
import { Attachment, AttachmentPreview, AttachmentRemove, Attachments } from '@/components/ai-elements/attachments'
import { HitlModeSwitcher } from '@/components/HitlModeSwitcher'
import { cn } from '@/lib/utils'
import type { UserFileAttachment } from '@/api'
import { api } from '@/api'

type Props = {
  value: string
  onChange(value: string): void
  onSend(value?: string, files?: UserFileAttachment[]): void
  onStop?(): void
  disabled?: boolean
  streaming?: boolean
  submitting?: boolean
  placeholder?: string
  leftSlot?: ReactNode
  rightSlot?: ReactNode
  className?: string
  /** 是否显示 HITL 模式切换器，默认 true */
  showHitlMode?: boolean
  /** HITL 模式上下文类型（对话或任务） */
  hitlContextType?: 'conversation' | 'task'
  /** HITL 模式上下文 ID（对话 ID 或任务 ID） */
  hitlContextId?: string
  /** 当前模型是否支持视觉/多模态输入（控制附件入口显隐）。 */
  modelSupportsVision?: boolean
  /** 当前对话 id（附件缓存用）。未创建对话时为 undefined，此时不允许添加附件。 */
  chatId?: string
}

function Controlled({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  streaming,
  submitting,
  placeholder,
  leftSlot,
  rightSlot,
  className,
  showHitlMode = true,
  hitlContextType,
  hitlContextId,
  modelSupportsVision,
  chatId
}: Props) {
  const controller = usePromptInputController()

  // 外部受控 value 变化时同步到内部状态
  useEffect(() => {
    if (controller.textInput.value !== value) controller.textInput.setInput(value)
  }, [controller, value])

  const trimmed = value.trim()
  const busy = streaming || submitting
  const hasAttachments = controller.attachments.files.length > 0
  const canSend = !disabled && !busy && (trimmed.length > 0 || hasAttachments)
  const showStop = streaming && onStop
  const defaultPlaceholder = disabled
    ? '等待执行器就绪'
    : submitting
      ? '正在提交…'
      : streaming
        ? '正在生成回复…'
        : '输入消息，Enter 发送，Shift+Enter 换行'

  /** 把渲染进程 blob URL 附件写入主进程本地缓存，返回 UserFileAttachment[]。 */
  const saveAttachmentsToCache = async (): Promise<UserFileAttachment[]> => {
    if (!chatId) return []
    const result: UserFileAttachment[] = []
    for (const file of controller.attachments.files) {
      if (!file.url) continue
      try {
        const response = await fetch(file.url)
        const blob = await response.blob()
        const buffer = await blob.arrayBuffer()
        const saved = await api.saveChatAttachment(chatId, buffer, file.filename ?? 'attachment', file.mediaType)
        result.push(saved)
      } catch {
        // 单个附件失败不阻塞其它附件
      }
    }
    return result
  }

  const handleSend = async () => {
    if (disabled || busy) return
    const payload = (controller.textInput.value || '').trim()
    if (!payload && !hasAttachments) return
    const cachedFiles = hasAttachments ? await saveAttachmentsToCache() : undefined
    onChange('')
    controller.attachments.clear()
    onSend(payload || value, cachedFiles?.length ? cachedFiles : undefined)
  }

  return (
    <div className="flex flex-col gap-1.5">
      {showHitlMode && (
        <div className="flex justify-start px-1">
          <HitlModeSwitcher contextType={hitlContextType} contextId={hitlContextId} />
        </div>
      )}
      <PromptInput
        accept={modelSupportsVision ? 'image/*' : undefined}
        multiple={modelSupportsVision}
        className={cn(
          'w-full rounded-lg border border-border/60 bg-card/60 transition-colors focus-within:border-border/60',
          (disabled || busy) && 'opacity-90',
          className
        )}
        onSubmit={async ({ text }) => {
          const payload = text.trim()
          if (!payload && !hasAttachments) return
          if (disabled || busy) return
          const cachedFiles = hasAttachments ? await saveAttachmentsToCache() : undefined
          onChange('')
          onSend(payload, cachedFiles?.length ? cachedFiles : undefined)
        }}
      >
        {/* 附件预览区 */}
        {hasAttachments && modelSupportsVision && (
          <Attachments className="self-start px-3 pt-2">
            {controller.attachments.files.map((file) => (
              <Attachment key={file.id} data={file} onRemove={() => controller.attachments.remove(file.id)}>
                <AttachmentPreview />
                <AttachmentRemove label="删除" />
              </Attachment>
            ))}
          </Attachments>
        )}
        <PromptInputTextarea
          data-testid="chat-composer"
          className="max-h-52 min-h-10 px-3 py-2 text-xs! leading-5 placeholder:text-muted-foreground"
          disabled={disabled || busy}
          placeholder={placeholder ?? defaultPlaceholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (canSend) void handleSend()
            }
          }}
        />
        <PromptInputFooter className="min-h-7 gap-2 px-2 pt-1 pb-1.5">
          <PromptInputTools className="min-w-0 gap-1 overflow-visible">
            {leftSlot}
            {/* 附件按钮：仅模型支持视觉时显示 */}
            {modelSupportsVision && chatId && (
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger className="h-6 w-6" />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments label="添加图片" />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            )}
          </PromptInputTools>
          {rightSlot ?? (
            <PromptInputSubmit
              aria-label={showStop ? '停止执行' : submitting ? '正在提交' : '发送'}
              disabled={showStop ? false : !canSend}
              status={showStop ? 'streaming' : submitting ? 'submitted' : undefined}
              onStop={onStop}
            />
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}

/**
 * 统一 Prompt 组件：被 ChatPage 与 CodingPage 复用。
 * - leftSlot: 工具栏左侧的额外控件（如模型选择器）。
 * - disabled: 禁止输入与发送。
 * - streaming: 流式生成中（显示「停止」按钮）。
 * - modelSupportsVision: 当前模型支持视觉/多模态时显示附件入口。
 *
 * 实现：直接基于 ai-elements 的 `<PromptInput>` / `<PromptInputTextarea>` 等原子组件，
 * 通过 `<PromptInputProvider>` 暴露受控 value，统一由 Composer 内部承担 Enter 发送 / Shift+Enter 换行。
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  streaming,
  submitting,
  placeholder,
  leftSlot,
  rightSlot,
  className,
  showHitlMode,
  hitlContextType,
  hitlContextId,
  modelSupportsVision,
  chatId
}: Props) {
  return (
    <PromptInputProvider initialInput={value}>
      <Controlled
        value={value}
        onChange={onChange}
        onSend={onSend}
        onStop={onStop}
        disabled={disabled}
        streaming={streaming}
        submitting={submitting}
        placeholder={placeholder}
        leftSlot={leftSlot}
        rightSlot={rightSlot}
        className={className}
        showHitlMode={showHitlMode}
        hitlContextType={hitlContextType}
        hitlContextId={hitlContextId}
        modelSupportsVision={modelSupportsVision}
        chatId={chatId}
      />
    </PromptInputProvider>
  )
}
