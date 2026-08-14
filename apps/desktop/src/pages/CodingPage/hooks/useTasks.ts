import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, Task, TaskCard } from '@task-pipeline/core'
import { api, type TaskDetail } from '../../../api'
import { useFeedback } from '../../../hooks/useGlobalFeedback'
import type { ChatApprovalRequest } from '@/components/ToolApprovalCard'

export type TimelineItem =
  | AgentEvent
  | {
      id: string
      taskId: string
      kind: AgentEvent['kind']
      title: string
      detail?: string
      createdAt: string
    }

export type CodingPageState = {
  tasks: TaskCard[]
  selectedId?: string
  detail?: TaskDetail
  liveEvents: TimelineItem[]
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
  const [liveEvents, setLiveEvents] = useState<TimelineItem[]>([])
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

  const liveMessageId = useRef<string | undefined>(undefined)
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
        } else if (['select', 'input', 'editor'].includes(event.method)) {
          // 其余方法（信任项目配置等）保留 UiRequestDialog 模态兜底
          window.dispatchEvent(new CustomEvent('task:ui-request', { detail: event }))
        }
      }
      if (event.type === 'agent_start') {
        setSending(false)
        setRunning(true)
        planningRef.current = event.phase === 'planning'
        liveMessageId.current = crypto.randomUUID()
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
        liveMessageId.current = undefined
        // 任务会话结束：该任务未确认的 HITL 请求默认拒绝（内联卡片清理）。
        if (typeof event.taskId === 'string') flushApprovals(event.taskId)
        // 保留 task:ui-clear：UiRequestDialog 的 select/input/editor 兜底队列仍靠它清空。
        window.dispatchEvent(new CustomEvent('task:ui-clear'))
        if (event.phase === 'planning' || planningRef.current) setLiveEvents([])
        planningRef.current = false
        void refresh()
        if (selectedId) void api.getTask(selectedId).then(acceptDetail)
      }
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        if (event.phase === 'planning' || planningRef.current) return
        const id = (liveMessageId.current ??= crypto.randomUUID())
        setLiveEvents((items) => {
          const last = items[items.length - 1]
          if (last?.id === id)
            return [
              ...items.slice(0, -1),
              { ...last, detail: `${last.detail ?? ''}${event.assistantMessageEvent.delta}` }
            ]
          return [
            ...items,
            {
              id,
              taskId: selectedId ?? '',
              kind: 'message',
              title: 'AI',
              detail: event.assistantMessageEvent.delta,
              createdAt: new Date().toISOString()
            }
          ]
        })
      }
    })
    return () => {
      window.clearTimeout(changeTimer)
      off()
    }
  }, [selectedId, refresh, acceptDetail, flushApprovals, pushApproval])

  // 切换任务时清空 liveEvents 并加载详情（不清空 detail，避免闪烁）
  useEffect(() => {
    setLiveEvents([])
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
    setLiveEvents((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        taskId: selected.id,
        kind: 'message',
        title: '你',
        detail: text,
        createdAt: new Date().toISOString()
      }
    ])
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
    liveEvents,
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
