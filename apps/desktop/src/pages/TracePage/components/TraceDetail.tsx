import { Fragment, useMemo, useState, type ReactNode } from 'react'
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
  SearchIcon,
  ShieldIcon,
  SparklesIcon,
  XIcon,
  type LucideIcon
} from 'lucide-react'
import type { TraceEntry, TraceEntryType, TraceKind, TraceSummary } from '@task-pipeline/core'
import { api } from '../../../api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  SubTaskGroup,
  SubTaskHeader,
  SubTaskProgressSummary,
  SubTaskResultBlock,
  ToolCallRow,
  aggregateSubTaskProgress,
  interleaveTimeline,
  isEmptyToolInput,
  isHiddenTimelineEvent,
  subtaskMetaOf,
  subtaskStatusOf,
  toolInputSummary,
  type SubTaskProgressSample,
  type SubtaskMeta
} from '@/components/SubTaskGroup'
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
  cacheReadTokens?: number
  cacheWriteTokens?: number
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
  const usage = p.usage as
    | { input?: number; output?: number; cost?: number; cacheRead?: number; cacheWrite?: number }
    | undefined
  if (usage && (typeof usage.input === 'number' || typeof usage.output === 'number')) {
    meta.inputTokens = usage.input ?? 0
    meta.outputTokens = usage.output ?? 0
    if (typeof usage.cacheRead === 'number' && usage.cacheRead > 0) meta.cacheReadTokens = usage.cacheRead
    if (typeof usage.cacheWrite === 'number' && usage.cacheWrite > 0) meta.cacheWriteTokens = usage.cacheWrite
    if (typeof usage.cost === 'number') meta.costUsd = usage.cost
  }
  return meta
}

