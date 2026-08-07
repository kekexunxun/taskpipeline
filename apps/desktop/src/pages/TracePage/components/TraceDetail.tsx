import { Link } from 'react-router-dom'
import {
  ActivityIcon,
  ArrowLeftIcon,
  BotIcon,
  Code2Icon,
  ExternalLinkIcon,
  FileDiffIcon,
  LightbulbIcon,
  Link2Icon,
  Loader2Icon,
  ShieldIcon,
  SparklesIcon,
  XIcon,
  type LucideIcon
} from 'lucide-react'
import type { TraceEntry, TraceEntryType, TraceKind, TraceSummary } from '@coding-agent/core'
import { api } from '../../../api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatDuration, formatTime, formatTokens } from '@/utils/format'
import { localizedEventTitle } from '@/utils/status'

const kindLabels: Record<TraceKind, string> = { task: '任务', chat: '对话', pi_session: 'Pi 会话', other: '其它' }

const typeIcons: Record<TraceEntryType, LucideIcon> = {
  session_start: ActivityIcon,
  session_end: ActivityIcon,
  message: BotIcon,
  thinking: LightbulbIcon,
  tool_call: Code2Icon,
  tool_result: Code2Icon,
  status: ActivityIcon,
  error: XIcon,
  review: ShieldIcon,
  diff: FileDiffIcon
}

/** 从 entry.payload 提取可展示的元信息（模型 / 耗时 / Token / 成本 / stop reason / 错误标记）。 */
type EntryMeta = {
  model?: string
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  stopReason?: string
  isError?: boolean
}

function extractMeta(entry: TraceEntry): EntryMeta {
  const p = (entry.payload ?? {}) as Record<string, unknown>
  const meta: EntryMeta = {}
  if (typeof p.model === 'string') meta.model = p.model
  if (typeof p.durationMs === 'number') meta.durationMs = p.durationMs
  if (typeof p.stopReason === 'string') meta.stopReason = p.stopReason
  if (p.isError === true) meta.isError = true
  const usage = p.usage as { input?: number; output?: number; cost?: number } | undefined
  if (usage && (typeof usage.input === 'number' || typeof usage.output === 'number')) {
    meta.inputTokens = usage.input ?? 0
    meta.outputTokens = usage.output ?? 0
    if (typeof usage.cost === 'number') meta.costUsd = usage.cost
  }
  return meta
}

function MetaBadges({ meta }: { meta: EntryMeta }) {
  const hasAny =
    meta.model || meta.isError || meta.durationMs !== undefined || meta.inputTokens !== undefined || meta.stopReason
  if (!hasAny) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {meta.isError && (
        <Badge variant="destructive" className="px-1 py-0 text-[10px]">
          失败
        </Badge>
      )}
      {meta.model && (
        <Badge variant="outline" className="max-w-44 truncate px-1 py-0 font-mono text-[9px]">
          {meta.model}
        </Badge>
      )}
      {meta.durationMs !== undefined && (
        <Badge variant="secondary" className="px-1 py-0 text-[10px]">
          {formatDuration(meta.durationMs)}
        </Badge>
      )}
      {meta.inputTokens !== undefined && (
        <Badge
          variant="secondary"
          className="px-1 py-0 text-[10px]"
          title={`输入 ${meta.inputTokens} · 输出 ${meta.outputTokens ?? 0}`}
        >
          ↑{formatTokens(meta.inputTokens)} ↓{formatTokens(meta.outputTokens ?? 0)}
        </Badge>
      )}
      {meta.costUsd !== undefined && meta.costUsd > 0 && (
        <Badge variant="secondary" className="px-1 py-0 text-[10px] text-emerald-600 dark:text-emerald-400">
          ${meta.costUsd.toFixed(4)}
        </Badge>
      )}
      {meta.stopReason && (
        <Badge variant="outline" className="px-1 py-0 font-mono text-[9px]">
          stop: {meta.stopReason}
        </Badge>
      )}
    </div>
  )
}

