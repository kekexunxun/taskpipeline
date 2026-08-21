/**
 * 子任务折叠视图 —— 跨 TracePage / CodingPage / ChatPage 共用。
 *
 * 数据流约定:
 * - 输入数据带 `parentTaskId?: string` 字段,undefined 表示主流程,有值表示"属于该子任务"。
 * - Qoder 源: qoder-trace.ts 解析时已注入 parentTaskId / taskId / sdkSubtype。
 * - ChatPage 源: DriverPart 通过新增的 qoder.subtask-* part 类型携带子任务结构。
 * - CodingPage 源: AgentEvent 在 useTasks 中按 TaskEvent 的子任务关联字段打 parentTaskId
 *   (这是后续步骤,这里只先暴露通用 UI 与工具,数据接入由各自页面负责)。
 *
 * 设计要点:
 * - 通用分组工具 `groupByParentTask<T>` 不耦合具体类型,只要 T extends { parentTaskId?: string } 即可。
 * - `SubTaskGroup` 组件走 Radix Collapsible,默认折叠(用户点击 header 展开),满足"默认全部折叠"的交互选择。
 * - Header 是 render prop,各页面按自己的 entry 形态提供视觉风格 —— 不在通用组件里硬编码图标/标题。
 * - 任务进度(task_progress)在 trace 源里用 `sdkSubtype` 标记,本组件不做特殊处理,
 *   渲染时由调用方决定是否把 progress 聚合到 header 还是逐条展示。
 */

import { useState, useEffect, type ReactNode } from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  CheckCircle2Icon,
  XCircleIcon,
  StopCircleIcon,
  //   GitBranchIcon,
  Code2Icon
} from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatDuration, formatTime, formatTokens } from '@/utils/format'

/** 任意带 parentTaskId 字段的条目都能被分组。 */
export type ParentedItem = {
  parentTaskId?: string
  /**
   * 子任务 ID 字段名(同义不同名):
   * - span meta 的 taskId —— subtask.run 的 subtaskId。
   * - AgentEvent.subtaskId —— AgentEvent.taskId 已被"归属任务"占用,改名 subtaskId。
   * - DriverPart 通过 taskId 直接传入(part-level 命名空间不冲突)。
   * 工具的 `header` 查找会同时识别 taskId / subtaskId,避免数据层命名漂移导致分组丢头。
   */
  taskId?: string
  subtaskId?: string
  sdkSubtype?: string
  /**
   * 所属 agent.run 阶段 id（planning/implementing 等阶段容器）：
   * 带此值的子任务组会被嵌套进对应阶段组，而不是与阶段卡平级 ——
   * 执行面板的「Agent planning 卡 → Explore 子 Agent 卡 → 工具」层级由此实现。
   */
  stageId?: string
}

/**
 * 把一个扁平列表按 parentTaskId 拆成"主流程 + 子任务组",保持原有顺序。
 *
 * - 主流程条目按原顺序保留。
 * - 同 parentTaskId 的连续条目聚成同一子任务组(同一 group 的 children 也按原顺序)。
 * - 找不到匹配的孤立条目(例如 parent_task_id 指向一个没出现的 task_started)降级为主流程,避免丢数据。
 *   真正的"孤儿"判断由数据层(trace 解析)负责,这里只做结构化。
 */
export function groupByParentTask<T extends ParentedItem>(
  items: T[]
): {
  main: T[]
  groups: Array<{ taskId: string; header: T | undefined; children: T[] }>
} {
  const main: T[] = []
  const groups: Array<{ taskId: string; header: T | undefined; children: T[] }> = []
  const indexByTaskId = new Map<string, number>()

  for (const item of items) {
    const parent = item.parentTaskId
    if (!parent) {
      main.push(item)
      continue
    }
    let idx = indexByTaskId.get(parent)
    if (idx === undefined) {
      idx = groups.length
      indexByTaskId.set(parent, idx)
      groups.push({ taskId: parent, header: undefined, children: [] })
    }
    const group = groups[idx]!
    // 子任务入口(task_started / task_started 类)作为 group header,避免重复进入 children
    // `parent` 与本项自带的 taskId / subtaskId 同值时 → 它是子任务自己的起点。
    if (
      item.sdkSubtype === 'task_started' ||
      (item.taskId === parent && !group.header) ||
      (item.subtaskId === parent && !group.header)
    ) {
      group.header = item
    } else {
      group.children.push(item)
    }
  }
  return { main, groups }
}

/**
 * Timeline 渲染用的"时间穿插"块数组。
 *
 * - `main`: 主流程条目,直接渲染
 * - `group`: 子任务折叠卡,渲染 SubTaskGroup
 *
 * 与 `groupByParentTask` 的区别:那个函数返回 `{ main, groups }` 后调用方只能「先全部 main + 再全部 groups」,
 * 导致所有子任务 group 都被推到时间线最底部,跟子任务实际发生的时间点不符。
 * `interleaveTimeline` 按 parentTaskId 切换 group,让 group 卡出现在它的 header 条目附近,
 * 后续主流程消息从 group 之后继续 —— 跟用户预期的「在执行过程中看到子任务折叠」一致。
 */
