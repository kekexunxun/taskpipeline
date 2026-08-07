import { SearchIcon } from 'lucide-react'
import type { TraceKind } from '@coding-agent/core'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export type TraceKindFilter = TraceKind | 'all'

const options: Array<{ value: TraceKindFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'task', label: '任务' },
  { value: 'chat', label: '对话' },
  { value: 'pi_session', label: 'Pi 会话' }
]

/** 顶部筛选：类型切换 + 关键词搜索。 */
export function TraceFilters({
  kind,
  onKindChange,
  query,
  onQueryChange
}: {
  kind: TraceKindFilter
  onKindChange(kind: TraceKindFilter): void
  query: string
  onQueryChange(query: string): void
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <div className="flex items-center gap-1 rounded-md border bg-background p-0.5">
        {options.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant="ghost"
            className={cn('h-7 px-2.5 text-xs', kind === option.value && 'bg-accent text-foreground')}
            onClick={() => onKindChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <div className="relative ml-auto w-56">
        <SearchIcon
          size={14}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索标题 / 任务 / 会话"
          className="h-8 pl-8 text-xs"
        />
      </div>
    </div>
  )
}