function TraceEntryItem({ entry }: { entry: TraceEntry }) {
  const Icon = typeIcons[entry.type]
  const meta = extractMeta(entry)
  return (
    <article className="mb-4 grid grid-cols-[26px_minmax(0,1fr)] gap-2">
      <div
        className={cn(
          'grid size-6 place-items-center rounded-full border bg-muted text-muted-foreground',
          entry.type === 'error' && 'border-red-500/30 text-red-300'
        )}
      >
        <Icon size={12} />
      </div>
      <div className="min-w-0 pt-0.5">
        <div className="flex items-center justify-between gap-3">
          <strong className="text-xs font-medium">{localizedEventTitle(entry.title)}</strong>
          <time className="shrink-0 text-xs text-muted-foreground">{formatTime(entry.createdAt)}</time>
        </div>
        <MetaBadges meta={meta} />
        {entry.detail && (
          <pre className="thin-scrollbar mt-1.5 max-h-72 overflow-auto rounded-md border bg-background p-2 font-mono text-xs leading-4 whitespace-pre-wrap text-muted-foreground">
            {entry.detail}
          </pre>
        )}
      </div>
    </article>
  )
}

function StatsOverview({ stats }: { stats: TraceSummary['stats'] }) {
  if (!stats) return null
  const hasAny =
    stats.model ||
    (stats.tokens && stats.tokens.total > 0) ||
    typeof stats.costUsd === 'number' ||
    typeof stats.durationMs === 'number'
  if (!hasAny) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {stats.model && (
        <Badge variant="outline" className="max-w-48 truncate px-1.5 py-0 font-mono text-[10px]">
          {stats.model}
        </Badge>
      )}
      {stats.tokens && stats.tokens.total > 0 && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          ↑{formatTokens(stats.tokens.input)} ↓{formatTokens(stats.tokens.output)}（{formatTokens(stats.tokens.total)}）
        </Badge>
      )}
      {typeof stats.costUsd === 'number' && stats.costUsd > 0 && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] text-emerald-600 dark:text-emerald-400">
          ${stats.costUsd.toFixed(4)}
        </Badge>
      )}
      {typeof stats.durationMs === 'number' && stats.durationMs > 0 && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {formatDuration(stats.durationMs)}
        </Badge>
      )}
      {typeof stats.turns === 'number' && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {stats.turns} 轮
        </Badge>
      )}
    </div>
  )
}

/** 详情视图：单条 trace 的完整轨迹，每条记录展示模型 / 耗时 / Token / 成本等执行元信息。 */
export function TraceDetail({
  kind,
  traceId,
  entries,
  loading,
  summary,
  onBack
}: {
  kind: TraceKind
  traceId: string
  entries: TraceEntry[]
  loading: boolean
  summary?: TraceSummary
  onBack(): void
}) {
  const isTask = kind === 'task'
  const isChat = kind === 'chat'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Button size="icon" variant="ghost" className="size-8" onClick={onBack} title="返回列表">
          <ArrowLeftIcon size={15} />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{summary?.title ?? traceId}</h2>
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
              {kindLabels[kind]}
            </Badge>
          </div>
          <p className="truncate font-mono text-[10px] text-muted-foreground">{traceId}</p>
          <StatsOverview stats={summary?.stats} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {summary?.linkedTaskId && (
            <Button asChild size="sm" variant="outline" className="h-7 gap-1 text-xs">
              <Link to={`/coding/${summary.linkedTaskId}`}>
                <Link2Icon size={12} />
                关联任务
              </Link>
            </Button>
          )}
          {isTask && (
            <Button asChild size="sm" variant="outline" className="h-7 gap-1 text-xs">
              <Link to={`/coding/${traceId}`}>
                <Link2Icon size={12} />
                打开任务
              </Link>
            </Button>
          )}
          {isChat && (
            <Button asChild size="sm" variant="outline" className="h-7 gap-1 text-xs">
              <Link to={`/chat/${traceId}`}>
                <Link2Icon size={12} />
                打开对话
              </Link>
            </Button>
          )}
          {summary?.traceHtmlPath && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => void api.openExternal(`file://${summary.traceHtmlPath}`)}
              title="在浏览器中打开 pi-trace 完整执行视图"
            >
              <ExternalLinkIcon size={12} />
              trace.html
            </Button>
          )}
        </div>
      </div>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon size={14} className="animate-spin" />
            加载中…
          </div>
        ) : entries.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-1 text-muted-foreground">
            <SparklesIcon size={20} />
            <strong className="text-xs">暂无执行记录</strong>
            <span className="text-xs">该 Trace 尚未产生事件</span>
          </div>
        ) : (
          entries.map((entry) => <TraceEntryItem key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  )
}
