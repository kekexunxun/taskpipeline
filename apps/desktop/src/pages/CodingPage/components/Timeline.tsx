import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  ActivityIcon,
  BotIcon,
  Code2Icon,
  FileDiffIcon,
  MessageSquareTextIcon,
  ShieldIcon,
  TerminalIcon,
  XIcon
} from 'lucide-react'
import type { AgentEvent } from '@coding-agent/core'
import { cn } from '@/lib/utils'
import { formatTime } from '@/utils/format'
import { localizedEventTitle } from '@/utils/status'
import { Badge } from '@/components/ui/badge'
import {
  SubTaskGroup,
  SubTaskHeader,
  SubTaskProgressSummary,
  SubTaskResultBlock,
  ToolCallRow,
  aggregateSubTaskProgress,
  interleaveTimeline,
  isHiddenTimelineEvent,
  subtaskMetaOf,
  subtaskStatusOf,
  toolInputSummary,
  type SubTaskProgressSample,
  type ToolCallStatus
} from '@/components/SubTaskGroup'

export type TimelineItem =
  | AgentEvent
  | {
      id: string
      taskId: string
      kind: AgentEvent['kind']
      title: string
      detail?: string
      createdAt: string
      payload?: unknown
    }
const icons = {
  message: MessageSquareTextIcon,
  tool: Code2Icon,
  permission: ShieldIcon,
  command: TerminalIcon,
  diff: FileDiffIcon,
  review: ShieldIcon,
  error: XIcon,
  status: ActivityIcon
} as const
const agentMessageTitle = /^(?:qoder agent|openai agent|ai)$/i
const outcomeMarker = /\n?\s*<!--\s*coding-agent-outcome:(?:needs_input|already_satisfied|completed)\s*-->/gi

function isAgentMessage(item: TimelineItem): boolean {
  return item.kind === 'message' && agentMessageTitle.test(item.title.trim())
}

function visibleDetail(detail: string | undefined): string | undefined {
  const cleaned = detail?.replace(outcomeMarker, '').trim()
  return cleaned || undefined
}

function duplicateKey(item: TimelineItem): string {
  const title = isAgentMessage(item) ? 'agent' : item.title.trim().toLowerCase()
  return `${item.kind} ${title} ${visibleDetail(item.detail) ?? ''}`
}

/**
 * 归一化时间线条目:
 * 1. 去掉 outcome marker 注释(避免污染 UI);
 * 2. 同 kind + title + detail + 5 秒内重复 → 合并,防流式重放刷屏;
 * 3. 保持 createdAt 升序。
 */
export function normalizeTimelineItems(items: TimelineItem[]): TimelineItem[] {
  const sorted = items
    .map((item, index) => ({ item: { ...item, detail: visibleDetail(item.detail) }, index }))
    .sort((left, right) => {
      const byTime = Date.parse(left.item.createdAt) - Date.parse(right.item.createdAt)
      return (Number.isNaN(byTime) ? 0 : byTime) || left.index - right.index
    })
  const seen = new Map<string, number>()
  return sorted.flatMap(({ item }) => {
    const key = duplicateKey(item)
    const time = Date.parse(item.createdAt)
    const previousTime = seen.get(key)
    if (previousTime !== undefined && Math.abs(time - previousTime) < 5_000) return []
    seen.set(key, time)
    return [item]
  })
}

/** TimelineItem 转 ParentedItem(interleaveTimeline 需要的形态)。子任务元信息走共享 subtaskMetaOf。 */
function toParentedItem(item: TimelineItem) {
  const meta = subtaskMetaOf(item)
  return {
    id: item.id,
    parentTaskId: meta.parentTaskId,
    subtaskId: meta.subtaskId,
    sdkSubtype: meta.sdkSubtype
  }
}

