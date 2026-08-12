import { useMemo, useState } from 'react'
import { ChevronRightIcon, ChevronDownIcon } from 'lucide-react'
import type { AgentSpan, SpanType } from '@task-pipeline/core'
// 共享归属重定向 / 阶段显示名（与 electron trace-service 同一份规则，避免双端漂移）。
// 子路径直引：core 包根入口含 node 依赖（storage/better-sqlite3），不能进浏览器包。
import {
  buildSpanOwnershipIndex,
  delegateToolIdOf,
  isDelegateToolSpan,
  ownerSubtaskOf
} from '@task-pipeline/core/dist/trace/span-ownership.js'
import { agentStageLabel } from '@task-pipeline/core/dist/trace/stage-label.js'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'

const TYPE_COLORS: Record<SpanType, { bar: string; label: string }> = {
  'session.start': { bar: 'bg-emerald-400/80', label: 'text-emerald-400' },
  'task.run': { bar: 'bg-emerald-400/80', label: 'text-emerald-400' },
  'agent.run': { bar: 'bg-violet-400/80', label: 'text-violet-400' },
  'llm.generate': { bar: 'bg-purple-400/85', label: 'text-purple-400' },
  'tool.execute': { bar: 'bg-sky-400/80', label: 'text-sky-400' },
  'subtask.run': { bar: 'bg-amber-400/80', label: 'text-amber-400' }
}

const TYPE_LABELS: Record<SpanType, string> = {
  'session.start': '会话',
  'task.run': '任务',
  'agent.run': 'Agent',
  'llm.generate': 'LLM',
  'tool.execute': '工具',
  'subtask.run': '子任务'
}

/**
 * 固定列模板（头部标尺与数据行共用，保证时间轴列在所有行对齐）：
 * 树列（箭头+类型+名称，宽度固定，缩进只影响内容） / 时间轴列（最小 20rem，容器过窄时横向滚动而非压缩）/ 耗时列。
 */
const ROW_GRID = 'grid-cols-[15rem_minmax(20rem,1fr)_3.5rem]'
/** 列最小总宽（15 + 20 + 3.5rem），低于此宽度时出现横向滚动条。 */
const ROW_MIN_W_CLASS = 'min-w-[38.5rem]'

/** 时间轴刻度（相对总时长的比例），同时驱动网格线与标尺标签。 */
const TICKS = [0, 0.25, 0.5, 0.75, 1]

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 工具 span 的 input 是否为对象（供读取委派 description / subagent_type）。 */
function toolInputOf(span: AgentSpan): Record<string, unknown> | undefined {
  return span.input !== null && typeof span.input === 'object' && !Array.isArray(span.input)
    ? (span.input as Record<string, unknown>)
    : undefined
}

/**
 * Qoder 委派子 Agent 的工具行判定：见 core 共享实现 isDelegateToolSpan
 * （tool.execute + 委派工具名 + input.description 非空；Bash 等普通工具的 description 不误判）。
 */
const isDelegatedAgent = isDelegateToolSpan

/**
 * 空壳 llm：纯工具回合产生的 0ms 无输出记录（修复前的旧数据残留）。
 * 这类 span 没有模型输出也没有耗时，渲染只会刷屏 —— 拍平（不渲染行、子项上提）。
 */
function isVacantLlm(span: AgentSpan): boolean {
  return span.type === 'llm.generate' && span.output === undefined && (span.durationMs ?? 0) < 2
}

/** 被拍平、不渲染行的层级：子项沿父链上提时跳过这些类型。 */
function isFlattened(span: AgentSpan): boolean {
  // subtask.run 说明层 / 空壳 llm / 根 span（task.run/session.start 根拍平：数据保留，仅展示拍平，
  // 恢复场景可能出现的存量双根同样被拍平兼容）。
  return span.type === 'subtask.run' || span.type === 'task.run' || span.type === 'session.start' || isVacantLlm(span)
}

