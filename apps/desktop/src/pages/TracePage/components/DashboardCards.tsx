import { ClockIcon, DollarSignIcon, ActivityIcon, AlertTriangleIcon } from 'lucide-react'
import type { TraceDashboardStats } from '@task-pipeline/core'

function formatDuration(ms?: number): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * 仪表盘顶部统计卡片：今日总请求数 / 平均耗时 / 总成本 / 错误数。
 * 数据由主进程 trace:dashboard 预计算返回，前端不重复计算。
 */
export function DashboardCards({ stats }: { stats: TraceDashboardStats | undefined }) {
  const cards = [
    {
      icon: ActivityIcon,
      label: '今日总请求数',
      value: stats ? String(stats.todayCount) : '—',
      hint: stats ? `本周 ${stats.weekCount}` : undefined,
      className: 'text-emerald-500'
    },
    {
      icon: ClockIcon,
      label: '平均耗时',
      value: formatDuration(stats?.avgDurationMs),
      hint: '近 7 天',
      className: 'text-sky-500'
    },
    {
      icon: DollarSignIcon,
      label: '总成本',
      value: stats?.totalCostUsd !== undefined ? `$${stats.totalCostUsd.toFixed(4)}` : '—',
      hint: '累计',
      className: 'text-amber-500'
    },
    {
      icon: AlertTriangleIcon,
      label: '含错误 Trace',
      value: stats ? String(stats.errorCount) : '—',
      hint: '含错误步骤',
      className: 'text-rose-500'
    }
  ]

  return (
    <div className="grid grid-cols-4 gap-2 px-4 pt-1 pb-3">
      {cards.map((card) => (
        <div key={card.label} className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5">
          <card.icon size={16} className={card.className} />
          <div className="min-w-0">
            <div className="truncate text-[10px] text-muted-foreground">{card.label}</div>
            <div className="text-sm font-semibold tabular-nums">{card.value}</div>
            {card.hint && <div className="truncate text-[10px] text-muted-foreground">{card.hint}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