function TimelineEntryBody({ item }: { item: TimelineItem }) {
  const Icon = icons[item.kind]
  const isReview = item.kind === 'review'
  const payload = isReview
    ? (item.payload as
        | { comments?: Array<{ severity?: string; path?: string; line?: number; message?: string }> }
        | undefined)
    : undefined
  const reviewComments = payload?.comments?.filter((comment) => comment.message || comment.path) ?? []
  const severityBadge = (severity?: string) => {
    const level = String(severity ?? '').toLowerCase()
    return (
      <Badge
        variant={
          level === 'critical' || level === 'high' || level === 'error'
            ? 'destructive'
            : level === 'medium'
              ? 'warning'
              : level === 'low'
                ? 'secondary'
                : 'outline'
        }
      >
        {level || 'info'}
      </Badge>
    )
  }
  return (
    <article className="mb-4 grid grid-cols-[26px_minmax(0,1fr)] gap-2">
      <div
        className={cn(
          'grid size-6 place-items-center rounded-full border bg-muted text-muted-foreground',
          item.kind === 'error' && 'border-red-500/30 text-red-300'
        )}
      >
        <Icon size={12} />
      </div>
      <div className="min-w-0 pt-0.5">
        <div className="flex items-center justify-between gap-3">
          <strong className="text-xs font-medium">{localizedEventTitle(item.title)}</strong>
          <time className="shrink-0 text-xs text-muted-foreground">{formatTime(item.createdAt)}</time>
        </div>
        {item.detail && (
          <pre className="thin-scrollbar mt-1.5 overflow-x-auto rounded-md border bg-background p-2 font-mono text-xs leading-4 whitespace-pre-wrap text-muted-foreground">
            {item.detail}
          </pre>
        )}
        {reviewComments.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {reviewComments.map((comment, index) => (
              <div className="rounded-md border bg-background px-2 py-1.5 text-xs" key={index}>
                <div className="flex items-center gap-1.5">
                  {severityBadge(comment.severity)}
                  {comment.path && (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {comment.path}
                      {typeof comment.line === 'number' ? `:${comment.line}` : ''}
                    </span>
                  )}
                </div>
                {comment.message && (
                  <p className="mt-1 leading-4 break-words whitespace-pre-wrap text-muted-foreground">
                    {comment.message}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

/** 同 toolUseId 的 use + result 配对。 */
type ToolPair = { callId: string; use?: TimelineItem; result?: TimelineItem }

/**
 * 把 kind='tool' 事件按 payload.toolUseId 配对(log.ts 对每个 tool_use / tool_result block
 * 各写一条事件)。无 toolUseId 的老数据不进配对表,由调用方按单行 ToolCallRow 兜底。
 */
function pairToolItems(items: TimelineItem[]): Map<string, ToolPair> {
  const pairByCallId = new Map<string, ToolPair>()
  for (const item of items) {
    if (item.kind !== 'tool') continue
    const payload = item.payload as { toolUseId?: string; phase?: string } | undefined
    const callId = typeof payload?.toolUseId === 'string' ? payload.toolUseId : undefined
    if (!callId) continue
    let pair = pairByCallId.get(callId)
    if (!pair) {
      pair = { callId }
      pairByCallId.set(callId, pair)
    }
    if (payload?.phase === 'result') pair.result = item
    else if (!pair.use) pair.use = item
  }
  return pairByCallId
}

/** 一对 use + result → 一行 ToolCallRow(Qoder 风格紧凑行,点击展开输入/输出)。 */
function toolRowFromPair(pair: ToolPair, live?: boolean): ReactNode {
  const ref = pair.use ?? pair.result
  if (!ref) return null
  const usePayload = pair.use?.payload as { toolName?: string; input?: unknown } | undefined
  const resultPayload = pair.result?.payload as { output?: unknown; isError?: boolean } | undefined
  const name =
    usePayload?.toolName ?? (pair.result?.payload as { toolName?: string } | undefined)?.toolName ?? ref.title
  const input = usePayload?.input ?? (pair.use ? pair.use?.detail : undefined)
  const output = resultPayload ? (resultPayload.output ?? pair.result?.detail) : undefined
  const status: ToolCallStatus = resultPayload?.isError === true ? 'error' : !pair.result && live ? 'running' : 'done'
  return (
    <ToolCallRow
      name={name}
      summary={toolInputSummary(input)}
      input={input}
      output={output}
      status={status}
      createdAt={ref.createdAt}
    />
  )
}

export function Timeline({ items, live }: { items: TimelineItem[]; live?: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)
  const normalized = useMemo(() => normalizeTimelineItems(items), [items])
  const lastItem = normalized.at(-1)
  // interleaveTimeline 按 parentTaskId 切换 group,让 group 卡出现在它实际发生的时间点附近,
  // 后续主流程消息从 group 之后继续 —— 避免「先全部 main + 再全部 groups」把子任务全推到时间线底部。
  const blocks = useMemo(() => {
    const visible = normalized.filter((item) => !isHiddenTimelineEvent((item as { title?: string }).title))
    const indexed = visible.map((item) => ({ item, meta: toParentedItem(item) }))
    const interleaved = interleaveTimeline(indexed.map((x) => x.meta))
    // 把 ParentedItem 反查回原始 TimelineItem
    return interleaved.map((block) => {
      if (block.kind === 'main') {
        const found = indexed.find((x) => x.meta.id === block.item.id)
        return { kind: 'main' as const, item: found!.item }
      }
      return {
        kind: 'group' as const,
        taskId: block.taskId,
        header: block.header ? indexed.find((x) => x.meta.id === block.header!.id)!.item : undefined,
        children: block.children.map((c) => indexed.find((x) => x.meta.id === c.id)!.item)
      }
    })
  }, [normalized])

  // 主流程里发起子任务的工具调用(task_started.tool_use_id → taskId)。
  // 这些调用不再单独渲染成行 —— 子任务折叠卡就是它们的呈现(跟 Qoder 一致)。
  const spawnerTaskByCallId = useMemo(() => {
    const map = new Map<string, string>()
    for (const block of blocks) {
      if (block.kind !== 'group') continue
      const toolUseId = block.header ? subtaskMetaOf(block.header).toolUseId : undefined
      if (toolUseId) map.set(toolUseId, block.taskId)
    }
    return map
  }, [blocks])

  // 主流程工具事件配对(仅 main 块;子任务内的在 renderSubTaskChildren 里单独配)。
  const mainToolPairs = useMemo(() => {
    const mains = blocks.flatMap((block) => (block.kind === 'main' ? [block.item] : []))
    return pairToolItems(mains)
  }, [blocks])

  // 被吸收调用的结果输出(taskId → output),作为卡片底部「输出」段。
  const absorbedOutputByTaskId = useMemo(() => {
    const map = new Map<string, { output?: unknown; isError?: boolean }>()
    for (const [callId, taskId] of spawnerTaskByCallId) {
      const pair = mainToolPairs.get(callId)
      if (!pair?.result) continue
      const payload = pair.result.payload as { output?: unknown; isError?: boolean } | undefined
      map.set(taskId, { output: payload?.output ?? pair.result.detail, isError: payload?.isError === true })
    }
    return map
  }, [spawnerTaskByCallId, mainToolPairs])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [normalized.length, lastItem?.detail])

  /** 主流程单条渲染:tool 事件 → ToolCallRow(配对 + 吸收),其它 → TimelineEntryBody。 */
  const renderMainItem = (item: TimelineItem): ReactNode => {
    if (item.kind === 'tool') {
      const payload = item.payload as { toolUseId?: string } | undefined
      const callId = typeof payload?.toolUseId === 'string' ? payload.toolUseId : undefined
      if (callId) {
        if (spawnerTaskByCallId.has(callId)) return null // 吸收进子任务卡
        const pair = mainToolPairs.get(callId)
        const anchor = pair ? (pair.use ?? pair.result) : undefined
        if (anchor && anchor.id !== item.id) return null // 只在锚点位置渲染一次
        if (pair) return toolRowFromPair(pair, live)
      }
      // 无 toolUseId 的老数据:detail 当输入,单行兜底。
      return (
        <ToolCallRow
          name={item.title}
          summary={toolInputSummary(item.detail)}
          input={item.detail}
          createdAt={item.createdAt}
        />
      )
    }
    return <TimelineEntryBody item={item} />
  }

  return (
    <div className="px-5 py-4 pb-16">
      {normalized.length === 0 && (
        <div className="flex min-h-44 flex-col items-center justify-center gap-2 text-muted-foreground">
          <BotIcon size={24} />
          <strong className="text-xs">暂无执行记录</strong>
        </div>
      )}
      {blocks.map((block, index) => {
        if (block.kind === 'main') {
          return <Fragment key={`m-${block.item.id}-${index}`}>{renderMainItem(block.item)}</Fragment>
        }
        // group:header 用 task_started 的元信息(description + task_type + subagent_type 徽章);
        // task_progress 聚合成统计行,task_notification 只驱动 header 状态徽章(内容不重复展示),
        // 子条目只剩工具行 + 文本块 —— 跟 Qoder 子任务展示一致。
        const headerMeta = block.header ? subtaskMetaOf(block.header) : undefined
        const endItem = block.children.find((c) => subtaskMetaOf(c).sdkSubtype === 'task_notification')
        const endMeta = endItem ? subtaskMetaOf(endItem) : undefined
        const status = subtaskStatusOf(
          endItem ? { payload: endMeta } : block.header ? { payload: headerMeta } : undefined
        )
        const aggregate = aggregateSubTaskProgress(progressSamplesOf(block.children))
        const absorbed = absorbedOutputByTaskId.get(block.taskId)
        return (
          <SubTaskGroup
            key={`g-${block.taskId}-${index}`}
            taskId={block.taskId}
            createdAt={block.header?.createdAt}
            header={
              <SubTaskHeader
                description={headerMeta?.description ?? block.header?.detail}
                taskType={headerMeta?.taskType}
                subagentType={headerMeta?.subagentType}
                status={status}
              />
            }
          >
            <SubTaskProgressSummary aggregate={aggregate} running={status === 'running'} />
            {renderSubTaskChildren(block.children, live)}
            <SubTaskResultBlock output={absorbed?.output} isError={absorbed?.isError} />
          </SubTaskGroup>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}

/** 从 children 里抽 task_progress 样本,喂给 aggregateSubTaskProgress。 */
function progressSamplesOf(children: TimelineItem[]): SubTaskProgressSample[] {
  const samples: SubTaskProgressSample[] = []
  for (const child of children) {
    const meta = subtaskMetaOf(child)
    if (meta.sdkSubtype !== 'task_progress') continue
    samples.push({
      lastToolName: meta.lastToolName,
      description: meta.description,
      usage: meta.usage as SubTaskProgressSample['usage']
    })
  }
  return samples
}

/**
 * 把子任务 group 的 children 按类别路由:
 * - task_started / task_progress / task_notification 不直接渲染(分别已折进 header / 统计行 / 收尾块);
 * - tool 事件按 toolUseId 配对成 ToolCallRow;
 * - 其它(message / status 等)走 TimelineEntryBody。
 *
 * 顺序:保持 children 原序(接收时间序),配对后的工具行锚定在 use(否则 result)出现的位置。
 */
function renderSubTaskChildren(children: TimelineItem[], live?: boolean): ReactNode {
  const visible = children.filter((c) => {
    const subtype = subtaskMetaOf(c).sdkSubtype
    return subtype !== 'task_started' && subtype !== 'task_progress' && subtype !== 'task_notification'
  })
  const pairByCallId = pairToolItems(visible)
  return visible.map((child) => {
    if (child.kind === 'tool') {
      const payload = child.payload as { toolUseId?: string } | undefined
      const callId = typeof payload?.toolUseId === 'string' ? payload.toolUseId : undefined
      const pair = callId ? pairByCallId.get(callId) : undefined
      if (pair) {
        const anchor = pair.use ?? pair.result
        if (anchor && anchor.id !== child.id) return null
        return <Fragment key={child.id}>{toolRowFromPair(pair, live)}</Fragment>
      }
      return (
        <ToolCallRow
          key={child.id}
          name={child.title}
          summary={toolInputSummary(child.detail)}
          input={child.detail}
          createdAt={child.createdAt}
        />
      )
    }
    return <TimelineEntryBody key={child.id} item={child} />
  })
}