/** 字段级合并:target 缺失的字段用 source 补上(双源合并时各取所有)。 */
function mergeMeta(target: EntryMeta, source: EntryMeta): EntryMeta {
  return {
    model: target.model ?? source.model,
    durationMs: target.durationMs ?? source.durationMs,
    inputTokens: target.inputTokens ?? source.inputTokens,
    outputTokens: target.outputTokens ?? source.outputTokens,
    cacheReadTokens: target.cacheReadTokens ?? source.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens ?? source.cacheWriteTokens,
    costUsd: target.costUsd ?? source.costUsd,
    stopReason: target.stopReason ?? source.stopReason,
    isError: target.isError ?? source.isError
  }
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
          title={`输入 ${meta.inputTokens} · 输出 ${meta.outputTokens ?? 0}${meta.cacheReadTokens ? ` · 缓存读 ${meta.cacheReadTokens}` : ''}${meta.cacheWriteTokens ? ` · 缓存写 ${meta.cacheWriteTokens}` : ''}`}
        >
          ↑{formatTokens(meta.inputTokens)} ↓{formatTokens(meta.outputTokens ?? 0)}
          {meta.cacheReadTokens !== undefined && (
            <span className="text-sky-600 dark:text-sky-400"> C{formatTokens(meta.cacheReadTokens)}</span>
          )}
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

// === 工具条目归一化与双源去重 ================================================

/** 三源工具条目的归一化形态。 */
type NormalizedTool = {
  /** events 源叫 toolUseId,qoder / chat 源叫 toolCallId —— 统一成 callId。 */
  callId?: string
  name: string
  input?: unknown
  output?: unknown
  isError?: boolean
  /** 是否已带结果(决定 status 与「输出」段)。 */
  hasResult: boolean
}

/**
 * 把三种来源的工具条目归一化:
 * - events 源(log.ts): type='tool_call',payload 带 `toolUseId` + `phase: 'use'|'result'` + input/output;
 * - qoder 源(qoder-trace.ts): 解析层已配对,`toolCallId` + `input` + `result` 同挂一条;
 * - chat 源(chat-entries.ts): tool_call / tool_result 两条独立,`toolCallId` + input/output。
 */
function normalizeToolEntry(entry: TraceEntry): NormalizedTool {
  const p = (entry.payload ?? {}) as Record<string, unknown>
  const callId =
    (typeof p.toolUseId === 'string' && p.toolUseId) || (typeof p.toolCallId === 'string' && p.toolCallId) || undefined
  // 名字兜底:payload.toolName 优先;title 形如「工具 Read」时剥前缀;「工具结果」原样保留。
  const stripped = entry.title.replace(/^工具\s+/, '')
  const name = (typeof p.toolName === 'string' && p.toolName) || stripped || entry.title
  if (p.phase === 'result') {
    return { callId, name, output: p.output ?? entry.detail, isError: p.isError === true, hasResult: true }
  }
  if (p.phase === 'use') {
    return { callId, name, input: p.input ?? entry.detail, hasResult: false }
  }
  if (entry.type === 'tool_result') {
    return { callId, name, output: p.output ?? entry.detail, isError: p.isError === true, hasResult: true }
  }
  const hasResult = 'result' in p
  return {
    callId,
    name,
    input: p.input ?? entry.detail,
    output: hasResult ? p.result : undefined,
    isError: p.isError === true,
    hasResult
  }
}

/** 按 callId 合并后的工具行(渲染锚点 = 首个出现的条目)。 */
type ToolRow = {
  callId: string
  anchorId: string
  name: string
  input?: unknown
  output?: unknown
  isError?: boolean
  hasResult: boolean
  createdAt: string
  meta: EntryMeta
}

/**
 * 同 callId 的条目合并成一行 —— 任务详情是 events + qoder 两源合并(mergeTaskTrace),
 * 同一工具调用会出现两次(events 的 use/result + qoder 已配对条目),这里按 callId 去重,
 * input/output/meta 各取先见者,渲染锚定在首个条目位置。
 */
function buildToolRows(entries: TraceEntry[]): Map<string, ToolRow> {
  const rows = new Map<string, ToolRow>()
  for (const entry of entries) {
    if (entry.type !== 'tool_call' && entry.type !== 'tool_result') continue
    const norm = normalizeToolEntry(entry)
    if (!norm.callId) continue
    let row = rows.get(norm.callId)
    if (!row) {
      row = {
        callId: norm.callId,
        anchorId: entry.id,
        name: norm.name,
        createdAt: entry.createdAt,
        hasResult: false,
        meta: {}
      }
      rows.set(norm.callId, row)
    }
    if (!isEmptyToolInput(norm.input) && isEmptyToolInput(row.input)) row.input = norm.input
    if (norm.output !== undefined && row.output === undefined) row.output = norm.output
    if (norm.hasResult) row.hasResult = true
    if (norm.isError) row.isError = true
    if ((row.name === '工具结果' || row.name === 'tool') && norm.name !== row.name) row.name = norm.name
    row.meta = mergeMeta(row.meta, extractMeta(entry))
  }
  return rows
}

function toolRowNode(row: ToolRow): ReactNode {
  return (
    <ToolCallRow
      name={row.name}
      summary={toolInputSummary(row.input)}
      input={row.input}
      output={row.output}
      status={row.isError ? 'error' : 'done'}
      createdAt={row.createdAt}
      metaBadges={<MetaBadges meta={row.meta} />}
    />
  )
}

/** 无 callId 的老数据 / 配对表缺失时的单行兜底。 */
function fallbackToolRow(entry: TraceEntry): ReactNode {
  const norm = normalizeToolEntry(entry)
  return (
    <ToolCallRow
      name={norm.name}
      summary={toolInputSummary(norm.input ?? entry.detail)}
      input={norm.input}
      output={norm.output}
      status={norm.isError ? 'error' : 'done'}
      createdAt={entry.createdAt}
      metaBadges={<MetaBadges meta={extractMeta(entry)} />}
    />
  )
}

/** 带归一化子任务元信息的 entry —— meta 由共享 subtaskMetaOf 提取(含历史数据兑底)。 */
type IndexedEntry = { entry: TraceEntry; meta: SubtaskMeta }

/** entry 顶层字段优先(qoder 源 / eventToTraceEntry 提升),meta 兑底(events 老数据 detail 反解)。 */
function subtypeOf(indexed: IndexedEntry): string | undefined {
  return indexed.entry.sdkSubtype ?? indexed.meta.sdkSubtype
}

/** 从 children 里抽 task_progress 样本,喂给共享的 aggregateSubTaskProgress。 */
function progressSamplesOf(children: IndexedEntry[]): SubTaskProgressSample[] {
  const samples: SubTaskProgressSample[] = []
  for (const child of children) {
    if (subtypeOf(child) !== 'task_progress') continue
    samples.push({
      lastToolName: child.meta.lastToolName,
      description: child.meta.description,
      usage: child.meta.usage as SubTaskProgressSample['usage']
    })
  }
  return samples
}

/**
 * 子任务 group 的 children 按类别路由:
 * - task_started / task_progress / task_notification 不直接渲染(分别折进 header / 统计行 / 状态徽章);
 * - tool_call / tool_result 按 callId 合并成 ToolCallRow(带 MetaBadges);
 * - 其它(message / thinking / status 等)走 TraceEntryItem。
 */
function renderSubTaskChildren(children: IndexedEntry[]): ReactNode {
  const visible = children.filter((c) => {
    const st = subtypeOf(c)
    return st !== 'task_started' && st !== 'task_progress' && st !== 'task_notification'
  })
  const rows = buildToolRows(visible.map((c) => c.entry))
  return visible.map((child) => {
    const entry = child.entry
    if (entry.type === 'tool_call' || entry.type === 'tool_result') {
      const norm = normalizeToolEntry(entry)
      const row = norm.callId ? rows.get(norm.callId) : undefined
      if (row) {
        if (row.anchorId !== entry.id) return null
        return <Fragment key={entry.id}>{toolRowNode(row)}</Fragment>
      }
      return <Fragment key={entry.id}>{fallbackToolRow(entry)}</Fragment>
    }
    return <TraceEntryItem key={entry.id} entry={entry} />
  })
}

/**
 * Trace 时间线渲染。
 *
 * 1. `interleaveTimeline`,子任务折叠卡锚定在 task_started 的真实时间点;
 *    entry 的子任务归属走「顶层字段 + subtaskMetaOf(含老数据 detail 反解兑底)」双通道,
 *    所以 events 老数据(payload 空、title=`Qoder task_*`)也能正确入组,不再平铺大 JSON;
 * 2. 主流程工具调用 → ToolCallRow(紧凑单行,点击展开输入/输出),保留 MetaBadges(模型/耗时/tokens);
 *    发起子任务的那条调用(task_started.tool_use_id 命中)被吸收进子任务卡,不再单独成行;
 * 3. `task_progress` 聚合成卡片顶部统计行,`task_notification` 只驱动 header 状态徽章
 *    (SDK 语义:它是子任务整体状态收尾,内容不重复展示)。
 */
function TraceEntryTimeline({ entries }: { entries: TraceEntry[] }) {
  // 预归一化:每条 entry 算出 SubtaskMeta(payload + 历史 detail JSON 双通道),
  // interleaveTimeline 按「顶层字段 ?? meta」构造 parented 形态。
  const blocks = useMemo(() => {
    const indexed = entries
      .filter((entry) => !isHiddenTimelineEvent(entry.title))
      .map((entry): IndexedEntry => ({ entry, meta: subtaskMetaOf(entry) }))
    // 旧数据兼容:流式 agent_text 曾按 delta 粒度落库,相邻 agent 消息碎片合并成完整段落。
    // - events 源：Qoder/OpenAI 流式文本碎片，直接合并；
    // - chat 源：openai driver 早期按 delta 落盘导致的碎 part，仅同一条消息（createdAt 相同）合并，
    //   跨消息不合并（相邻 AI 消息必被 user 消息隔开，createdAt 即消息归属）。
    const isAgentMsg = (e: IndexedEntry) =>
      e.entry.type === 'message' &&
      /^(?:qoder agent|openai agent|ai)$/i.test(e.entry.title.trim()) &&
      (e.entry.source === 'events' || e.entry.source === 'chat')
    // 归一化 parentTaskId：undefined 与 undefined 相等（主流程），有值按值比较；
    // 跨子任务作用域的相邻 AI 消息不得拼接（否则子任务文本被并入主流程并从折叠卡消失）。
    const scopeOf = (e: IndexedEntry) => e.entry.parentTaskId ?? e.meta.parentTaskId ?? ''
    const merged: IndexedEntry[] = []
    for (const current of indexed) {
      const last = merged[merged.length - 1]
      if (
        last &&
        isAgentMsg(current) &&
        isAgentMsg(last) &&
        scopeOf(last) === scopeOf(current) &&
        (last.entry.source === 'events' || last.entry.createdAt === current.entry.createdAt)
      ) {
        merged[merged.length - 1] = {
          ...last,
          entry: {
            ...last.entry,
            detail: [last.entry.detail, current.entry.detail].filter(Boolean).join('')
          }
        }
        continue
      }
      merged.push(current)
    }
    const parented = merged.map(({ entry, meta }) => ({
      id: entry.id,
      parentTaskId: entry.parentTaskId ?? meta.parentTaskId,
      taskId: entry.taskId ?? meta.subtaskId,
      subtaskId: meta.subtaskId,
      sdkSubtype: entry.sdkSubtype ?? meta.sdkSubtype
    }))
    // byId 必须映射 merged(合并后)而非 indexed:渲染时按 id 取回的是已拼接 detail 的条目,
    // 否则上面相邻碎片合并白做 —— 每条 still 渲染成独立小块(历史 bug:Qoder 消息按 delta 分块)。
    const byId = new Map(merged.map((x) => [x.entry.id, x]))
    return interleaveTimeline(parented).map((block) =>
      block.kind === 'main'
        ? { kind: 'main' as const, item: byId.get(block.item.id) as IndexedEntry }
        : {
            kind: 'group' as const,
            taskId: block.taskId,
            header: block.header ? (byId.get(block.header.id) as IndexedEntry | undefined) : undefined,
            children: block.children.map((c) => byId.get(c.id) as IndexedEntry)
          }
    )
  }, [entries])

  // 主流程里发起子任务的工具调用(task_started.tool_use_id → taskId,老数据从 detail 反解)。
  // 这些调用不再单独渲染成行 —— 子任务折叠卡就是它们的呈现(跟 Qoder 一致)。
  const spawnerTaskByCallId = useMemo(() => {
    const map = new Map<string, string>()
    for (const block of blocks) {
      if (block.kind !== 'group') continue
      const toolUseId = block.header?.meta.toolUseId
      if (toolUseId) map.set(toolUseId, block.taskId)
    }
    return map
  }, [blocks])

  // 主流程工具条目配对 + 双源去重(仅 main 块;子任务内的在 renderSubTaskChildren 里单独配)。
  const mainToolRows = useMemo(() => {
    const mains = blocks.flatMap((block) => (block.kind === 'main' ? [block.item.entry] : []))
    return buildToolRows(mains)
  }, [blocks])

  // 被吸收调用的结果输出(taskId → output),作为卡片底部「输出」段。
  const absorbedOutputByTaskId = useMemo(() => {
    const map = new Map<string, { output?: unknown; isError?: boolean }>()
    for (const [callId, taskId] of spawnerTaskByCallId) {
      const row = mainToolRows.get(callId)
      if (!row?.hasResult) continue
      map.set(taskId, { output: row.output, isError: row.isError })
    }
    return map
  }, [spawnerTaskByCallId, mainToolRows])

  /** 主流程单条渲染:tool 条目 → ToolCallRow(配对 + 吸收),其它 → TraceEntryItem。 */
  const renderMainEntry = (entry: TraceEntry): ReactNode => {
    if (entry.type === 'tool_call' || entry.type === 'tool_result') {
      const norm = normalizeToolEntry(entry)
      if (norm.callId) {
        if (spawnerTaskByCallId.has(norm.callId)) return null // 吸收进子任务卡
        const row = mainToolRows.get(norm.callId)
        if (row) {
          if (row.anchorId !== entry.id) return null // 只在锚点位置渲染一次
          return toolRowNode(row)
        }
      }
      return fallbackToolRow(entry)
    }
    return <TraceEntryItem entry={entry} />
  }

  return (
    <>
      {blocks.map((block) => {
        if (block.kind === 'main') {
          return <Fragment key={block.item.entry.id}>{renderMainEntry(block.item.entry)}</Fragment>
        }
        // group:header 用 task_started 的元信息(description + task_type + subagent_type 徽章);
        // task_progress 聚合成统计行,task_notification 只驱动 header 状态徽章(内容不重复展示),
        // 子条目只剩工具行 + 文本块 —— 跟 Qoder 子任务展示一致。
        const headerMeta = block.header?.meta
        const endEntry = block.children.find((c) => subtypeOf(c) === 'task_notification')
        const statusSource = endEntry ?? block.header
        const status = subtaskStatusOf(statusSource ? { payload: { status: statusSource.meta.status } } : undefined)
        const aggregate = aggregateSubTaskProgress(progressSamplesOf(block.children))
        const absorbed = absorbedOutputByTaskId.get(block.taskId)
        return (
          <SubTaskGroup
            key={block.taskId}
            taskId={block.taskId}
            createdAt={block.header?.entry.createdAt}
            header={
              <SubTaskHeader
                description={headerMeta?.description ?? block.header?.entry.detail}
                taskType={headerMeta?.taskType}
                subagentType={headerMeta?.subagentType}
                status={status}
              />
            }
          >
            <SubTaskProgressSummary aggregate={aggregate} running={status === 'running'} />
            {renderSubTaskChildren(block.children)}
            <SubTaskResultBlock output={absorbed?.output} isError={absorbed?.isError} />
          </SubTaskGroup>
        )
      })}
    </>
  )
}

function StatsOverview({ stats }: { stats: TraceSummary['stats'] }) {
  if (!stats) return null
  const hasAny =
    stats.model ||
    (stats.tokens && stats.tokens.total > 0) ||
    typeof stats.costUsd === 'number' ||
    typeof stats.durationMs === 'number' ||
    (stats.toolStats && stats.toolStats.length > 0) ||
    typeof stats.errorCount === 'number'
  if (!hasAny) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {stats.model && (
        <Badge variant="outline" className="max-w-48 truncate px-1.5 py-0 font-mono text-[10px]">
          {stats.model}
        </Badge>
      )}
      {stats.tokens && stats.tokens.total > 0 && (
        <Badge
          variant="secondary"
          className="px-1.5 py-0 text-[10px]"
          title={`输入 ${stats.tokens.input} · 输出 ${stats.tokens.output}${stats.tokens.cacheRead ? ` · 缓存读 ${stats.tokens.cacheRead}` : ''}${stats.tokens.cacheWrite ? ` · 缓存写 ${stats.tokens.cacheWrite}` : ''}`}
        >
          ↑{formatTokens(stats.tokens.input)} ↓{formatTokens(stats.tokens.output)}（{formatTokens(stats.tokens.total)}）
          {typeof stats.tokens.cacheRead === 'number' && stats.tokens.cacheRead > 0 && (
            <span className="text-sky-600 dark:text-sky-400"> C{formatTokens(stats.tokens.cacheRead)}</span>
          )}
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
      {stats.toolStats && stats.toolStats.length > 0 && (
        <Badge
          variant="outline"
          className="max-w-64 truncate px-1.5 py-0 text-[10px]"
          title={stats.toolStats.map((t) => `${t.name}×${t.count}${t.errors ? `（错${t.errors}）` : ''}`).join('\n')}
        >
          🛠 {stats.toolStats.length} 种工具
        </Badge>
      )}
      {typeof stats.errorCount === 'number' && stats.errorCount > 0 && (
        <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
          ✕ {stats.errorCount} 次错误
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
  // 详情全文搜索：匹配 title / detail / payload 的 JSON 文本，纯前端过滤。
  const [searchQuery, setSearchQuery] = useState('')
  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((entry) => {
      const haystack = [
        entry.title,
        entry.detail,
        entry.payload ? JSON.stringify(entry.payload) : '',
        entry.source
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [entries, searchQuery])

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
          {searchQuery.trim() && !loading && (
            <span className="text-[10px] text-muted-foreground">
              匹配 {filteredEntries.length}/{entries.length}
            </span>
          )}
          <div className="relative">
            <SearchIcon
              size={13}
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索详情…"
              className="h-7 w-36 pl-7 text-xs!"
            />
          </div>
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
        ) : filteredEntries.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-1 text-muted-foreground">
            <SparklesIcon size={20} />
            <strong className="text-xs">{entries.length === 0 ? '暂无执行记录' : '无匹配条目'}</strong>
            <span className="text-xs">
              {entries.length === 0 ? '该 Trace 尚未产生事件' : `没有包含「${searchQuery.trim()}」的记录`}
            </span>
          </div>
        ) : (
          <TraceEntryTimeline entries={filteredEntries} />
        )}
      </div>
    </div>
  )
}
