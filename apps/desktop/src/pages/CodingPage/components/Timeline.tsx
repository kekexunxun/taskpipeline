import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  ActivityIcon,
  BotIcon,
  ChevronDownIcon,
  Code2Icon,
  FileDiffIcon,
  MessageSquareTextIcon,
  ShieldIcon,
  TerminalIcon,
  XIcon
} from 'lucide-react'
import type { AgentEvent } from '@task-pipeline/core'
import { cn } from '@/lib/utils'
import { formatTime } from '@/utils/format'
import { localizedEventTitle } from '@/utils/status'
import { MessageResponse } from '@/components/ai-elements/message'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ThinkingBlock } from '@/components/ThinkingBlock'
import {
  SubTaskAgentHeader,
  SubTaskGroup,
  SubTaskHeader,
  SubTaskProgressSummary,
  SubTaskResultBlock,
  ToolCallRow,
  aggregateSubTaskProgress,
  determineToolStatus,
  interleaveTimeline,
  isHiddenTimelineEvent,
  pairToolCalls,
  subtaskMetaOf,
  subtaskStatusOf,
  toolInputSummary,
  type ParentedItem,
  type SubTaskProgressSample,
  type TimelineBlock,
  type ToolCallPair
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
const outcomeMarker = /\n?\s*<!--\s*task-pipeline-outcome:(?:needs_input|already_satisfied|completed)\s*-->/gi

function isAgentMessage(item: TimelineItem): boolean {
  return item.kind === 'message' && agentMessageTitle.test(item.title.trim())
}

function visibleDetail(detail: string | undefined): string | undefined {
  const cleaned = detail?.replace(outcomeMarker, '').trim()
  return cleaned || undefined
}

function duplicateKey(item: TimelineItem): string {
  const title = isAgentMessage(item) ? 'agent' : item.title.trim().toLowerCase()
  // 工具事件的 use / result 两条记录 kind/title/detail 完全一致（仅 payload.phase 不同），
  // 必须把 phase 纳入 key，否则 5 秒去重会把 result 当重复删除 —— 工具行只剩输入没有输出。
  const phase = item.kind === 'tool' ? ` ${String((item.payload as { phase?: string } | undefined)?.phase ?? '')}` : ''
  return `${item.kind} ${title}${phase} ${visibleDetail(item.detail) ?? ''}`
}

/**
 * 相邻的 agent 消息合并为一条:流式 agent_text 曾按 delta 粒度落库(旧数据),
 * detail 是连续文本碎片;合并后执行 tab 展示为完整段落,不再一条 delta 一条消息。
 * 仅合并"相邻且同为 agent 消息"的条目(中间隔了工具/状态事件则不动)。
 */
function mergeAdjacentAgentMessages(items: TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (last && isAgentMessage(item) && isAgentMessage(last)) {
      const detail = [last.detail, item.detail].filter(Boolean).join('')
      out[out.length - 1] = { ...last, detail: detail || undefined } as TimelineItem
      continue
    }
    out.push(item)
  }
  return out
}

/**
 * 归一化时间线条目:
 * 1. 去掉 outcome marker 注释(避免污染 UI);
 * 2. 同 kind + title + detail + 5 秒内重复 → 合并,防流式重放刷屏 —— 仅对无 span payload 的
 *    遗留事件生效;span 来源事件(payload.spanId)按 spanId 豁免:相邻的纯 thinking 等记录
 *    内容相同但是不同执行步骤(spanId 唯一),内容去重会误吞;
 * 3. 相邻 agent 消息合并(修复旧数据 delta 碎片);
 * 4. 保持 createdAt 升序。
 */
export function normalizeTimelineItems(items: TimelineItem[]): TimelineItem[] {
  const sorted = items
    .map((item, index) => ({ item: { ...item, detail: visibleDetail(item.detail) }, index }))
    .sort((left, right) => {
      const byTime = Date.parse(left.item.createdAt) - Date.parse(right.item.createdAt)
      return (Number.isNaN(byTime) ? 0 : byTime) || left.index - right.index
    })
  const seen = new Map<string, number>()
  const deduped = sorted.flatMap(({ item }) => {
    const spanMarked = Boolean((item.payload as { spanId?: unknown } | undefined)?.spanId)
    if (!spanMarked) {
      const key = duplicateKey(item)
      const time = Date.parse(item.createdAt)
      const previousTime = seen.get(key)
      if (previousTime !== undefined && Math.abs(time - previousTime) < 5_000) return []
      seen.set(key, time)
    }
    return [item]
  })
  return mergeAdjacentAgentMessages(deduped)
}

