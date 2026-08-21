import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TASK_TOOL_NAMES, parseTaskToolMeta } from '@task-pipeline/core/dist/trace/task-tool-meta.js'
import type { AgentEvent, Task, TaskCard } from '@task-pipeline/core/dist/types.js'
import { api, type DriverPart, type TaskDetail } from '../../../api'
import { useFeedback } from '../../../hooks/useGlobalFeedback'
import { isPlanningEvent } from '../components/planningEvent'
import type { ChatApprovalRequest } from '@/components/ToolApprovalCard'
import { subtaskMetaOf, isHiddenTimelineEvent } from '@/components/SubTaskGroup'

/**
 * 把 AgentEvent[] 一次性转为 DriverPart[] —— 供 PartRenderer 直接渲染。
 * 内部私有函数，不对外暴露。
 */
function eventsToDriverParts(events: AgentEvent[]): DriverPart[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  const parts: DriverPart[] = []

  // 预扫描：找出有 pipelineStage 但没有 task_started 的子任务组，
  // 为它们合成 subtask-start part，让 PartRenderer 能显示 pipeline 阶段名。
  const hasTaskStarted = new Set<string>()
  const pipelineStageByGroup = new Map<string, string>()
  for (const event of sorted) {
    const meta = subtaskMetaOf(event)
    const parentTaskId = event.parentTaskId ?? meta.parentTaskId
    const payload =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : undefined
    if (meta.sdkSubtype === 'task_started' && parentTaskId) {
      hasTaskStarted.add(parentTaskId)
    }
    if (parentTaskId && !hasTaskStarted.has(parentTaskId)) {
      const stage = (payload?.pipelineStage ?? meta.description) as string | undefined
      if (stage && !pipelineStageByGroup.has(parentTaskId)) {
        pipelineStageByGroup.set(parentTaskId, stage)
      }
    }
  }
  // 为缺少 task_started 但有 pipelineStage 的子任务组合成 subtask-start
  for (const [groupId, stage] of pipelineStageByGroup) {
    if (!hasTaskStarted.has(groupId)) {
      parts.push({
        driverId: 'qoder',
        type: 'qoder.subtask-start',
        taskId: groupId,
        parentTaskId: groupId,
        description: stage
      })
    }
  }

  // 预扫描：收集 TaskCreate 产出全量任务条目 + TaskUpdate 最终状态
  interface TaskItem {
    taskId: string
    subject: string
  }
  const taskItems: TaskItem[] = []
  // 主循环中按时间流逐次推进，不预扫描完成状态
  const completedTasks = new Set<string>()
  const prescanInputByCallId = new Map<string, { taskId: string; status: string }>()
  /** 预扫描：taskId → 该 task 的 TaskUpdate 最终是否为 completed。 */
  const taskCompletedInUpdate = new Set<string>()
  for (const event of sorted) {
    if (event.kind !== 'tool') continue
    const p =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : undefined
    if (!p) continue
    const toolName = p.toolName as string | undefined
    if (!toolName || !TASK_TOOL_NAMES.includes(toolName as (typeof TASK_TOOL_NAMES)[number])) continue
    const phase = p.phase as string | undefined
    const output = phase === 'result' ? (p.output ?? event.detail) : undefined
    if (toolName === 'TaskCreate') {
      const meta = parseTaskToolMeta(toolName, output)
      if (meta.taskId && meta.subject && !taskItems.some((item) => item.taskId === meta.taskId)) {
        taskItems.push({ taskId: meta.taskId, subject: meta.subject })
      }
    }
    // 预扫描 TaskUpdate 最终状态（判断 in_progress 卡是否应展示）
    if (toolName === 'TaskUpdate') {
      const pCallId = p.toolUseId as string | undefined
      if (phase === 'use') {
        const pInput = (p.input ?? {}) as Record<string, unknown>
        const pTaskId = String(pInput.taskId ?? '')
        const pStatus = String(pInput.status ?? '')
        if (pCallId && (pTaskId || pStatus)) {
          prescanInputByCallId.set(pCallId, { taskId: pTaskId, status: pStatus })
        }
      }
      if (phase === 'result') {
        let taskId = ''
        let status = ''
        const cached = pCallId ? prescanInputByCallId.get(pCallId) : undefined
        if (cached) {
          taskId = cached.taskId
          status = cached.status
        } else {
          const meta = parseTaskToolMeta(toolName, output)
          taskId = meta.taskId ?? ''
          status = meta.status ?? ''
        }
        if (status === 'completed' && taskId) {
          taskCompletedInUpdate.add(taskId)
        }
      }
    }
  }
  let taskCardEmitted = false
  // 跟踪 TaskUpdate use 阶段的输入参数（result 阶段 input 为空）
  const taskUpdateInputByCallId = new Map<string, { taskId: string; status: string }>()

  for (const event of sorted) {
    if (isHiddenTimelineEvent(event.title)) continue
    if (isPlanningEvent(event)) continue
    const meta = subtaskMetaOf(event)
    const parentTaskId = event.parentTaskId ?? meta.parentTaskId
    const payload =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : undefined
    // 用户跟进消息（send() 注入的 title='你'）
    if (event.title === '你') {
      if (event.detail) parts.push({ driverId: 'qoder', type: 'text', text: event.detail })
      continue
    }
    // 子任务控制事件
    if (meta.sdkSubtype === 'task_started') {
      parts.push({
        driverId: 'qoder',
        type: 'qoder.subtask-start',
        taskId: event.subtaskId ?? meta.subtaskId ?? event.taskId,
        parentTaskId: parentTaskId ?? event.subtaskId ?? meta.subtaskId ?? '',
        taskType: meta.taskType,
        subagentType: meta.subagentType,
        description: meta.description,
        toolUseId: meta.toolUseId,
        stageId: meta.stageId
      })
      continue
    }
    if (meta.sdkSubtype === 'task_progress') {
      parts.push({
        driverId: 'qoder',
        type: 'qoder.subtask-progress',
        taskId: event.subtaskId ?? meta.subtaskId ?? event.taskId,
        parentTaskId: parentTaskId ?? event.subtaskId ?? meta.subtaskId ?? '',
        description: meta.description,
        lastToolName: meta.lastToolName,
        usage: meta.usage
      })
      continue
    }
    if (meta.sdkSubtype === 'task_notification') {
      parts.push({
        driverId: 'qoder',
        type: 'qoder.subtask-end',
        taskId: event.subtaskId ?? meta.subtaskId ?? event.taskId,
        parentTaskId: parentTaskId ?? event.subtaskId ?? meta.subtaskId ?? '',
        status: meta.status ?? 'unknown',
        summary: meta.description,
        usage: meta.usage
      })
      continue
    }
    // 工具事件
    if (event.kind === 'tool') {
      const phase = payload?.phase as string | undefined
      const toolUseId = payload?.toolUseId as string | undefined
      const toolName = payload?.toolName as string | undefined

      // 任务工具拦截（TaskCreate 聚合为清单卡，TaskUpdate 展示为进度行）
      if (toolName && TASK_TOOL_NAMES.includes(toolName as (typeof TASK_TOOL_NAMES)[number])) {
        if (toolName === 'TaskCreate') {
          if (!taskCardEmitted && taskItems.length > 0) {
            parts.push({
              driverId: 'qoder',
              type: 'qoder.task-list',
              header: '添加待办',
              items: taskItems.map((item) => ({
                taskId: item.taskId,
                subject: item.subject
              })),
              parentTaskId
            })
            taskCardEmitted = true
          }
          continue // 不产出 tool-use / tool-result part
        }
        if (toolName === 'TaskUpdate') {
          if (phase === 'use') {
            // 缓存 use 阶段入参（result 阶段 payload.input 为空）
            const input = (payload?.input ?? {}) as Record<string, unknown>
            const taskId = String(input.taskId ?? '')
            const status = String(input.status ?? '')
            if (toolUseId && (taskId || status)) {
              taskUpdateInputByCallId.set(toolUseId, { taskId, status })
            }
            // in_progress → 提前展示加载卡片（仅当该 task 最终状态不是 completed）
            if (status === 'in_progress' && taskId && !taskCompletedInUpdate.has(taskId)) {
              parts.push({
                driverId: 'qoder',
                type: 'qoder.task-update',
                header: '完成待办',
                items: taskItems.map((t) => ({
                  taskId: t.taskId,
                  subject: t.subject,
                  completed: completedTasks.has(t.taskId)
                })),
                updatePhase: 'use',
                updatedTaskId: taskId,
                parentTaskId
              })
            }
            continue
          }
          if (phase === 'result') {
            // 优先从缓存的 use 入参读取，兜底从 output 解析
            let updateTaskId = ''
            let updateStatus = ''
            const cached = toolUseId ? taskUpdateInputByCallId.get(toolUseId) : undefined
            if (cached) {
              updateTaskId = cached.taskId
              updateStatus = cached.status
            } else {
              const output = (payload?.output ?? event.detail) as string | undefined
              const meta = parseTaskToolMeta(toolName, output)
              updateTaskId = meta.taskId ?? ''
              updateStatus = meta.status ?? ''
            }
            // 仅 completed 产卡（in_progress 已在 use 阶段渲染加载卡，不再重复展示）
            if (updateStatus === 'completed') {
              completedTasks.add(updateTaskId)
              parts.push({
                driverId: 'qoder',
                type: 'qoder.task-update',
                header: '完成待办',
                items: taskItems.map((t) => ({
                  taskId: t.taskId,
                  subject: t.subject,
                  completed: completedTasks.has(t.taskId)
                })),
                updatePhase: 'result',
                updatedTaskId: updateTaskId,
                parentTaskId
              })
            }
            continue
          }
          // 其他 phase：跳过
          continue
        }
        // 其他任务工具或 TaskUpdate use phase：跳过
        continue
      }

      if (phase === 'use') {
        if (!toolUseId) {
          // 无 toolUseId 的老数据:降级为 text
          if (event.detail) parts.push({ driverId: 'qoder', type: 'text', text: event.detail, parentTaskId })
          continue
        }
        parts.push({
          driverId: 'qoder',
          type: 'qoder.tool-use',
          toolCallId: toolUseId,
          name: toolName ?? event.title,
          input: payload?.input ?? event.detail,
          parentTaskId
        })
      } else if (phase === 'result') {
        if (!toolUseId) {
          if (event.detail) parts.push({ driverId: 'qoder', type: 'text', text: event.detail, parentTaskId })
          continue
        }
        parts.push({
          driverId: 'qoder',
          type: 'qoder.tool-result',
          toolCallId: toolUseId,
          output: payload?.output ?? event.detail,
          isError: payload?.isError === true,
          parentTaskId
        })
      } else {
        // 无 phase 的老数据:detail 当文本
        if (event.detail) parts.push({ driverId: 'qoder', type: 'text', text: event.detail, parentTaskId })
      }
      continue
    }
    // 消息事件
    if (event.kind === 'message') {
      // thinking 独立 part
      const thinking = payload?.thinking as string | undefined
      if (thinking) {
        parts.push({ driverId: 'qoder', type: 'qoder.thinking', text: thinking, parentTaskId })
      }
      // 消息正文
      if (event.detail) {
        parts.push({ driverId: 'qoder', type: 'text', text: event.detail, parentTaskId })
      }
      continue
    }
    // review / error / 其它:格式化文本
    if (event.kind === 'review') {
      const comments = payload?.comments as Array<{ severity?: string; path?: string; message?: string }> | undefined
      const text = comments
        ? comments.map((c) => `[${c.severity ?? 'info'}] ${c.path ?? ''}: ${c.message ?? ''}`).join('\n')
        : (event.detail ?? event.title)
      if (text) parts.push({ driverId: 'qoder', type: 'text', text, parentTaskId })
      continue
    }
    if (event.kind === 'error') {
      const text = [event.title, event.detail].filter(Boolean).join(': ')
      if (text) parts.push({ driverId: 'qoder', type: 'text', text, parentTaskId })
      continue
    }
    // 兜底:有 detail 就作文本
    if (event.detail) {
      parts.push({ driverId: 'qoder', type: 'text', text: event.detail, parentTaskId })
    }
  }

  // 后处理：基于时间范围推断子任务间的嵌套关系。
  // 后端注入的 stageId 统一指向主任务 taskId，所有子任务组都尝试嵌套进同一个主任务组（平级）。
  // 这里用时间范围覆盖来细化：如果子任务 B 的 subtask-start 落在子任务 A 的活跃时间窗口内，
  // 说明 B 是 A 的内部子任务，B.stageId 应指向 A 而非主任务。
  const subtaskStarts = parts
    .map((p, i) => (p.type === 'qoder.subtask-start' ? { part: p, index: i } : null))
    .filter((x): x is { part: Extract<DriverPart, { type: 'qoder.subtask-start' }>; index: number } => x !== null)
  if (subtaskStarts.length > 1) {
    // 每个子任务的时间窗口：[subtask-start 的 index, 下一个 subtask-start 的 index - 1 或末尾]
    const rangeByTaskId = new Map<string, { start: number; end: number }>()
    for (let i = 0; i < subtaskStarts.length; i++) {
      const { part, index } = subtaskStarts[i]!
      const end = i + 1 < subtaskStarts.length ? subtaskStarts[i + 1]!.index - 1 : parts.length - 1
      rangeByTaskId.set(part.taskId, { start: index, end })
    }
    // 对每个 subtask-start，找包含它的最内层父子任务
    for (const { part, index } of subtaskStarts) {
      let bestParent: { taskId: string; range: { start: number; end: number } } | undefined
      for (const [taskId, range] of rangeByTaskId) {
        if (taskId === part.taskId) continue
        // part 的 index 落在 [range.start, range.end] 内，且不是自己
        if (index >= range.start && index <= range.end) {
          if (!bestParent || range.end - range.start < bestParent.range.end - bestParent.range.start) {
            bestParent = { taskId, range }
          }
        }
      }
      if (bestParent) {
        part.stageId = bestParent.taskId
      }
    }
  }

  return parts
}