/**
 * 沿父链找最近一个「会渲染行」的父级：subtask.run 说明层 / 空壳 llm / 根 span 均被拍平跳过。
 * subtask.run 是「委派工具 + 说明」的纯说明层，其子项上提到委派工具层级（见 buildTree 重定向）；
 * 嵌套子任务（subtask 套 subtask）递归提升。悬空父（不在 byId）返回 undefined → 顶层。
 */
function liftedParentId(span: AgentSpan, byId: Map<string, AgentSpan>): string | undefined {
  let parentId = span.parentSpanId
  while (parentId) {
    const parent = byId.get(parentId)
    if (!parent) return undefined
    if (!isFlattened(parent)) return parent.spanId
    parentId = parent.parentSpanId
  }
  return undefined
}

function buildTree(spans: AgentSpan[]): { roots: AgentSpan[]; children: Map<string, AgentSpan[]> } {
  // 归属重定向索引（与 trace-service.spansToAgentEvents 共用同一套 core 规则）：
  // 新数据按 meta.parentToolUseId 链解析子代理内部 span 的真实归属（task_started 滞后时
  // parentSpanId 只是当时锚点）；旧数据（parentSpanId 已被改写）由 parentSpanId 走查兼容。
  const ownership = buildSpanOwnershipIndex(spans)
  const byId = ownership.byId
  const children = new Map<string, AgentSpan[]>()
  const roots: AgentSpan[] = []

  for (const span of spans) {
    if (isFlattened(span)) continue // 说明层/空壳/根：不渲染自身行
    let effectiveParentId = liftedParentId(span, byId)

    // 归属重定向：子代理内部 span 挂到所属子任务的委派工具行下（subtask.run 已拍平，
    // 委派工具行就是子任务在瀑布图里的可视容器）。委派工具自身不会被重定向到自己
    // （旧数据 delegateToolId === span.spanId 时保持 lifted 结果）。
    const owner = ownerSubtaskOf(span, ownership)
    if (owner) {
      const delegateToolId = delegateToolIdOf(owner, ownership)
      if (delegateToolId && delegateToolId !== span.spanId) {
        effectiveParentId = delegateToolId
      }
    }

    if (effectiveParentId) {
      const list = children.get(effectiveParentId) ?? []
      list.push(span)
      children.set(effectiveParentId, list)
    } else {
      roots.push(span)
    }
  }
  return { roots, children }
}

/**
 * 瀑布图 —— 横向时间轴 + 父子缩进 + 折叠/展开 + 异常高亮。
 * - 整行可点击选中（点击任意位置触发 onSelect，折叠箭头除外）；
 * - 时间轴列为固定网格列，所有行对齐同一时间刻度（缩进不影响色块定位）；
 * - 顶部标尺 + 行内网格线，色块长度 = 耗时占 Trace 总时长的比例。
 */
