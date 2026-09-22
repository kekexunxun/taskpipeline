import { TASK_TOOL_NAMES, parseTaskToolMeta } from '@task-pipeline/core/dist/trace/task-tool-meta.js'
import type { DriverPart } from '@/api'

/**
 * 把 Qoder Chat driver 落盘的原始任务工具 part(`qoder.tool-use` / `qoder.tool-result`,
 * 工具名命中 `TASK_TOOL_NAMES`)聚合为一张常驻 `qoder.task-list` 清单卡。
 *
 * 背景(与执行 Tab 对齐):
 *  - 执行 Tab 的 `eventsToDriverParts` 会把 trace events 里的 TaskCreate/TaskUpdate
 *    预聚合成 `qoder.task-list` part,再由 PartRenderer 渲染成清单卡。
 *  - Chat 走的是另一条数据链路:`qoder-chat-driver` 把任务工具当普通工具落 `qoder.tool-use`
 *    + `qoder.tool-result`,PartRenderer 无聚合分支时落到通用 `ToolCallRow`,
 *    于是 TaskCreate 显示成一条普通工具行而非清单卡。
 *
 * 本函数在渲染层做**纯展示聚合**(不落盘、不改 driver / 类型):把连续的任务工具调用折叠为
 * 一张清单卡(置于首个任务工具处),并从执行流中移除这些原始工具行 —— 与执行 Tab 表现一致。
 *
 * 幂等性:入参已是聚合形态(无原始任务工具 `qoder.tool-use`)时原样返回,故执行 Tab 复用安全。
 */
export function aggregateTaskToolParts(parts: DriverPart[]): DriverPart[] {
  // toolCallId → tool-result 输出(用于从 "Task #N created successfully: 主题" 解析 taskId/subject)。
  const resultByCallId = new Map<string, unknown>()
  for (const part of parts) {
    if (part.type === 'qoder.tool-result') resultByCallId.set(part.toolCallId, part.output)
  }

  const taskCallIds = new Set<string>()
  const items: Array<{ taskId: string; subject: string; completed: boolean }> = []
  const seenTaskIds = new Set<string>()
  let parentTaskId: string | undefined
  let createSeq = 0

  for (const part of parts) {
    if (part.type !== 'qoder.tool-use') continue
    if (!TASK_TOOL_NAMES.includes(part.name as (typeof TASK_TOOL_NAMES)[number])) continue
    taskCallIds.add(part.toolCallId)
    if (parentTaskId === undefined) parentTaskId = part.parentTaskId

    const input = (part.input ?? {}) as Record<string, unknown>
    const output = resultByCallId.get(part.toolCallId)
    const outputText = typeof output === 'string' ? output : undefined

    if (part.name === 'TaskCreate') {
      createSeq += 1
      const meta = parseTaskToolMeta('TaskCreate', outputText)
      // 流式早期 result 未到:退化为顺序号 + input.subject 占位,result 到达后收敛为真实 #N。
      const taskId = meta.taskId ?? String(createSeq)
      const subject = meta.subject ?? (typeof input.subject === 'string' ? input.subject : `任务 #${taskId}`)
      if (!seenTaskIds.has(taskId)) {
        seenTaskIds.add(taskId)
        items.push({ taskId, subject, completed: false })
      }
    } else if (part.name === 'TaskUpdate') {
      const meta = parseTaskToolMeta('TaskUpdate', outputText)
      const taskId = meta.taskId ?? (input.taskId !== undefined ? String(input.taskId) : '')
      const status = meta.status ?? (typeof input.status === 'string' ? input.status : '')
      if (status === 'completed' && taskId) {
        const target = items.find((item) => item.taskId === taskId)
        if (target) target.completed = true
      }
    }
    // TaskGet / TaskList / TaskStop:仅移除噪音行,不影响清单条目。
  }

  if (taskCallIds.size === 0) return parts

  const card = (): DriverPart => ({
    driverId: 'qoder',
    type: 'qoder.task-list',
    header: '添加待办',
    items: items.map((item) => ({ taskId: item.taskId, subject: item.subject, completed: item.completed })),
    ...(parentTaskId ? { parentTaskId } : {})
  })

  const out: DriverPart[] = []
  let inserted = false
  for (const part of parts) {
    const isTaskToolRow =
      (part.type === 'qoder.tool-use' || part.type === 'qoder.tool-result') && taskCallIds.has(part.toolCallId)
    if (isTaskToolRow) {
      if (!inserted && items.length > 0) {
        out.push(card())
        inserted = true
      }
      continue
    }
    out.push(part)
  }
  // 兜底:首个任务工具未被遍历到(理论上不会发生)时,把卡片补在末尾,避免条目丢失。
  if (!inserted && items.length > 0) out.push(card())
  return out
}
