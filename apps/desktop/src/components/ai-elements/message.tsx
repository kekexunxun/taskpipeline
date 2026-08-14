'use client'

import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import type { UIMessage } from 'ai'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon } from 'lucide-react'
import type { ComponentProps, HTMLAttributes, ReactElement, ReactNode } from 'react'
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Components } from 'streamdown'
import { Streamdown } from 'streamdown'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage['role']
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full max-w-[95%] flex-col gap-2',
      from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
      className
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn('is-user:dark flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-sm', className)}
    {...props}
  >
    {children}
  </div>
)

export type MessageActionsProps = ComponentProps<'div'>

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn('flex items-center gap-1', className)} {...props}>
    {children}
  </div>
)

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string
  label?: string
}

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  )

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return button
}

export type MessageCopyButtonProps = ComponentProps<typeof MessageAction> & {
  /** 要复制到剪贴板的文本。 */
  text: string
  onCopy?: () => void
  onError?: (error: Error) => void
  /** 复制成功反馈的持续时间(ms)。 */
  timeout?: number
}

/**
 * 消息复制按钮 —— 复用 MessageAction 的图标按钮 + tooltip 容器,
 * 复制成功后短暂显示对勾反馈(与 ai-elements 其它复制按钮同一模式)。
 */
export const MessageCopyButton = ({
  text,
  onCopy,
  onError,
  timeout = 2000,
  tooltip = '复制消息',
  label = '复制消息',
  ...props
}: MessageCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<number>(0)

  const copyToClipboard = useCallback(async () => {
    if (typeof window === 'undefined' || !navigator?.clipboard?.writeText) {
      onError?.(new Error('Clipboard API not available'))
      return
    }
    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(text)
        setIsCopied(true)
        onCopy?.()
        timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout)
      }
    } catch (error) {
      onError?.(error as Error)
    }
  }, [text, onCopy, onError, timeout, isCopied])

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current)
    },
    []
  )

  const Icon = isCopied ? CheckIcon : CopyIcon

  return (
    <MessageAction tooltip={isCopied ? '已复制' : tooltip} label={label} onClick={copyToClipboard} {...props}>
      <Icon size={12} />
    </MessageAction>
  )
}

interface MessageBranchContextType {
  currentBranch: number
  totalBranches: number
  goToPrevious: () => void
  goToNext: () => void
  branches: ReactElement[]
  setBranches: (branches: ReactElement[]) => void
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(null)

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext)

  if (!context) {
    throw new Error('MessageBranch components must be used within MessageBranch')
  }

  return context
}

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number
  onBranchChange?: (branchIndex: number) => void
}

export const MessageBranch = ({ defaultBranch = 0, onBranchChange, className, ...props }: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch)
  const [branches, setBranches] = useState<ReactElement[]>([])

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch)
      onBranchChange?.(newBranch)
    },
    [onBranchChange]
  )

  const goToPrevious = useCallback(() => {
    const newBranch = currentBranch > 0 ? currentBranch - 1 : branches.length - 1
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const goToNext = useCallback(() => {
    const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  )

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div className={cn('grid w-full gap-2 [&>div]:pb-0', className)} {...props} />
    </MessageBranchContext.Provider>
  )
}

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>

export const MessageBranchContent = ({ children, ...props }: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch()
  const childrenArray = useMemo(() => (Array.isArray(children) ? children : [children]), [children])

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray)
    }
  }, [childrenArray, branches, setBranches])

  return childrenArray.map((branch, index) => (
    <div
      className={cn('grid gap-2 overflow-hidden [&>div]:pb-0', index === currentBranch ? 'block' : 'hidden')}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ))
}

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>

export const MessageBranchSelector = ({ className, ...props }: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch()

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null
  }

  return (
    <ButtonGroup
      className={cn('[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md', className)}
      orientation="horizontal"
      {...props}
    />
  )
}

export type MessageBranchPreviousProps = ComponentProps<typeof Button>

export const MessageBranchPrevious = ({ children, ...props }: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch()

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  )
}

export type MessageBranchNextProps = ComponentProps<typeof Button>

export const MessageBranchNext = ({ children, ...props }: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch()

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  )
}

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>

export const MessageBranchPage = ({ className, ...props }: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch()

  return (
    <ButtonGroupText
      className={cn('border-none bg-transparent text-muted-foreground shadow-none', className)}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  )
}

export type MessageResponseProps = ComponentProps<typeof Streamdown>

const streamdownPlugins = { cjk, code, math, mermaid }

/**
 * Streamdown 自定义代码块 —— Bash 终端风格 + 复制按钮。
 *
 * 通过覆盖 Streamdown 的 `pre` 元素实现，保留 shiki 语法高亮子节点，
 * 外层用终端卡片容器包裹，头部展示语言标签与复制按钮。
 */
function StreamdownCodeBlock({
  children,
  ...props
}: {
  children?: ReactNode
  className?: string
  [key: string]: unknown
}) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const timerRef = useRef<number>(0)

  // 语言检测：优先从 className (language-xxx) 提取，其次从 data-language
  const language =
    typeof props.className === 'string'
      ? (props.className.match(/language-(\w+)/) || [])[1] || ''
      : typeof props['data-language'] === 'string'
        ? props['data-language']
        : ''

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (copied) return
      const text = preRef.current?.textContent ?? ''
      if (!text || !navigator.clipboard) return
      await navigator.clipboard.writeText(text)
      setCopied(true)
      timerRef.current = window.setTimeout(() => setCopied(false), 2000)
    },
    [copied]
  )

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current)
    },
    []
  )

  const CopyIconEl = copied ? CheckIcon : CopyIcon

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-2 overflow-hidden rounded-md border border-border/40 bg-muted/20"
    >
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center justify-between bg-muted/30 px-3 py-1 transition-colors hover:bg-muted/40',
          open && 'border-b border-border/40'
        )}
      >
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/60">
          <ChevronRightIcon
            size={12}
            className={cn('text-muted-foreground/40 transition-transform', open && 'rotate-90')}
          />
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          disabled={copied}
          className={cn(
            'flex items-center rounded px-1 py-0.5 transition-colors',
            copied
              ? 'cursor-default text-emerald-500/80'
              : 'text-muted-foreground/50 hover:bg-muted/50 hover:text-muted-foreground'
          )}
        >
          <CopyIconEl size={12} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <pre
          ref={preRef}
          className="m-0 max-h-[400px] overflow-x-auto p-3 font-mono text-xs leading-relaxed text-foreground"
          {...props}
        >
          {children}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Streamdown 自定义表格 —— 直接渲染，无 Artifacts 包裹。
 */
function StreamdownTable({ children, ...props }: { children?: ReactNode; className?: string; [key: string]: unknown }) {
  return (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...props}>
        {children}
      </table>
    </div>
  )
}

const streamdownComponents: Components = {
  pre: StreamdownCodeBlock as unknown as Components['pre'],
  table: StreamdownTable as unknown as Components['table']
}

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      plugins={streamdownPlugins}
      components={streamdownComponents}
      controls={false}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children && nextProps.isAnimating === prevProps.isAnimating
)

MessageResponse.displayName = 'MessageResponse'

export type MessageToolbarProps = ComponentProps<'div'>

export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn('mt-4 flex w-full items-center justify-between gap-4', className)} {...props}>
    {children}
  </div>
)