export function Waterfall({
  spans,
  selectedId,
  onSelect
}: {
  spans: AgentSpan[]
  selectedId?: string
  onSelect(span: AgentSpan): void
}) {
  const { roots, children } = useMemo(() => buildTree(spans), [spans])

  const timeAxis = useMemo(() => {
    if (spans.length === 0) return undefined
    let start = Infinity
    let end = -Infinity
    for (const span of spans) {
      if (span.startedAt < start) start = span.startedAt
      const sEnd = span.endedAt ?? span.startedAt
      if (sEnd > end) end = sEnd
    }
    const total = Math.max(1, end - start)
    return { start, total }
  }, [spans])

  // 折叠集合：默认折叠 depth > 1 的节点子树（长链路中间步骤），用户可手动展开。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (spanId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(spanId)) next.delete(spanId)
      else next.add(spanId)
      return next
    })
  }
  const collapseAll = () => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      for (const span of spans) if (span.type !== 'llm.generate') next.add(span.spanId)
      return next
    })
  }
  const expandAll = () => setCollapsed(new Set())

  if (spans.length === 0 || !timeAxis) {
    return <div className="p-6 text-center text-xs text-muted-foreground">该 Trace 尚未产生 span 数据</div>
  }

  const countErrors = (node: AgentSpan, childrenMap: Map<string, AgentSpan[]>): number => {
    let n = node.status === 'error' ? 1 : 0
    for (const child of childrenMap.get(node.spanId) ?? []) n += countErrors(child, childrenMap)
    return n
  }

  const renderRow = (span: AgentSpan, depth: number) => {
    const kids = children.get(span.spanId) ?? []
    const isCollapsed = collapsed.has(span.spanId)
    const isError = span.status === 'error'
    // cancelled：未正常收尾（SDK 消息流中断/兜底关闭），弱化展示，不再伪装成正常长条。
    const isCancelled = span.status === 'cancelled'
    // 委派子 Agent 的工具行按 Agent 语义展示：violet 色 + input.description 名称 + subagent_type 徽章。
    const delegated = isDelegatedAgent(span)
    const input = toolInputOf(span)
    const color = delegated ? TYPE_COLORS['agent.run'] : TYPE_COLORS[span.type]
    // agent.run 阶段容器的类型标签按 meta.phase（及 trigger/round）显示阶段名（Plan/Exec/CodeReview…），
    // 不再是笼统的 Agent；共享映射与执行 Tab 阶段卡一致。
    const stageLabel = agentStageLabel(span)
    const typeLabel = delegated ? 'Agent' : (stageLabel ?? TYPE_LABELS[span.type])
    const displayName = delegated ? String(input!.description) : span.name
    const leftPct = ((span.startedAt - timeAxis.start) / timeAxis.total) * 100
    const widthPct = Math.max(1.5, (((span.endedAt ?? span.startedAt + 1) - span.startedAt) / timeAxis.total) * 100)
    const durationMs = span.durationMs ?? (span.endedAt !== undefined ? span.endedAt - span.startedAt : undefined)
    const errorCount = isError ? countErrors(span, children) : 0
    const isSelected = selectedId === span.spanId

    return (
      <div key={span.spanId}>
        <div
          role="button"
          tabIndex={0}
          aria-label={`选中 span ${displayName}`}
          onClick={() => onSelect(span)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelect(span)
            }
          }}
          className={cn(
            'group grid h-8 cursor-pointer items-center gap-x-1.5 border-b border-border/40 transition-colors hover:bg-accent/40',
            ROW_GRID,
            isSelected && 'bg-accent/60'
          )}
        >
          {/* 树列：缩进只影响本列内容，不移动时间轴 */}
          <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: 8 + depth * 18 }}>
            {kids.length > 0 && (
              <button
                type="button"
                aria-label={isCollapsed ? `展开 ${span.name}` : `折叠 ${span.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  toggle(span.spanId)
                }}
                className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent"
              >
                {isCollapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
              </button>
            )}
            <span className={cn('max-w-40 shrink-0 truncate text-[10px] tabular-nums', color.label)} title={typeLabel}>
              {typeLabel}
            </span>
            {/* 名称列：固定宽度、完整展示（title 悬浮全名），不受色块宽度影响 */}
            <span
              className="min-w-0 flex-1 truncate text-[11px] font-medium"
              title={`${displayName}${span.model ? `（${span.model}）` : ''}`}
            >
              {displayName}
              {delegated && typeof input!.subagent_type === 'string' && (
                <span className="ml-1.5 rounded border border-violet-400/40 bg-violet-400/10 px-1 py-px align-middle text-[9px] text-violet-400">
                  {input!.subagent_type}
                </span>
              )}
            </span>
          </div>
          {/* 时间轴列：网格线 + 色块（与标尺同列，全行对齐） */}
          <div className="relative h-full min-w-0">
            {TICKS.map((tick) => (
              <span
                key={tick}
                className="pointer-events-none absolute inset-y-0 w-px bg-border/20"
                style={{ left: `${tick * 100}%` }}
              />
            ))}
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="absolute top-[3px] bottom-[3px] cursor-pointer"
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                >
                  <div
                    className={cn(
                      'h-full w-full rounded-[3px] border border-black/10 shadow-sm transition-colors',
                      color.bar,
                      // cancelled 弱化：灰色虚框 + 去阴影，明确「未正常收尾」，不再伪装成正常长条。
                      isCancelled && 'border-dashed border-border/80 bg-muted-foreground/25 shadow-none',
                      isError && 'animate-[trace-blink_1.2s_ease-in-out_infinite] border-rose-400 bg-rose-500!',
                      isSelected && 'ring-2 ring-ring'
                    )}
                  />
                  {errorCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-rose-500 px-0.5 text-[9px] font-bold text-white ring-1 ring-background">
                      {errorCount}
                    </span>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-72 text-xs">
                <div className="font-semibold">{displayName}</div>
                <div className="text-muted-foreground">
                  {typeLabel} · {durationMs !== undefined ? formatDuration(durationMs) : '—'}
                  {span.model ? ` · ${span.model}` : ''}
                </div>
                {isError && <div className="text-rose-400">状态：error</div>}
                {isCancelled && <div className="text-muted-foreground">未正常收尾（cancelled）</div>}
              </TooltipContent>
            </Tooltip>
          </div>
          {/* 耗时列 */}
          <span className="pr-3 text-right text-[10px] text-muted-foreground tabular-nums">
            {durationMs !== undefined ? formatDuration(durationMs) : '—'}
          </span>
        </div>
        {kids.length > 0 && !isCollapsed && kids.map((kid) => renderRow(kid, depth + 1))}
        {kids.length > 0 && isCollapsed && (
          <Button
            size="sm"
            variant="ghost"
            className="w-full justify-start text-[10px]!"
            style={{ paddingLeft: 20 + depth * 18 }}
            onClick={() => toggle(span.spanId)}
          >
            <ChevronRightIcon size={11} />
            {kids.length} 个子步骤已折叠
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>
          {spans.length} 个 span · {formatDuration(timeAxis.total)} 总时长
        </span>
        <span className="flex items-center gap-2">
          <button type="button" className="hover:text-foreground" onClick={collapseAll}>
            折叠全部工具
          </button>
          <button type="button" className="hover:text-foreground" onClick={expandAll}>
            全部展开
          </button>
        </span>
      </div>
      {/* 标尺与数据行共享同一横向滚动容器：列模板一致，低于 ROW_MIN_W 时横向滚动而非压缩时间轴 */}
      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
        <div className={cn('w-full', ROW_MIN_W_CLASS)}>
          {/* 时间轴标尺：与数据行共用列模板，刻度位置一一对应 */}
          <div
            className={cn(
              'grid h-6 shrink-0 items-center border-b border-border/40 bg-muted/30 text-[9px] text-muted-foreground tabular-nums',
              ROW_GRID
            )}
          >
            <span className="pl-2">步骤</span>
            <div className="relative h-full">
              {TICKS.map((tick) => (
                <span
                  key={tick}
                  className="absolute top-[50%] whitespace-nowrap"
                  style={{
                    left: `${tick * 100}%`,
                    transform: `translateX(${tick === 0 ? 0 : tick === 1 ? -100 : -50}%) translateY(-50%)`
                  }}
                >
                  {tick === 0 ? '0s' : formatDuration(timeAxis.total * tick)}
                </span>
              ))}
            </div>
            <span className="pr-3 text-right">耗时</span>
          </div>
          <TooltipProvider delayDuration={120}>{roots.map((root) => renderRow(root, 0))}</TooltipProvider>
        </div>
      </div>
    </div>
  )
}