/** TimelineItem 转 ParentedItem(interleaveTimeline 需要的形态)。子任务元信息走共享 subtaskMetaOf。 */
type ParentedMeta = ParentedItem & { id: string }
function toParentedItem(item: TimelineItem): ParentedMeta {
  const meta = subtaskMetaOf(item)
  return {
    id: item.id,
    parentTaskId: meta.parentTaskId,
    subtaskId: meta.subtaskId,
    sdkSubtype: meta.sdkSubtype,
    stageId: meta.stageId
  }
}

/** 将 LLM input 格式化为可读的字符串。 */
function formatJsonInput(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
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
  // 模型 thinking：不算主流程数据，折叠标注展示（trace-service 已拆到 payload.thinking）。
  const thinking = (item.payload as { thinking?: string } | undefined)?.thinking
  // LLM prompt：发往模型的完整请求（trace-service 已透传到 payload.input）。
  const llmInput = (item.payload as { input?: unknown } | undefined)?.input
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
        {llmInput !== undefined && (
          <Collapsible className="mt-1.5 mb-2" defaultOpen={false}>
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/50">
              <Code2Icon size={12} />
              模型输入
              <ChevronDownIcon size={11} className="ui-open:rotate-180 ml-auto transition-transform" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1">
              <pre className="thin-scrollbar max-h-48 overflow-auto rounded-md border bg-background p-2 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap">
                {formatJsonInput(llmInput)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
        {item.detail &&
          (item.kind === 'message' ? (
            <div className="mt-1.5 text-xs leading-relaxed">
              <MessageResponse>{item.detail}</MessageResponse>
            </div>
          ) : (
            <pre className="thin-scrollbar mt-1.5 overflow-x-auto rounded-md border bg-background p-2 font-mono text-xs leading-4 whitespace-pre-wrap text-muted-foreground">
              {item.detail}
            </pre>
          ))}
        {thinking && <ThinkingBlock text={thinking} />}
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

/** 一对 use + result → 一行 ToolCallRow(Qoder 风格紧凑行,点击展开输入/输出)。 */
function toolRowFromPair(pair: ToolCallPair<TimelineItem>, live?: boolean): ReactNode {
  const ref = pair.inputItem ?? pair.resultItem
  if (!ref) return null
  const usePayload = pair.inputItem?.payload as { toolName?: string; input?: unknown } | undefined
  const resultPayload = pair.resultItem?.payload as { output?: unknown; isError?: boolean } | undefined
  const name =
    usePayload?.toolName ?? (pair.resultItem?.payload as { toolName?: string } | undefined)?.toolName ?? ref.title
  const input = usePayload?.input ?? (pair.inputItem ? pair.inputItem?.detail : undefined)
  const output = resultPayload ? (resultPayload.output ?? pair.resultItem?.detail) : undefined
  const status = determineToolStatus(pair, resultPayload?.isError === true, !!live)
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
    // 把 ParentedItem 反查回原始 TimelineItem（nested 递归处理）
    const resolveBlock = (block: TimelineBlock<ParentedMeta>): TimelineBlock<TimelineItem> => {
      if (block.kind === 'main') {
        const found = indexed.find((x) => x.meta.id === block.item.id)
        return { kind: 'main' as const, item: found!.item }
      }
      return {
        kind: 'group' as const,
        taskId: block.taskId,
        header: block.header ? indexed.find((x) => x.meta.id === block.header!.id)!.item : undefined,
        children: block.children.map((c) => indexed.find((x) => x.meta.id === c.id)!.item),
        nested: block.nested.map(resolveBlock)
      }
    }
    return interleaved.map(resolveBlock)
  }, [normalized])

  // 主流程里发起子任务的工具调用(task_started.tool_use_id → taskId)。
  // 递归遍历所有 group(含 nested 阶段卡内的子 Agent 卡),确保嵌套组的委派调用也被吸收。
  // 这些调用不再单独渲染成行 —— 子任务折叠卡就是它们的呈现(跟 Qoder 一致)。
  const spawnerTaskByCallId = useMemo(() => {
    const map = new Map<string, string>()
    const walk = (blocks: TimelineBlock<TimelineItem>[]): void => {
      for (const block of blocks) {
        if (block.kind !== 'group') continue
        const toolUseId = block.header ? subtaskMetaOf(block.header).toolUseId : undefined
        if (toolUseId) map.set(toolUseId, block.taskId)
        walk(block.nested)
      }
    }
    walk(blocks)
    return map
  }, [blocks])

  // 全部工具事件配对(main + 所有 group children,含 nested 递归)。
  // 被吸收调用的委派工具在「父块」里(主流程或阶段卡 children),result 要能反查到,
  // 因此不能只配 main —— 阶段卡内的委派调用(result 在阶段卡 children)同样需要吸收。
  const allToolPairs = useMemo(() => {
    const collect = (blocks: TimelineBlock<TimelineItem>[]): TimelineItem[] =>
      blocks.flatMap((block) => (block.kind === 'main' ? [block.item] : [...block.children, ...collect(block.nested)]))
    return pairToolCalls<TimelineItem>(
      collect(blocks),
      (item) => {
        if (item.kind !== 'tool') return undefined
        const p = item.payload as { toolUseId?: string } | undefined
        return typeof p?.toolUseId === 'string' ? p.toolUseId : undefined
      },
      (item) => {
        const p = item.payload as { phase?: string } | undefined
        return p?.phase === 'result'
      }
    )
  }, [blocks])

  // 被吸收调用的结果输出(taskId → output),作为卡片底部「输出」段。
  // spawnerTaskByCallId 走递归遍历(含 nested 阶段卡),这里只复用结果收集逻辑。
  const absorbedOutputByTaskId = useMemo(() => {
    const map = new Map<string, { output?: unknown; isError?: boolean }>()
    for (const [callId, taskId] of spawnerTaskByCallId) {
      const pair = allToolPairs.get(callId)
      if (!pair?.resultItem) continue
      const payload = pair.resultItem.payload as { output?: unknown; isError?: boolean } | undefined
      map.set(taskId, { output: payload?.output ?? pair.resultItem.detail, isError: payload?.isError === true })
    }
    return map
  }, [spawnerTaskByCallId, allToolPairs])

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
        const pair = allToolPairs.get(callId)
        const anchor = pair ? (pair.inputItem ?? pair.resultItem) : undefined
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

  /**
   * 子任务/阶段卡渲染(递归)。nested 组挂进卡内容区,形成
   * 「Agent planning 阶段卡 → Explore 子 Agent 卡 → 工具行」的树形层级,
   * 不再与阶段卡平级(此前 nested 只在数据层生成、渲染层被丢弃)。
   *
   * - 顶层卡(阶段卡/顶层子任务卡)不缩进:此前统一 ml-7 border-l-2 让顶层阶段卡视觉上
   *   像嵌套在上一条 LLM 调用之下;仅 nested 嵌套子 Agent 卡保留缩进表达层级。
   * - children 与 nested 子卡按 createdAt 合并排序(此前固定先 children 后 nested,
   *   早发生的子 Agent 卡被排到晚发生的 LLM 调用之后,时序错乱);nested 子卡的时间锚点
   *   取「被吸收委派工具」在本卡 children 里的位置(工具行被吸收不渲染,子卡顶位),
   *   关联不上时回退子卡 header 时间。
   */
  const renderGroup = (block: TimelineBlock<TimelineItem>, index: number, nestedCard = false): ReactNode => {
    if (block.kind !== 'group') return null // TimelineBlock 是 main|group union，先收窄才能访问组属性
    const headerMeta = block.header ? subtaskMetaOf(block.header) : undefined
    const endItem = block.children.find((c) => subtaskMetaOf(c).sdkSubtype === 'task_notification')
    const endMeta = endItem ? subtaskMetaOf(endItem) : undefined
    const status = subtaskStatusOf(endItem ? { payload: endMeta } : block.header ? { payload: headerMeta } : undefined)
    const aggregate = aggregateSubTaskProgress(progressSamplesOf(block.children))
    const absorbed = absorbedOutputByTaskId.get(block.taskId)
    // 发起调用吸收成功(task_started.tool_use_id 关联到父块工具事件)时,
    // header 呈现为 Agent 调用样式(工具名 + 调用摘要,无 "Tools -" 前缀);
    // 老数据关联不上发起调用时回退 SubTaskHeader(纯说明)。
    const spawnerPair = headerMeta?.toolUseId ? allToolPairs.get(headerMeta.toolUseId) : undefined
    const spawnerAnchor = spawnerPair ? (spawnerPair.inputItem ?? spawnerPair.resultItem) : undefined
    const spawnerName = spawnerPair
      ? ((spawnerPair.inputItem?.payload as { toolName?: string } | undefined)?.toolName ??
        (spawnerPair.resultItem?.payload as { toolName?: string } | undefined)?.toolName ??
        spawnerAnchor?.title ??
        'Agent')
      : undefined
    const spawnerInput = spawnerPair?.inputItem
      ? ((spawnerPair.inputItem.payload as { input?: unknown } | undefined)?.input ?? spawnerPair.inputItem.detail)
      : undefined
    // 卡内容区:可见 children(工具行/消息) + nested 子卡,按时间合并排序。
    const visibleChildren = block.children.filter((c) => {
      const subtype = subtaskMetaOf(c).sdkSubtype
      return subtype !== 'task_started' && subtype !== 'task_progress' && subtype !== 'task_notification'
    })
    const childPairs = pairToolCalls<TimelineItem>(
      visibleChildren,
      (item) => {
        if (item.kind !== 'tool') return undefined
        const p = item.payload as { toolUseId?: string } | undefined
        return typeof p?.toolUseId === 'string' ? p.toolUseId : undefined
      },
      (item) => {
        const p = item.payload as { phase?: string } | undefined
        return p?.phase === 'result'
      }
    )
    const merged: Array<{ time: number; node: ReactNode }> = visibleChildren.map((child) => ({
      time: Date.parse(child.createdAt) || 0,
      node: <Fragment key={child.id}>{renderSubTaskChild(child, live, spawnerTaskByCallId, childPairs)}</Fragment>
    }))
    block.nested.forEach((nested, nestedIndex) => {
      if (nested.kind !== 'group') return // main 块无 header/taskId，先收窄（理论上 nested 只产 group）
      const nestedHeaderMeta = nested.header ? subtaskMetaOf(nested.header) : undefined
      const nestedSpawner = nestedHeaderMeta?.toolUseId
        ? (childPairs.get(nestedHeaderMeta.toolUseId) ?? allToolPairs.get(nestedHeaderMeta.toolUseId))
        : undefined
      const anchorItem = nestedSpawner?.inputItem ?? nestedSpawner?.resultItem ?? nested.header
      merged.push({
        time: (anchorItem ? Date.parse(anchorItem.createdAt) : 0) || 0,
        node: (
          <Fragment key={`nested-${nested.taskId}-${nestedIndex}`}>{renderGroup(nested, nestedIndex, true)}</Fragment>
        )
      })
    })
    merged.sort((a, b) => a.time - b.time)
    return (
      <div
        key={`g-${block.taskId}-${index}`}
        className={cn('mb-4', nestedCard && 'ml-7 border-l-2 border-border/40 pl-3')}
      >
        <SubTaskGroup
          taskId={block.taskId}
          createdAt={block.header?.createdAt}
          className="mb-0"
          header={
            spawnerName ? (
              <SubTaskAgentHeader
                name={spawnerName}
                summary={toolInputSummary(spawnerInput)}
                taskType={headerMeta?.taskType}
                subagentType={headerMeta?.subagentType}
                status={status}
              />
            ) : (
              <SubTaskHeader
                description={headerMeta?.description ?? block.header?.detail}
                taskType={headerMeta?.taskType}
                subagentType={headerMeta?.subagentType}
                status={status}
              />
            )
          }
        >
          <SubTaskProgressSummary aggregate={aggregate} running={status === 'running'} />
          {merged.map((entry) => entry.node)}
          <SubTaskResultBlock output={absorbed?.output} isError={absorbed?.isError} />
        </SubTaskGroup>
      </div>
    )
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
        return renderGroup(block, index)
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
 * 单个子条目渲染(renderGroup 的合并排序单元):
 * - task_started / task_progress / task_notification 由调用方过滤(分别已折进 header / 统计行 / 收尾块);
 * - tool 事件按 toolUseId 配对成 ToolCallRow;发起子任务的委派调用(spawnerByCallId 命中)
 *   不再渲染 —— 嵌套的子 Agent 卡就是它的呈现,避免「委派调用行 + 子卡」重复;
 * - 配对后的工具行锚定在 use(否则 result)出现的位置;
 * - 其它(message / status 等)走 TimelineEntryBody。
 */
function renderSubTaskChild(
  child: TimelineItem,
  live: boolean | undefined,
  spawnerByCallId: Map<string, string>,
  pairByCallId: Map<string, ToolCallPair<TimelineItem>>
): ReactNode {
  if (child.kind === 'tool') {
    const payload = child.payload as { toolUseId?: string } | undefined
    const callId = typeof payload?.toolUseId === 'string' ? payload.toolUseId : undefined
    if (callId && spawnerByCallId.has(callId)) return null // 吸收进嵌套子 Agent 卡
    const pair = callId ? pairByCallId.get(callId) : undefined
    if (pair) {
      const anchor = pair.inputItem ?? pair.resultItem
      if (anchor && anchor.id !== child.id) return null
      return toolRowFromPair(pair, live)
    }
    return (
      <ToolCallRow
        name={child.title}
        summary={toolInputSummary(child.detail)}
        input={child.detail}
        createdAt={child.createdAt}
      />
    )
  }
  return <TimelineEntryBody item={child} />
}