export type CodingPageState = {
  tasks: TaskCard[]
  selectedId?: string
  detail?: TaskDetail
  /** 合并后的 DriverPart[]（历史 events + 流式 live parts），直接喂给 PartRenderer。 */
  parts: DriverPart[]
  prompt: string
  running: boolean
  sending: boolean
  search: string
  /** 当前选中任务待确认的 HITL 请求（内联卡片渲染源）。 */
  approvals: ChatApprovalRequest[]
  setSelectedId(id: string | undefined): void
  setSearch(value: string): void
  setPrompt(value: string): void
  refresh(): Promise<void>
  loadDetail(id: string): Promise<void>
  send(): Promise<void>
  run(action: () => Promise<unknown>): Promise<void>
  /** 推送一个 HITL 确认请求（按 taskId 归属，缺省挂当前选中任务）。 */
  pushApproval(taskId: string | undefined, request: ChatApprovalRequest): void
  /** 响应确认请求（允许/拒绝），并从对应任务队列移除。 */
  respondApproval(id: string, confirmed: boolean): Promise<void>
}

export function useTasks(): CodingPageState {
  const { showError, showSuccess } = useFeedback()
  const [tasks, setTasks] = useState<TaskCard[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<TaskDetail>()
  /** 流式 live parts（运行时追加，切换任务/结束时清空）。 */
  const [liveParts, setLiveParts] = useState<DriverPart[]>([])
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState('')
  /** taskId → 待用户确认的 HITL 请求（内联卡片；任务并行时各归其位）。 */
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, ChatApprovalRequest[]>>({})
  /** pendingApprovals 的同步 ref（flushApprovals 在 updater 外读取最新值，避免副作用入 updater）。 */
  const pendingApprovalsRef = useRef<Record<string, ChatApprovalRequest[]>>({})
  useEffect(() => {
    pendingApprovalsRef.current = pendingApprovals
  }, [pendingApprovals])

  const planningRef = useRef(false)
  const notifiedPlanRef = useRef<string | undefined>(undefined)
  const pendingTaskIdRef = useRef<string | undefined>(undefined)

  const acceptDetail = useCallback(
    (next: TaskDetail, options?: { syncRunning?: boolean }) => {
      // 竞态保护：只接受当前选中任务的响应
      if (next.task?.id && next.task.id !== pendingTaskIdRef.current) return
      setDetail(next)
      planningRef.current = next.task?.state === 'planning'
      // 主进程 activeTaskOperations 的权威运行中标记：应用重启/事件丢失时恢复 running，
      // 避免 planning 中的任务误显示"继续生成计划"。仅初始加载/切换/手动操作后同步，
      // 事件驱动路径（agent_start/agent_end）仍以事件为准，不覆盖。
      if (options?.syncRunning && next.running !== undefined) setRunning(next.running)
      if (next.task?.state === 'awaiting_plan_approval') {
        const key = `${next.task.id}:${next.task.planRevision ?? 0}`
        if (notifiedPlanRef.current !== key) {
          notifiedPlanRef.current = key
          showSuccess(`${next.task.title} 的计划已生成，等待确认`)
        }
      } else if (
        next.task?.state === 'completed' &&
        next.task.startMode === 'plan' &&
        next.task.summary === '代码已满足任务要求，无需修改'
      ) {
        const key = `${next.task.id}:completed`
        if (notifiedPlanRef.current !== key) {
          notifiedPlanRef.current = key
          showSuccess(`${next.task.title} 已满足要求，任务自动完成`)
        }
      }
    },
    [showSuccess]
  )

  const pushApproval = useCallback((taskId: string | undefined, request: ChatApprovalRequest) => {
    const id = taskId ?? pendingTaskIdRef.current
    if (!id) return
    setPendingApprovals((current) => ({ ...current, [id]: [...(current[id] ?? []), request] }))
  }, [])

  const respondApproval = useCallback(async (id: string, confirmed: boolean) => {
    // 乐观移除：先清卡片再响应（IPC 失败时主进程超时兜底默认拒绝，卡片不残留误导）。
    setPendingApprovals((current) => {
      let changed = false
      const next: Record<string, ChatApprovalRequest[]> = {}
      for (const [taskId, list] of Object.entries(current)) {
        const filtered = list.filter((approval) => approval.id !== id)
        if (filtered.length !== list.length) changed = true
        if (filtered.length) next[taskId] = filtered
      }
      return changed ? next : current
    })
    try {
      await api.respondTaskUi({ id, confirmed })
    } catch {
      /* 主进程超时/会话关闭后响应为 no-op，忽略 */
    }
  }, [])

  /** 任务会话结束时未确认的请求默认拒绝（安全兜底，替代原全局模态清除语义）。 */
  const flushApprovals = useCallback((taskId: string) => {
    const list = pendingApprovalsRef.current[taskId]
    if (!list || list.length === 0) return
    // 副作用在 updater 外：StrictMode 双执行 updater 也不会重复发响应（主进程端幂等）。
    for (const approval of list) void api.respondTaskUi({ id: approval.id, confirmed: false })
    setPendingApprovals((current) => {
      if (!current[taskId]?.length) return current
      const next = { ...current }
      delete next[taskId]
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    try {
      const list = await api.listTasks()
      setTasks(list)
      if (selectedId && !list.some((item) => item.id === selectedId)) {
        setSelectedId(undefined)
        setDetail(undefined)
      }
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [selectedId, showError])

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        acceptDetail(await api.getTask(id), { syncRunning: true })
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [acceptDetail, showError]
  )

  // 初次 + 5min 轮询
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5 * 60_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  // 任务事件订阅（与原 App.tsx 一致）
  useEffect(() => {
    let changeTimer: number | undefined
    const off = api.onTaskEvent((event) => {
      if (event.type === 'extension_ui_request') {
        if (event.method === 'confirm') {
          // confirm 内联到任务执行流（按 taskId 归属，并行任务各自展示确认卡片）
          pushApproval(event.taskId, event)
        } else if (['select', 'input', 'editor', 'ask-user'].includes(event.method)) {
          // 其余方法（信任项目配置 / AskUserQuestion 等）保留 UiRequestDialog 模态兜底
          window.dispatchEvent(new CustomEvent('task:ui-request', { detail: event }))
        }
      }
      if (event.type === 'agent_start') {
        setSending(false)
        setRunning(true)
        planningRef.current = event.phase === 'planning'
      }
      if (event.type === 'task_changed' || event.type === 'trace_span') {
        const taskId = selectedId
        window.clearTimeout(changeTimer)
        changeTimer = window.setTimeout(() => {
          void refresh()
          if (taskId && (event.type === 'task_changed' ? taskId === event.taskId : true)) {
            void api.getTask(taskId).then(acceptDetail)
          }
        }, 100)
      }
      if (['agent_end', 'agent_error', 'process_exit'].includes(event.type)) {
        setSending(false)
        setRunning(false)
        // 任务会话结束：该任务未确认的 HITL 请求默认拒绝（内联卡片清理）。
        if (typeof event.taskId === 'string') flushApprovals(event.taskId)
        // 保留 task:ui-clear：UiRequestDialog 的 select/input/editor 兜底队列仍靠它清空。
        window.dispatchEvent(new CustomEvent('task:ui-clear'))
        if (event.phase === 'planning' || planningRef.current) setLiveParts([])
        planningRef.current = false
        void refresh()
        if (selectedId) void api.getTask(selectedId).then(acceptDetail)
      }
      if (event.type === 'message_update') {
        if (event.phase === 'planning' || planningRef.current) return
        const update = event.assistantMessageEvent as { type?: string; delta?: string; thinking?: string } | undefined
        if (update?.type === 'text_delta' && update.delta) {
          setLiveParts((parts) => {
            const last = parts[parts.length - 1]
            // 合并相邻同类型 text part（流式 text_delta 按 token 粒度推送）
            if (last && last.type === 'text' && last.driverId === 'qoder') {
              return [...parts.slice(0, -1), { ...last, text: `${last.text}${update.delta}` } as DriverPart]
            }
            return [...parts, { driverId: 'qoder', type: 'text', text: update.delta } as DriverPart]
          })
        } else if (update?.type === 'thinking_delta' && update.thinking) {
          setLiveParts((parts) => {
            const last = parts[parts.length - 1]
            if (last && last.type === 'qoder.thinking' && last.driverId === 'qoder') {
              return [...parts.slice(0, -1), { ...last, text: `${last.text}${update.thinking}` } as DriverPart]
            }
            return [...parts, { driverId: 'qoder', type: 'qoder.thinking', text: update.thinking } as DriverPart]
          })
        }
      }
    })
    return () => {
      window.clearTimeout(changeTimer)
      off()
    }
  }, [selectedId, refresh, acceptDetail, flushApprovals, pushApproval])

  // 切换任务时清空 liveParts 并加载详情（不清空 detail，避免闪烁）
  useEffect(() => {
    setLiveParts([])
    setSending(false)
    if (selectedId) {
      pendingTaskIdRef.current = selectedId
      void api.getTask(selectedId).then((detail) => acceptDetail(detail, { syncRunning: true }))
    } else {
      // 没有选中任务时清空详情
      pendingTaskIdRef.current = undefined
      setDetail(undefined)
    }
  }, [selectedId, acceptDetail])

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action()
        await refresh()
        if (selectedId) acceptDetail(await api.getTask(selectedId), { syncRunning: true })
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [acceptDetail, refresh, selectedId, showError]
  )

  const send = useCallback(async () => {
    const selected = tasks.find((t) => t.id === selectedId)
    if (!selected || !prompt.trim()) return
    const text = prompt
    setPrompt('')
    setSending(true)
    setLiveParts((parts) => [...parts, { driverId: 'qoder', type: 'text', text } as DriverPart])
    try {
      await run(() => api.sendTaskMessage(selected.id, text))
    } finally {
      setSending(false)
    }
  }, [prompt, run, selectedId, tasks])

  return {
    tasks,
    selectedId,
    detail,
    parts: useMemo(() => {
      const stored = eventsToDriverParts([...(detail?.events ?? []), ...(detail?.openAiEvents ?? [])] as AgentEvent[])
      return [...stored, ...liveParts]
    }, [detail?.events, detail?.openAiEvents, liveParts]),
    prompt,
    running,
    sending,
    search,
    approvals: selectedId ? (pendingApprovals[selectedId] ?? []) : [],
    setSelectedId,
    setSearch,
    setPrompt,
    refresh,
    loadDetail,
    send,
    run,
    pushApproval,
    respondApproval
  }
}

export function selectTask(state: CodingPageState): Task | undefined {
  return state.tasks.find((t) => t.id === state.selectedId)
}

export function filteredTasks(state: CodingPageState): TaskCard[] {
  const q = state.search.toLowerCase()
  return state.tasks.filter(
    (task) => !q || `${task.title} ${task.taskKey ?? ''} ${task.keywords.join(' ')}`.toLowerCase().includes(q)
  )
}
