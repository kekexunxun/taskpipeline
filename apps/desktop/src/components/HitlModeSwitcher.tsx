import { useEffect, useState } from 'react'
import { Shield, ShieldAlert, ShieldCheck, Zap } from 'lucide-react'
import { api } from '@/api'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type HitlMode = 'ask' | 'auto' | 'yolo'

type HitlModeSwitcherProps = {
  className?: string
  /** 受控模式：外部传入当前值 */
  value?: HitlMode
  /** 受控模式：外部变更回调 */
  onChange?: (mode: HitlMode) => void
  /** 上下文类型：对话或任务（非受控模式下使用） */
  contextType?: 'conversation' | 'task'
  /** 上下文 ID（非受控模式下使用） */
  contextId?: string
}

const MODES = [
  {
    value: 'ask' as const,
    label: '询问',
    icon: Shield,
    summary: '所有写操作需确认',
    detail: '每次执行工具调用前都会弹窗请求确认',
    activeClass: 'bg-secondary text-foreground'
  },
  {
    value: 'auto' as const,
    label: '自动',
    icon: ShieldAlert,
    summary: '仅危险操作需确认',
    detail: '普通操作自动执行，删除/覆盖等危险操作仍需确认',
    activeClass: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  },
  {
    value: 'yolo' as const,
    label: 'YOLO',
    icon: Zap,
    summary: '自动批准所有操作',
    detail: '所有操作自动执行，不再弹出任何确认',
    activeClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
  }
] as const

export function HitlModeSwitcher({
  className,
  value: controlledValue,
  onChange,
  contextType,
  contextId
}: HitlModeSwitcherProps) {
  const isControlled = controlledValue !== undefined
  const [internalMode, setInternalMode] = useState<HitlMode>('ask')

  useEffect(() => {
    if (isControlled || contextType === 'task') return
    api
      .getHitlMode(contextType, contextId)
      .then(setInternalMode)
      .catch(() => {})
  }, [contextType, contextId, isControlled])

  const mode = isControlled ? controlledValue : internalMode

  // 任务执行期不再有「询问 / 自动 / YOLO」三态（§4.2）：旧实现里 `ask` 与 `auto` 对任务是同一个行为，
  // 而真正的拦断已经下沉到 core 的 L1（越界写 / 破坏性命令 / 敏感路径），提交动作则由任务的 MR 档决定。
  // 所以这里只作只读说明——一个切不动的三态控件比没有控件更容易让人误解。
  if (contextType === 'task') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn('inline-flex items-center gap-1 px-1 text-[11px] text-muted-foreground', className)}>
            <ShieldCheck className="size-2.5" />
            任务执行仅拦「越界写 / 破坏性命令」，提交动作看任务的 MR 档
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="max-w-56">
          <p className="font-medium">固定链路的执行期权限</p>
          <p className="mt-0.5 text-[11px] opacity-70">
            越出本任务工作区的写入与破坏性命令始终拦下；其余工具调用自动执行；commit / push / 建 MR 是否自动由任务的
            「Review 通过后」提交档决定。
          </p>
        </TooltipContent>
      </Tooltip>
    )
  }

  const handleChange = async (newMode: string) => {
    if (newMode === mode) return
    const next = newMode as HitlMode
    if (isControlled) {
      onChange?.(next)
    } else {
      setInternalMode(next)
      await api.setHitlMode(next, contextType, contextId)
    }
  }

  return (
    <Tabs value={mode} onValueChange={handleChange} className={className}>
      <TabsList className="h-auto gap-0.5 bg-muted/60 p-0.5">
        {MODES.map((m) => {
          const Icon = m.icon
          const active = mode === m.value
          return (
            <Tooltip key={m.value}>
              <TooltipTrigger asChild>
                <TabsTrigger
                  value={m.value}
                  className={cn(
                    'gap-1 rounded-[4px] px-2 py-0.5 text-[11px]! font-medium transition-all duration-150',
                    'data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-foreground/70',
                    active && m.activeClass
                  )}
                >
                  <Icon className="size-2.5" />
                  {m.label}
                </TabsTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6} className="max-w-56 text-center">
                <p className="font-medium">{m.summary}</p>
                <p className="mt-0.5 text-[11px] opacity-70">{m.detail}</p>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </TabsList>
    </Tabs>
  )
}