export type TimelineBlock<T> =
  | { kind: 'main'; item: T }
  | {
      kind: 'group'
      taskId: string
      header: T | undefined
      children: T[]
      /** 嵌套在本组内的子组（子任务组挂进所属 agent.run 阶段组），递归结构。 */
      nested: TimelineBlock<T>[]
    }

/**
 * 不在时间线展示的内部事件标题(数据仍落 events 表,仅渲染层隐藏)。
 * 「注入记忆上下文」:记忆注入是 prompt 组装的内部环节,检索结果已由「检索记忆上下文」
 * 展示,注入文本本身无独立阅读价值,用户明确要求不占用流程位。
 */
const HIDDEN_TIMELINE_EVENT_TITLES = new Set(['注入记忆上下文'])

/** 判定事件是否应对时间线渲染隐藏(执行 Tab / Trace 详情共用)。 */
export function isHiddenTimelineEvent(title: string | undefined): boolean {
  return !!title && HIDDEN_TIMELINE_EVENT_TITLES.has(title)
}

export function interleaveTimeline<T extends ParentedItem>(items: T[]): TimelineBlock<T>[] {
  // Step 1: 把同 parentTaskId 的项合并到同一个 group(可能跨主流程消息穿插),
  // 保留每项的原始 index 用于 Step 2 排序。header 优先级:task_started > taskId 自指 > subtaskId 自指。
  const indexByItem = new Map<T, number>()
  items.forEach((item, i) => indexByItem.set(item, i))
  const groupMap = new Map<string, { taskId: string; header: T | undefined; children: T[]; firstIndex: number }>()
  const mainItems: T[] = []
  for (const item of items) {
    if (!item.parentTaskId) {
      mainItems.push(item)
      continue
    }
    let g = groupMap.get(item.parentTaskId)
    if (!g) {
      g = { taskId: item.parentTaskId, header: undefined, children: [], firstIndex: indexByItem.get(item) ?? 0 }
      groupMap.set(item.parentTaskId, g)
    }
    if (isSubtaskHeader(item, item.parentTaskId) && !g.header) {
      g.header = item
    } else {
      g.children.push(item)
    }
  }

  // Step 2: 把 main 和 group 混合排序,group 的位置由 header(否则第一个 child)出现的位置决定。
  type Tagged = { index: number; block: TimelineBlock<T> }
  const tagged: Tagged[] = []
  for (const m of mainItems) tagged.push({ index: indexByItem.get(m) ?? 0, block: { kind: 'main', item: m } })
  for (const g of groupMap.values()) {
    const idx = (g.header ? indexByItem.get(g.header) : undefined) ?? g.firstIndex
    tagged.push({
      index: idx,
      block: { kind: 'group', taskId: g.taskId, header: g.header, children: g.children, nested: [] }
    })
  }
  tagged.sort((a, b) => a.index - b.index)

  // Step 3: 嵌套 —— 子任务组（header 带 stageId 且该 stageId 是某个阶段的 group id）从顶层
  // 移除，挂进对应阶段组的 nested（按出现顺序）。阶段组与子任务组不再平级，
  // 执行面板呈现「Agent planning → Explore 子 Agent → 工具」的树形层级。
  const stageOfGroup = new Map<string, Tagged>()
  for (const t of tagged) if (t.block.kind === 'group') stageOfGroup.set(t.block.taskId, t)
  const nestedByStage = new Map<string, Tagged[]>()
  const topLevel: Tagged[] = []
  for (const t of tagged) {
    if (t.block.kind !== 'group') {
      topLevel.push(t)
      continue
    }
    const stageId = t.block.header?.stageId
    // 防自指：group 的 stageId 指向自己的 taskId 时（例如主任务组的 header 恰好也带 stageId = mainTaskId），
    // 留在顶层而非嵌套进自己。
    if (stageId && stageId !== t.block.taskId && stageOfGroup.has(stageId)) {
      const list = nestedByStage.get(stageId)
      if (list) list.push(t)
      else nestedByStage.set(stageId, [t])
    } else {
      topLevel.push(t)
    }
  }
  return topLevel.map((t) => {
    if (t.block.kind !== 'group') return t.block
    const nested = (nestedByStage.get(t.block.taskId) ?? []).sort((a, b) => a.index - b.index).map((n) => n.block)
    return nested.length ? { ...t.block, nested } : t.block
  })
}

function isSubtaskHeader<T extends ParentedItem>(item: T, parent: string): boolean {
  return item.sdkSubtype === 'task_started' || item.taskId === parent || item.subtaskId === parent
}

