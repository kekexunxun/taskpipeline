import { ChevronRightIcon, Loader2Icon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

/**
 * 折叠式 thinking / reasoning 块(对话 / 执行面板 / Trace 三界面共用)。
 *
 * 设计:
 * - 收起态显示"思考中 - n秒" / "深度思考 - n秒",紧凑不占空间
 * - 鼠标悬停时右侧出现箭头指示可展开
 * - 展开后内容区文字浅色、低透明度,限高可滚动
 * - 默认折叠,用户手动操作后以用户选择为准
 *
 * 耗时计算:
 * - 通过检测 text 变化来判定思考是否仍在进行(而非依赖消息级 isStreaming),
 *   思考文本停止增长 1.5s 后冻结耗时,避免计时器空转。
 * - 历史消息(非流式挂载)根据文本长度估算耗时。
 */
export function ThinkingBlock({
  text,
  isStreaming
}: {
  text: string
  /** 是否处于流式输出中(影响默认展开态与文案)。 */
  isStreaming?: boolean
}) {
  // 用户的点击一旦发生(非 null)就以用户选择为准,默认始终折叠。
  const [userOpen, setUserOpen] = useState<null | boolean>(null)
  const open = userOpen ?? false

  // ── 思考耗时计算 ──────────────────────────────────────────────────
  // 核心思路:不依赖消息级 isStreaming(它在整条消息完成前一直为 true),
  // 而是追踪 text 最后一次增长的时间,稳定 1.5s 后冻结耗时。
  const [duration, setDuration] = useState(0)
  const startTimeRef = useRef<number>(0)
  const lastTextLenRef = useRef<number>(0)
  const frozenRef = useRef(false)

  // text 变化时重置"静止计时器"
  useEffect(() => {
    if (frozenRef.current) return
    if (text.length === 0) return
    // 首次见到文本,记录起始时间
    if (startTimeRef.current === 0) {
      startTimeRef.current = Date.now()
    }
    lastTextLenRef.current = text.length
    // 更新显示耗时
    setDuration(Math.max(1, Math.floor((Date.now() - startTimeRef.current) / 1000)))
  }, [text])

  // 流式期间每秒刷新显示耗时(冻结判定由下方 stabilization effect 负责)
  useEffect(() => {
    if (!isStreaming || frozenRef.current) return
    const id = setInterval(() => {
      if (frozenRef.current) return
      if (startTimeRef.current > 0) {
        setDuration(Math.max(1, Math.floor((Date.now() - startTimeRef.current) / 1000)))
      }
    }, 1000)
    return () => clearInterval(id)
  }, [isStreaming])

  // 检测文本稳定 → 冻结(独立 effect,避免与 interval 耦合)
  useEffect(() => {
    if (!isStreaming || frozenRef.current || text.length === 0) return
    const timer = setTimeout(() => {
      // 1.5s 内 text 没有再变化 → 思考结束
      if (!frozenRef.current && lastTextLenRef.current === text.length) {
        frozenRef.current = true
        setDuration(Math.max(1, Math.floor((Date.now() - startTimeRef.current) / 1000)))
      }
    }, 1500)
    return () => clearTimeout(timer)
  }, [text, isStreaming])

  // 流结束后确保冻结(兜底)
  useEffect(() => {
    if (!isStreaming && !frozenRef.current && startTimeRef.current > 0) {
      frozenRef.current = true
      setDuration(Math.max(1, Math.floor((Date.now() - startTimeRef.current) / 1000)))
    }
  }, [isStreaming])

  // 历史消息(非流式 + 有文本 + 从未计时):按文本长度估算
  useEffect(() => {
    if (!isStreaming && text.length > 0 && startTimeRef.current === 0) {
      // LLM 思考文本大约 30-80 字符/秒,取中值 ~50
      const estimated = Math.max(1, Math.round(text.length / 50))
      setDuration(estimated)
      frozenRef.current = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const isThinkingActive = isStreaming && !frozenRef.current
  const label = isThinkingActive ? `思考中 - ${duration}秒` : `深度思考 - ${duration}秒`

  const handleOpenChange = useCallback((next: boolean) => setUserOpen(next), [])

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} className="not-prose w-full">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground">
        {isThinkingActive && <Loader2Icon size={13} className="shrink-0 animate-spin text-muted-foreground/50" />}
        <span className="text-xs">{label}</span>
        <ChevronRightIcon
          size={14}
          className={cn(
            'shrink-0 text-muted-foreground/40 transition-all',
            'opacity-0 group-hover:opacity-100',
            open && 'rotate-90 opacity-100'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="rounded-md bg-muted/30 py-2 pr-3 pl-5">
          <div className="max-h-[120px] overflow-y-auto">
            <pre className="m-0 font-sans text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground/50">
              {text}
            </pre>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
