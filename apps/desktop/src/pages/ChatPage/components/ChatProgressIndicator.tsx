import { useCallback, useEffect, useState } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { cn } from '@/lib/utils'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

interface ChatProgressIndicatorProps {
  /** 总轮次数（一轮 = user + agent） */
  turnCount: number
  /** 每轮用户消息文本 */
  turnUserMessages: Map<number, string>
}

/**
 * 对话右侧进度条 —— 每一轮对话一条小横杠，hover 时产生「变焦」放大效果，
 * 悬停进度条区域时弹出卡片展示每轮用户消息摘要，hover 某行用 Popover 展示全文。
 */
export function ChatProgressIndicator({ turnCount, turnUserMessages }: ChatProgressIndicatorProps) {
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null)
  const [activeTurn, setActiveTurn] = useState(0)
  const [popoverTurn, setPopoverTurn] = useState<number | null>(null)
  const { scrollRef } = useStickToBottomContext()

  /* ---- 滚动时追踪当前可见轮次 ---- */
  useEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl || turnCount === 0) return

    const handleScroll = () => {
      const elements = scrollEl.querySelectorAll<HTMLElement>('[data-turn-index]')
      if (elements.length === 0) return

      const containerTop = scrollEl.getBoundingClientRect().top
      let current = 0
      for (const el of elements) {
        if (el.getBoundingClientRect().top <= containerTop + 120) {
          current = Number(el.dataset.turnIndex) || 0
        }
      }
      setActiveTurn(current)
    }

    handleScroll()
    scrollEl.addEventListener('scroll', handleScroll, { passive: true })
    return () => scrollEl.removeEventListener('scroll', handleScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnCount])

  /* ---- 点击跳转 ---- */
  const scrollToTurn = useCallback((turnIdx: number) => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const target = scrollEl.querySelector<HTMLElement>(`[data-turn-index="${turnIdx}"]`)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAreaLeave = useCallback(() => {
    setHoveredTurn(null)
    setPopoverTurn(null)
  }, [])

  // 卡片高亮项：hover 时跟随 hoveredTurn，否则跟随滚动位置 activeTurn
  const highlightTurn = hoveredTurn ?? activeTurn

  if (turnCount <= 1) return null

  return (
    <div
      className="absolute top-0 right-0 bottom-0 z-10 hidden min-[1100px]:flex"
      style={{ width: '280px' }}
      onMouseLeave={handleAreaLeave}
    >
      {/* ---- 卡片：hover 进度条区域时展示（自动高度） ---- */}
      <div
        className={cn(
          'absolute top-5 right-7 max-h-[80vh] w-60 overflow-hidden rounded-lg border border-border/50 bg-background shadow-[0_4px_24px_rgba(0,0,0,0.08)] transition-all duration-200',
          hoveredTurn != null ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-2 opacity-0'
        )}
      >
        <div className="flex flex-col overflow-y-auto p-2">
          {Array.from({ length: turnCount }, (_, i) => {
            const text = turnUserMessages.get(i) ?? ''
            const isHighlight = i === highlightTurn
            const isPopoverOpen = i === popoverTurn

            return (
              <Popover key={i} open={isPopoverOpen} onOpenChange={(open) => !open && setPopoverTurn(null)}>
                <PopoverAnchor asChild>
                  <div
                    role="button"
                    tabIndex={0}
                    className={cn(
                      'group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors duration-150',
                      isHighlight ? 'bg-muted/80' : 'hover:bg-muted/50'
                    )}
                    onMouseEnter={() => setPopoverTurn(i)}
                    onClick={() => scrollToTurn(i)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        scrollToTurn(i)
                      }
                    }}
                  >
                    {/* 左侧：轮次序号 */}
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    {/* 中间：截断的用户消息 */}
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-xs leading-relaxed',
                        isHighlight ? 'text-foreground/80' : 'text-muted-foreground'
                      )}
                    >
                      {text || '(无文本)'}
                    </span>
                    {/* 右侧：指示器 */}
                    <div className="flex shrink-0 items-center">
                      {isHighlight ? (
                        <div className="h-[2px] w-3 rounded-full bg-primary" />
                      ) : (
                        <span className="text-muted-foreground/30">–</span>
                      )}
                    </div>
                  </div>
                </PopoverAnchor>
                <PopoverContent
                  side="left"
                  align="start"
                  sideOffset={8}
                  className="w-80 rounded-lg border border-border/50 bg-background p-0 shadow-[0_8px_32px_rgba(0,0,0,0.12)]"
                  onPointerDownOutside={() => setPopoverTurn(null)}
                >
                  {/* Popover 头部：轮次信息 */}
                  <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                    <span className="font-mono text-[10px] text-muted-foreground/60">#{i + 1}</span>
                    <span className="text-[11px] text-muted-foreground">用户消息</span>
                  </div>
                  {/* Popover 正文：完整消息 */}
                  <div className="max-h-60 overflow-y-auto px-3 py-2.5">
                    <div className="text-xs leading-6 break-words whitespace-pre-wrap text-foreground/80">
                      {text || '(无文本)'}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )
          })}
        </div>
      </div>

      {/* ---- 进度条小横杠（贴在容器右边缘） ---- */}
      <div className="absolute top-0 right-2 bottom-0 flex flex-col items-center justify-center">
        {Array.from({ length: turnCount }, (_, i) => {
          const distance = hoveredTurn != null ? Math.abs(i - hoveredTurn) : Infinity
          const scaleX = distance === 0 ? 2.2 : distance === 1 ? 1.45 : distance === 2 ? 1.1 : 1
          const scaleY = distance === 0 ? 1.8 : distance === 1 ? 1.3 : distance === 2 ? 1.1 : 1
          const isActive = hoveredTurn == null && activeTurn === i
          const isHovered = distance === 0

          return (
            <div
              key={i}
              role="button"
              tabIndex={0}
              className={cn(
                'my-[2.5px] h-[2px] w-[10px] origin-center cursor-pointer rounded-full',
                isHovered ? 'bg-foreground/60' : isActive ? 'bg-foreground/40' : 'bg-foreground/12'
              )}
              style={{
                transform: `scaleX(${scaleX}) scaleY(${scaleY})`,
                transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1), background-color 150ms ease'
              }}
              onMouseEnter={() => setHoveredTurn(i)}
              onClick={() => scrollToTurn(i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  scrollToTurn(i)
                }
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