/** 子任务归一化元信息(Timeline / TraceDetail / PartRenderer 共享)。 */
export type SubtaskMeta = {
  parentTaskId?: string
  subtaskId?: string
  sdkSubtype?: string
  taskType?: string
  subagentType?: string
  status?: string
  description?: string
  usage?: unknown
  lastToolName?: string
  toolUseId?: string
  /** 所属 agent.run 阶段 id（阶段容器内发起的子任务，嵌套进阶段卡）。 */
  stageId?: string
}

/**
 * 从单条记录(events 行 / trace entry)提取子任务归属与 header/收尾/进度元信息。
 *
 * 主路径读 `payload` 字段(新数据);历史数据 payload 整列为空时走兑底:
 * title=`Qoder task_*` + detail 为整包 SDK 消息 JSON → 反解 task_id / task_type /
 * subagent_type / status / last_tool_name 等字段,保证老任务也能分组折叠成子任务卡。
 */
export function subtaskMetaOf(record: { title?: string; detail?: string; payload?: unknown }): SubtaskMeta {
  const meta: SubtaskMeta = {}
  const payload =
    record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : undefined
  if (payload) {
    if (typeof payload.subtaskId === 'string' && payload.subtaskId) {
      meta.subtaskId = payload.subtaskId
      meta.parentTaskId = payload.subtaskId
    }
    if (typeof payload.parentTaskId === 'string' && payload.parentTaskId) meta.parentTaskId = payload.parentTaskId
    if (typeof payload.stageId === 'string' && payload.stageId) meta.stageId = payload.stageId
    if (typeof payload.sdkSubtype === 'string' && payload.sdkSubtype) meta.sdkSubtype = payload.sdkSubtype
    if (typeof payload.taskType === 'string' && payload.taskType) meta.taskType = payload.taskType
    if (typeof payload.subagentType === 'string' && payload.subagentType) meta.subagentType = payload.subagentType
    if (typeof payload.status === 'string' && payload.status) meta.status = payload.status
    if (typeof payload.toolUseId === 'string' && payload.toolUseId) meta.toolUseId = payload.toolUseId
    if (payload.usage) meta.usage = payload.usage
    if (typeof payload.lastToolName === 'string' && payload.lastToolName) meta.lastToolName = payload.lastToolName
    // pipeline 阶段名优先：driver 注入的阶段名是规范显示名，SDK description 仅作兆底
    if (typeof payload.pipelineStage === 'string' && payload.pipelineStage) {
      meta.description = payload.pipelineStage
    } else {
      // description 兑底:SDK 任务消息上的进度摘要可能叫 description 也可能叫 summary,同步识别以免丢内容。
      const payloadText =
        (typeof payload.description === 'string' && payload.description) ||
        (typeof payload.summary === 'string' && payload.summary) ||
        undefined
      if (payloadText) meta.description = payloadText
    }
  }
  // 历史数据兑底:log.ts 早期版本把 task_* 整包 JSON 存在 detail 里、payload 留空。
  if (!meta.parentTaskId && !meta.sdkSubtype && record.title?.startsWith('Qoder task_')) {
    const subtype = record.title.replace(/^Qoder\s+/, '')
    meta.sdkSubtype = subtype
    try {
      const parsed = JSON.parse(record.detail ?? '{}') as Record<string, unknown>
      if (typeof parsed.task_id === 'string' && parsed.task_id) {
        meta.subtaskId = parsed.task_id
        meta.parentTaskId = parsed.task_id
      }
      if (subtype === 'task_started') {
        if (typeof parsed.task_type === 'string' && parsed.task_type) meta.taskType = parsed.task_type
        if (typeof parsed.subagent_type === 'string' && parsed.subagent_type) meta.subagentType = parsed.subagent_type
        if (typeof parsed.description === 'string' && parsed.description) meta.description = parsed.description
        if (typeof parsed.tool_use_id === 'string' && parsed.tool_use_id) meta.toolUseId = parsed.tool_use_id
      } else if (subtype === 'task_notification') {
        if (typeof parsed.status === 'string' && parsed.status) meta.status = parsed.status
        const summary = parsed.summary ?? parsed.description
        if (typeof summary === 'string' && summary) meta.description = summary
        if (parsed.usage) meta.usage = parsed.usage
      } else if (subtype === 'task_progress') {
        if (typeof parsed.last_tool_name === 'string' && parsed.last_tool_name)
          meta.lastToolName = parsed.last_tool_name
        if (typeof parsed.description === 'string' && parsed.description) meta.description = parsed.description
        if (parsed.usage) meta.usage = parsed.usage
      }
    } catch {
      // detail 非 JSON 时静默
    }
  }
  return meta
}

