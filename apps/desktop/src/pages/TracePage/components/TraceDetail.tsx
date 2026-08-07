import { Link } from 'react-router-dom'
import { ArrowLeftIcon, ExternalLinkIcon, Link2Icon, Loader2Icon } from 'lucide-react'
import type { AgentEvent, TraceEntry, TraceEntryType, TraceKind, TraceSummary } from '@coding-agent/core'
import { api } from '../../../api'
import { Timeline, type TimelineItem } from '../../CodingPage/components/Timeline'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const kindLabels: Record<TraceKind, string> = { task: '任务', chat: '对话', pi_session: 'Pi 会话', other: '其它' }

/** TraceEntry.type → Timeline 的 AgentEvent.kind（Timeline 已内置去重 / 折叠逻辑）。 */
function toTimelineKind(type: TraceEntryType): AgentEvent['kind'] {
  switch (type) {
    case 'message':
    case 'thinking':
      return 'message'
    case 'tool_call':
    case 'tool_result':
      return 'tool'
    case 'error':
      return 'error'
    case 'review':
      return 'review'
    case 'diff':
      return 'diff'
    default:
      return 'status'
  }
}

function toTimelineItems(entries: TraceEntry[]): TimelineItem[] {
  return entries.map((entry) => ({
    id: entry.id,
    taskId: entry.traceId,
    kind: toTimelineKind(entry.type),
    title: entry.title,
    detail: entry.detail,
    createdAt: entry.createdAt
  }))
}

/** 详情视图：单条 trace 的完整轨迹（复用 CodingPage 的 Timeline 组件）。 */
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
  const items = toTimelineItems(entries)
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
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon size={14} className="animate-spin" />
            加载中…
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-1 text-muted-foreground">
            <strong className="text-xs">暂无执行记录</strong>
            <span className="text-xs">该 Trace 尚未产生事件</span>
          </div>
        ) : (
          <Timeline items={items} />
        )}
      </div>
    </div>
  )
}
