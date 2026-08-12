import { SearchIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** 时间段筛选。 */
export type TimeRangeFilter = 'all' | 'today' | 'week'
/**
 * 状态筛选。Trace 状态两态化（进行中/已结束，见 core TraceState）；
 * 'error' 不对应 trace 状态，按 errorCount > 0 过滤「含错误步骤」的记录。
 */
export type StatusFilter = 'all' | 'running' | 'ended' | 'error'

const timeOptions: Array<{ value: TimeRangeFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' }
]

const statusOptions: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'running', label: '进行中' },
  { value: 'ended', label: '已结束' },
  { value: 'error', label: '含错误' }
]

/** 顶部筛选：时间段 + 状态 + Agent 名 + 关键词搜索。 */
export function TraceFilters({
  timeRange,
  onTimeRangeChange,
  status,
  onStatusChange,
  agent,
  onAgentChange,
  agents,
  query,
  onQueryChange
}: {
  timeRange: TimeRangeFilter
  onTimeRangeChange(range: TimeRangeFilter): void
  status: StatusFilter
  onStatusChange(status: StatusFilter): void
  agent: string
  onAgentChange(agent: string): void
  agents: string[]
  query: string
  onQueryChange(query: string): void
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-1 rounded-md border bg-background p-0.5">
        {timeOptions.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant="ghost"
            className={cn('h-7 px-2.5 text-xs', timeRange === option.value && 'bg-accent text-foreground')}
            onClick={() => onTimeRangeChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <select
        value={status}
        onChange={(event) => onStatusChange(event.target.value as StatusFilter)}
        className="h-8 rounded-md border bg-background px-2 text-xs!"
      >
        {statusOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {agents.length > 0 && (
        <select
          value={agent}
          onChange={(event) => onAgentChange(event.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs!"
        >
          <option value="">全部 Agent</option>
          {agents.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      )}
      <div className="relative">
        <SearchIcon
          size={14}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索 Trace ID / 标题"
          className="h-8 pl-8 text-xs!"
        />
      </div>
    </div>
  )
}