/** 子任务收尾状态对应的视觉: status 字段(completed/failed/stopped) + 颜色。 */
export type SubTaskStatus = 'completed' | 'failed' | 'stopped' | 'running' | 'unknown'

/** 从收尾条目(task_notification)提取 status。 */
export function subtaskStatusOf(entry: { payload?: unknown } | undefined): SubTaskStatus {
  const status = (entry?.payload as { status?: string } | undefined)?.status
  if (status === 'completed' || status === 'failed' || status === 'stopped') return status
  // 没有收尾条目 = 还在跑
  return entry ? 'running' : 'unknown'
}

function StatusBadge({ status }: { status: SubTaskStatus }) {
  if (status === 'completed') {
    return (
      <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px] text-emerald-600 dark:text-emerald-400">
        <CheckCircle2Icon size={10} />
        已完成
      </Badge>
    )
  }
  if (status === 'failed') {
    return (
      <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-[10px]">
        <XCircleIcon size={10} />
        失败
      </Badge>
    )
  }
  if (status === 'stopped') {
    return (
      <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
        <StopCircleIcon size={10} />
        已停止
      </Badge>
    )
  }
  if (status === 'running') {
    return (
      <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
        <Loader2Icon size={10} className="animate-spin" />
        执行中
      </Badge>
    )
  }
  return null
}

/**
 * 子任务折叠卡片 —— 视觉与 TimelineEntryBody 对齐。
 *
 * 布局:左侧 task 图标(GitBranchIcon)+ 右侧上方 trigger 行(chevron + title + status)
 *      + 右侧下方 CollapsibleContent(默认折叠,展开后展示子任务内的子条目)。
 *
 * - `taskId`: 子任务 ID(用于 key / a11y 标记)
 * - `header`: trigger 行内显示的内容 —— 通常是 SubTaskHeader(Task 名称 + type 徽章 + 状态徽章)
 * - `createdAt`: trigger 行右侧的时间(从 group 的 task_started 取)
 * - `children`: 折叠内容,展开后展示
 * - `defaultOpen`: 默认折叠(用户产品决策选的「默认全部折叠」)
 * - `className`: 外层样式扩展位
 */
export function SubTaskGroup({
  taskId,
  header,
  createdAt,
  defaultOpen = false,
  status,
  children,
  className
}: {
  taskId: string
  header: ReactNode
  createdAt?: string
  defaultOpen?: boolean
  /** 传入状态后，执行中自动展开、完成后自动收缩 */
  status?: SubTaskStatus
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen || status === 'running')
  // 状态变化时自动调整展开/收缩：执行中 → 展开，完成/失败 → 收缩
  useEffect(() => {
    if (!status || status === 'unknown') return
    setOpen(status === 'running')
  }, [status])
  return (
    // <article className={cn('mb-4 grid grid-cols-[26px_minmax(0,1fr)] gap-2', className)}>
    //   <div className="grid size-6 place-items-center rounded-full border bg-muted text-muted-foreground">
    //     <GitBranchIcon size={12} />
    //   </div>
    <article className={cn('mb-0 grid w-full gap-2', className)}>
      {/* <div className="grid size-6 place-items-center rounded-full border bg-muted text-muted-foreground">
        <GitBranchIcon size={12} />
      </div> */}
      <div className="min-w-0 pt-0.5">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            data-subtask-id={taskId}
            className="-mx-1.5 flex items-center justify-between gap-3 rounded-md px-1.5 py-0.5 text-left text-xs transition-colors hover:bg-muted/40"
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {/* 截断由 header 内容自行控制(description/summary 加 truncate),避免徽章被整体截断 */}
              <span className="min-w-0 flex-1">{header}</span>
              {open ? (
                <ChevronDownIcon size={12} className="shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRightIcon size={12} className="shrink-0 text-muted-foreground" />
              )}
            </span>
            {createdAt && <time className="shrink-0 text-xs text-muted-foreground">{formatTime(createdAt)}</time>}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-2 border-l-2 border-border/40 pl-3">
            {children}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </article>
  )
}

/** 子任务 header 视觉块,给 trace 详情页和 timeline 共用。 */
export function SubTaskHeader({
  description,
  // taskType,
  // subagentType,
  childCount,
  status,
  showAgentTag = true
}: {
  description?: string
  taskType?: string
  subagentType?: string
  /** 可见子操作数量,提供后在 description 后追加「已处理 n个操作」。 */
  childCount?: number
  status: SubTaskStatus
  /** 是否展示 Agent 标签：常规委派子 Agent 展示；pipeline 阶段卡不展示。 */
  showAgentTag?: boolean
}) {
  return (
    <span className="inline-flex w-full min-w-0 items-center gap-1.5">
      {showAgentTag && (
        <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] text-muted-foreground">
          Agent
        </Badge>
      )}
      <span className="min-w-0 truncate text-xs font-medium text-foreground/80">{description || '子任务'}</span>
      {/* {subagentType && (
        <Badge variant="outline" className="shrink-0 px-1 py-0 font-mono text-[10px]">
          {subagentType}
        </Badge>
      )} */}
      {childCount !== undefined && (
        <span className="shrink-0 text-xs text-muted-foreground">
          已处理 <span className="font-medium text-foreground/80">{childCount}</span> 个操作
        </span>
      )}
      <StatusBadge status={status} />
    </span>
  )
}

