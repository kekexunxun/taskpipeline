import { Link, useLocation } from 'react-router-dom'
import { ActivityIcon, MessageSquareTextIcon, Code2Icon, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const items: Array<{ label: string; to: string; icon: LucideIcon }> = [
  { label: '对话', to: '/chat', icon: MessageSquareTextIcon },
  { label: '编码', to: '/coding', icon: Code2Icon },
  { label: '追踪', to: '/trace', icon: ActivityIcon }
]

/**
 * 极左侧的功能切换栏（类 VSCode Activity Bar）。
 * - 按钮较大，激活态使用左侧强调条 + 内嵌高亮双重指示。
 */
export function ActionBar() {
  const { pathname } = useLocation()

  return (
    <nav className="flex w-12 shrink-0 flex-col items-stretch gap-1 border-r bg-card/60 py-2">
      {items.map(({ label, to, icon: Icon }) => {
        const isActive = pathname === to || pathname.startsWith(`${to}/`) || (to === '/chat' && pathname === '/')

        return (
          <Tooltip key={to}>
            <TooltipTrigger asChild>
              <Link
                to={to}
                aria-label={label}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'group relative flex h-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground',
                  isActive && 'bg-accent text-primary'
                )}
              >
                <span
                  className={cn(
                    'absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-primary transition-opacity',
                    isActive ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <Icon size={20} strokeWidth={isActive ? 2.25 : 1.75} />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}
