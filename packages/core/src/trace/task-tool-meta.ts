/**
 * 任务工具（TaskCreate / TaskUpdate / TaskGet / TaskList / TaskStop）语义解析共享函数。
 *
 * Qoder SDK 内置的"任务清单管理"工具不产生 subtask.run，
 * input 落盘为空对象 `{}`（SDK 行为），任务主题只存在于 output 文本。
 * 此函数从 output 文本中正则提取语义，供渲染层（PartRenderer / Waterfall）双端复用。
 *
 * 设计原则：
 * - 只读 `name` 与 `output`，不依赖埋点新增字段 —— 对已落盘的 trace 立即可用。
 * - 解析失败降级为 `{ isTaskTool: true, action: 'unknown' }`，绝不吞数据。
 */

const TASK_CREATE_RE = /#(\d+)\s+created successfully:\s*(.+)$/
const TASK_UPDATE_RE = /#(\d+)\s+status(?:\s+to\s+(\w+))?/

export const TASK_TOOL_NAMES = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop'] as const

export type TaskToolAction = 'create' | 'update' | 'get' | 'list' | 'stop' | 'unknown'

export type TaskToolMeta = {
  isTaskTool: boolean
  action: TaskToolAction
  /** output 里的 #N（任务序号）。 */
  taskId?: string
  /** create output 解析出的任务主题。 */
  subject?: string
  /** update output 解析出的目标状态（如 completed）。 */
  status?: string
}

export function parseTaskToolMeta(name: string, output?: unknown): TaskToolMeta {
  if (!TASK_TOOL_NAMES.includes(name as (typeof TASK_TOOL_NAMES)[number])) {
    return { isTaskTool: false, action: 'unknown' }
  }

  const outputText = typeof output === 'string' ? output : ''
  const action = name.toLowerCase().replace('task', '') as TaskToolAction

  if (name === 'TaskCreate') {
    const m = outputText.match(TASK_CREATE_RE)
    if (!m) return { isTaskTool: true, action: 'create' }
    return { isTaskTool: true, action: 'create', taskId: m[1]!, subject: m[2]!.trim() }
  }

  if (name === 'TaskUpdate') {
    const m = outputText.match(TASK_UPDATE_RE)
    if (!m) return { isTaskTool: true, action: 'update' }
    return { isTaskTool: true, action: 'update', taskId: m[1]!, status: m[2] ?? undefined }
  }

  // TaskGet / TaskList / TaskStop —— 通用 taskId 提取
  const idMatch = outputText.match(/#(\d+)/)
  return {
    isTaskTool: true,
    action,
    taskId: idMatch ? idMatch[1] : undefined
  }
}