/**
 * 子任务卡 header 的「Agent 调用」样式 —— Qoder 委派 Agent 时,子任务卡就是那条
 * 发起调用(task 工具)的呈现:工具名(无 "Tools -" 前缀)+ 调用摘要 + 类型/状态徽章。
 * 新数据(task_started.tool_use_id 可关联到主流程发起调用)时 Timeline 用它替代
 * SubTaskHeader;老数据无 toolUseId、关联不上发起调用时回退 SubTaskHeader。
 */
export function SubTaskAgentHeader({
  name,
  summary,
  //   taskType,
  subagentType,
  status
}: {
  name: string
  summary?: string
  taskType?: string
  subagentType?: string
  status: SubTaskStatus
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <strong className="shrink-0 text-xs font-medium">{name}</strong>
      {summary && <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>}
      {/* {taskType && (
        <Badge variant="outline" className="shrink-0 px-1 py-0 font-mono text-[10px]">
          {taskType}
        </Badge>
      )} */}
      {subagentType && (
        <Badge variant="outline" className="shrink-0 px-1 py-0 font-mono text-[10px]">
          {subagentType}
        </Badge>
      )}
      <StatusBadge status={status} />
    </span>
  )
}

// === 工具调用行(Timeline / Trace / 对话三界面共用) ==========================

/** 单行截断:换行/连续空白折叠为一个空格,超限加省略号。 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 抽取路径末段的文件名(同时识别 Unix / 与 Windows \\ 分隔符);无分隔符时原样返回。 */
function pathBasename(value: string): string {
  const idx = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return idx >= 0 ? value.slice(idx + 1) : value
}

/**
 * 从工具 input 提取一行内联摘要(Qoder 风格:工具名右侧跟目标对象)。
 *
 * 优先级:description(Bash 的人类可读说明)> file_path(Read/Edit)> pattern(Glob/Grep)
 * > command(Bash 无 description)> query(WebSearch)> url(WebFetch)> prompt(Task)> path;
 * 都不命中时 JSON 截断 60 字。
 *
 * `file_path` / `path` 这类绝对路径会被压成末段文件名,避免在内联行里被省略号截掉关键信息。
 */
export function toolInputSummary(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input === 'string') return input.trim() ? oneLine(input, 80) : undefined
  if (typeof input !== 'object') return oneLine(String(input), 80)
  const rec = input as Record<string, unknown>
  for (const key of ['description', 'file_path', 'pattern', 'command', 'query', 'url', 'prompt', 'path']) {
    const value = rec[key]
    if (typeof value === 'string' && value.trim()) {
      const compact = key === 'file_path' || key === 'path' ? pathBasename(value.trim()) : value
      return oneLine(compact, 80)
    }
  }
  try {
    const json = JSON.stringify(input)
    return json ? oneLine(json, 60) : undefined
  } catch {
    return undefined
  }
}

/** 序列化工具 input / output 供展开区 pre 展示。 */
function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') return value
  // Anthropic content 块数组([{type:'text',text},...]) → 提取 text 拼接,
  // 避免把 tool_result content 的原始 JSON 直接铺到输出区。
  const blocksText = contentBlocksToText(value)
  if (blocksText !== undefined) return blocksText
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Anthropic content 块数组 → 拼接纯文本;非该形态返回 undefined(走 JSON 打印)。 */
function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const isBlock = (b: unknown): b is { type: string } =>
    !!b && typeof b === 'object' && typeof (b as { type?: unknown }).type === 'string'
  if (!value.every(isBlock)) return undefined
  return value
    .map((block) => {
      const text = (block as { text?: unknown }).text
      return block.type === 'text' && typeof text === 'string' ? text : JSON.stringify(block)
    })
    .join('\n')
}

/** 判定工具输入是否为「空占位」(stream 事件 content_block_start 的 input 恒为 {}):配对合并时空输入不阻塞后续完整输入覆盖。 */
export function isEmptyToolInput(input: unknown): boolean {
  if (input === undefined || input === null) return true
  return (
    typeof input === 'object' && !Array.isArray(input) && Object.keys(input as Record<string, unknown>).length === 0
  )
}

export type ToolCallStatus = 'running' | 'done' | 'error'

// === 通用工具调用配对(对话 / 执行面板 / Trace 三界面共用) ====================

/**
 * 通用工具调用配对:use(输入) + result(输出) 按 callId 合为一条。
 *
 * 数据源无关 —— PartRenderer(DriverPart)、Timeline(AgentEvent)、Trace 各自提供
 * 自己的 accessor 即可复用同一套配对算法与状态判定。
 *
 * 后续修改工具行渲染 / 折叠关系只需改此处,不必在各页面同步。
 */
export type ToolCallPair<T> = {
  callId: string
  /** 工具调用(输入端)。 */
  inputItem?: T
  /** 工具结果(输出端)。 */
  resultItem?: T
}

/**
 * 把条目列表按 callId 配对 use + result。
 *
 * - `getCallId`: 从条目提取调用 ID(无 ID 的条目跳过,不参与配对)。
 * - `isResult`: 判定该条目是 result 还是 use(默认 false = use)。
 *
 * 返回 `Map<callId, ToolCallPair<T>>`,callId 为空的条目不进入 Map。
 */
export function pairToolCalls<T>(
  items: T[],
  getCallId: (item: T) => string | undefined,
  isResult: (item: T) => boolean
): Map<string, ToolCallPair<T>> {
  const pairs = new Map<string, ToolCallPair<T>>()
  for (const item of items) {
    const callId = getCallId(item)
    if (!callId) continue
    let pair = pairs.get(callId)
    if (!pair) {
      pair = { callId }
      pairs.set(callId, pair)
    }
    if (isResult(item)) pair.resultItem = item
    else if (!pair.inputItem) pair.inputItem = item
  }
  return pairs
}

/**
 * 工具调用状态判定(三界面统一):
 * - `isError` 为 true → `'error'`
 * - 无 result 且 isStreaming → `'running'`
 * - 其它 → `'done'`
 *
 * `isError` 由各调用方从自己的数据形态提取(DriverPart 直接读顶层,
 * AgentEvent 读 payload.isError),此处不做数据源假设。
 */
export function determineToolStatus(
  pair: { resultItem?: unknown } | undefined,
  isError: boolean,
  isStreaming: boolean
): ToolCallStatus {
  if (isError) return 'error'
  if (!pair?.resultItem && isStreaming) return 'running'
  return 'done'
}

/** 该 callId 是否有配对的 result。 */
export function hasToolResult<T>(pairs: Map<string, ToolCallPair<T>>, callId: string): boolean {
  return !!pairs.get(callId)?.resultItem
}

/** 该 callId 是否有配对的 use(输入)。 */
export function hasToolUse<T>(pairs: Map<string, ToolCallPair<T>>, callId: string): boolean {
  return !!pairs.get(callId)?.inputItem
}

/**
 * 构建 spawner 吸收上下文(三界面统一):
 *
 * 1. 递归遍历 blocks(含 nested 嵌套组),从 group header 提取 toolUseId(发起子任务的那条工具调用)。
 * 2. 建立 callId → taskId 映射(spawnerTaskByCallId)。
 * 3. 反查工具配对,把被吸收调用的 result 输出收集为 taskId → { output, isError }
 *    (absorbedOutputByTaskId),供 SubTaskResultBlock 展示。
 *
 * 注意:子任务组可嵌套在阶段组内(stageId 嵌套),必须递归 nested,否则嵌套组的
 * 委派工具行不会被吸收,会以「Tools - Agent」独立行残留在父组里。
 *
 * - `getHeaderToolUseId`: 从 block header 提取发起调用的 toolUseId。
 * - `getResultOutput`:   从配对的 resultItem 提取 { output, isError }。
 */
type SpawnerBlock<THeader> =
  | { kind: 'main' }
  | { kind: 'group'; taskId: string; header: THeader | undefined; nested?: SpawnerBlock<THeader>[] }

export function buildSpawnerContext<THeader, TResultItem>(
  blocks: Array<SpawnerBlock<THeader>>,
  toolPairs: Map<string, ToolCallPair<TResultItem>>,
  getHeaderToolUseId: (header: THeader) => string | undefined,
  getResultOutput: (resultItem: TResultItem) => { output?: unknown; isError?: boolean } | undefined
): {
  spawnerTaskByCallId: Map<string, string>
  absorbedOutputByTaskId: Map<string, { output?: unknown; isError?: boolean }>
} {
  const spawnerTaskByCallId = new Map<string, string>()
  const collect = (blks: Array<SpawnerBlock<THeader>>) => {
    for (const block of blks) {
      if (block.kind !== 'group') continue
      const toolUseId = block.header ? getHeaderToolUseId(block.header) : undefined
      if (toolUseId) spawnerTaskByCallId.set(toolUseId, block.taskId)
      if (block.nested?.length) collect(block.nested)
    }
  }
  collect(blocks)

  const absorbedOutputByTaskId = new Map<string, { output?: unknown; isError?: boolean }>()
  for (const [callId, taskId] of spawnerTaskByCallId) {
    const pair = toolPairs.get(callId)
    const result = pair?.resultItem ? getResultOutput(pair.resultItem) : undefined
    if (!result) continue
    absorbedOutputByTaskId.set(taskId, result)
  }

  return { spawnerTaskByCallId, absorbedOutputByTaskId }
}

/** 工具行 trigger 内容:chevron + 工具名粗体 + 内联摘要 + 状态图标/时间。 */
function ToolCallTriggerContent({
  name,
  summary,
  status,
  createdAt,
  open
}: {
  name: string
  summary?: string
  status: ToolCallStatus
  createdAt?: string
  /** undefined = 无展开区,不渲染 chevron(纯展示行)。 */
  open?: boolean
}) {
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {open !== undefined &&
          (open ? (
            <ChevronDownIcon size={12} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon size={12} className="shrink-0 text-muted-foreground" />
          ))}
        <strong className="shrink-0 text-xs font-medium">Tools - {name}</strong>
        {summary && <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {status === 'running' && <Loader2Icon size={12} className="animate-spin text-muted-foreground" />}
        {status === 'error' && <XCircleIcon size={12} className="text-red-400" />}
        {createdAt && <time className="text-xs text-muted-foreground">{formatTime(createdAt)}</time>}
      </span>
    </>
  )
}

/**
 * 工具调用行 —— Qoder 风格紧凑单行,执行 Timeline / Trace / 对话三界面共用。
 *
 * - 单行:26px 图标列(跟 TimelineEntryBody 同栅格)+ 工具名粗体 + 内联摘要 + 状态/时间;
 * - 有 input / output 时整行是 CollapsibleTrigger,点击展开「输入 / 输出」pre 块;
 * - 没有任何详情时退化为纯展示行(无 chevron、不可点击);
 * - `metaBadges` 是插槽,Trace 用来塞模型/耗时/tokens 徽章,其它界面不传。
 */
export function ToolCallRow({
  name,
  summary,
  input,
  output,
  status = 'done',
  createdAt,
  metaBadges,
  className
}: {
  name: string
  summary?: string
  input?: unknown
  output?: unknown
  status?: ToolCallStatus
  createdAt?: string
  metaBadges?: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const hasInput = input !== undefined
  const hasOutput = output !== undefined
  const hasDetails = hasInput || hasOutput
  const isError = status === 'error'
  return (
    <article className={cn('mb-4 grid w-full grid-cols-[26px_minmax(0,1fr)] gap-2', className)}>
      <div
        className={cn(
          'grid size-6 place-items-center rounded-full border bg-muted text-muted-foreground',
          isError && 'border-red-500/30 text-red-300'
        )}
      >
        <Code2Icon size={12} />
      </div>
      <div className="min-w-0 pt-0.5">
        {hasDetails ? (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger className="-mx-1.5 flex w-full items-center justify-between gap-3 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-muted/40">
              <ToolCallTriggerContent name={name} summary={summary} status={status} createdAt={createdAt} open={open} />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1.5 space-y-1.5">
              {hasInput && (
                <div>
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">输入</div>
                  <pre className="thin-scrollbar max-h-72 overflow-auto rounded-md border bg-background p-2 font-mono text-xs leading-4 whitespace-pre-wrap text-muted-foreground">
                    {stringifyToolValue(input)}
                  </pre>
                </div>
              )}
              {hasOutput && (
                <div>
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <span>{isError ? '失败' : '输出'}</span>
                    {isError && (
                      <Badge variant="destructive" className="px-1 py-0 text-[10px]">
                        error
                      </Badge>
                    )}
                  </div>
                  <pre className="thin-scrollbar max-h-72 overflow-auto rounded-md border bg-background p-2 font-mono text-xs leading-4 whitespace-pre-wrap text-muted-foreground">
                    {stringifyToolValue(output)}
                  </pre>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <div className="-mx-1.5 flex items-center justify-between gap-3 px-1.5 py-0.5">
            <ToolCallTriggerContent name={name} summary={summary} status={status} createdAt={createdAt} />
          </div>
        )}
        {metaBadges}
      </div>
    </article>
  )
}

// === 子任务过程态聚合(三界面共用) ===========================================

/** task_progress 的归一化样本,三个界面各自从自己的数据形态映射到这个结构。 */
export type SubTaskProgressSample = {
  lastToolName?: string
  description?: string
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
}

export type SubTaskProgressAggregate = {
  progressCount: number
  lastToolName?: string
  /** 最后一条 progress 的 description —— 运行中时作为「当前活动」展示。 */
  latestDescription?: string
  totalTokens?: number
  totalToolUses?: number
  totalDurationMs?: number
}

/** 把多条 task_progress 样本聚合成一行统计(次数 / 最后工具 / tokens / 工具调用 / 耗时)。 */
export function aggregateSubTaskProgress(samples: SubTaskProgressSample[]): SubTaskProgressAggregate {
  const out: SubTaskProgressAggregate = { progressCount: 0 }
  let tokens = 0
  let toolUses = 0
  let durationMs = 0
  let hasUsage = false
  for (const sample of samples) {
    out.progressCount += 1
    if (sample.lastToolName) out.lastToolName = sample.lastToolName
    if (sample.description) out.latestDescription = sample.description
    if (sample.usage) {
      hasUsage = true
      tokens += sample.usage.total_tokens ?? 0
      toolUses += sample.usage.tool_uses ?? 0
      durationMs += sample.usage.duration_ms ?? 0
    }
  }
  if (hasUsage) {
    out.totalTokens = tokens
    out.totalToolUses = toolUses
    out.totalDurationMs = durationMs
  }
  return out
}

/**
 * 子任务过程态统计行 —— 折叠卡顶部的一行小字,取代逐条平铺 task_progress。
 * `running` 时附带最新一条 progress 描述作为「当前活动」指示。
 */
export function SubTaskProgressSummary({
  aggregate,
  running,
  className
}: {
  aggregate: SubTaskProgressAggregate
  running?: boolean
  className?: string
}) {
  if (aggregate.progressCount === 0 && !(running && aggregate.latestDescription)) return null
  return (
    <div className={cn('mb-2 space-y-1 text-[10px] text-muted-foreground', className)}>
      {aggregate.progressCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
          <span>过程态 {aggregate.progressCount} 次</span>
          {aggregate.lastToolName && (
            <>
              <span>·</span>
              <span>最后工具: {aggregate.lastToolName}</span>
            </>
          )}
          {typeof aggregate.totalTokens === 'number' && (
            <>
              <span>·</span>
              <span>tokens: {formatTokens(aggregate.totalTokens)}</span>
            </>
          )}
          {typeof aggregate.totalToolUses === 'number' && (
            <>
              <span>·</span>
              <span>工具调用: {aggregate.totalToolUses}</span>
            </>
          )}
          {typeof aggregate.totalDurationMs === 'number' && aggregate.totalDurationMs > 0 && (
            <>
              <span>·</span>
              <span>耗时: {formatDuration(aggregate.totalDurationMs)}</span>
            </>
          )}
        </div>
      )}
      {running && aggregate.latestDescription && (
        <div className="flex items-center gap-1">
          <Loader2Icon size={10} className="shrink-0 animate-spin" />
          <span className="truncate">{aggregate.latestDescription}</span>
        </div>
      )}
    </div>
  )
}

// === 主流程发起调用吸收(三界面共用) =========================================

/**
 * 从子任务 group header 提取 spawner toolUseId —— 即 task_started.tool_use_id,
 * 它指向主流程里发起该子任务的那条工具调用(如 local_agent)。
 *
 * 识别两种形态:
 * - 直挂:ChatPage 的 qoder.subtask-start part(`part.toolUseId`);
 * - 嵌套:Timeline / Trace 的 entry(`entry.payload.toolUseId`)。
 */
export function spawnerToolUseIdOf(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined
  const direct = (source as { toolUseId?: unknown }).toolUseId
  if (typeof direct === 'string' && direct) return direct
  const payload = (source as { payload?: unknown }).payload
  if (payload && typeof payload === 'object') {
    const nested = (payload as { toolUseId?: unknown }).toolUseId
    if (typeof nested === 'string' && nested) return nested
  }
  return undefined
}

/**
 * 子任务卡底部块:收尾 summary 段落 + 被吸收的发起调用「输出」段。
 * summary 来自 task_notification(子任务最终摘要);output 来自主流程那条
 * 发起工具调用的 tool_result(完整输出,通常比 summary 长)。
 */
export function SubTaskResultBlock({
  summary,
  output,
  isError,
  className
}: {
  summary?: string
  output?: unknown
  isError?: boolean
  className?: string
}) {
  if (!summary && output === undefined) return null
  return (
    <div className={cn('space-y-1.5', className)}>
      {summary && (
        <p className="rounded-md border border-border/30 bg-background/50 px-2 py-1.5 text-xs leading-4 break-words whitespace-pre-wrap text-foreground/80">
          {summary}
        </p>
      )}
      {output !== undefined && (
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <span>{isError ? '失败' : '输出'}</span>
            {isError && (
              <Badge variant="destructive" className="px-1 py-0 text-[10px]">
                error
              </Badge>
            )}
          </div>
          <pre className="thin-scrollbar max-h-72 overflow-auto rounded-md border bg-background p-2 font-mono text-xs leading-4 whitespace-pre-wrap text-muted-foreground">
            {stringifyToolValue(output)}
          </pre>
        </div>
      )}
    </div>
  )
}
