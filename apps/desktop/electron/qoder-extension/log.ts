/**
 * Qoder 任务执行层的工具函数。
 *
 * 把 main.ts 里跟 Qoder SDK 强耦合的工具(qoderLogFile / logQoderMessage /
 * closeQoderQuerySafely / recordQoderMessage / qoderText)迁到这里,供
 * `QoderTaskAgentDriver` 与 main.ts 的 review / probe 路径共享。
 *
 * 注意：driver 内部按"注入依赖"的方式使用这些函数,而不是直接 import 顶层常量
 * (activeQoderQuery / store 等),保证 driver 可以单独被测试。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionUsage, TaskStore } from '@task-pipeline/core'
import type { Query, SDKMessage } from '@qoder-ai/qoder-agent-sdk'
import { sdkResultText } from '../plan-content.js'

/**
 * Qoder 阶段日志文件路径(若 `TASK_PIPELINE_QODER_LOG=1`)。
 * 文件按 `taskId-<timestamp>.jsonl` 命名,append 模式逐条写入。
 */
export function qoderLogFile(dataDir: string, taskId: string): string | undefined {
  if (process.env.TASK_PIPELINE_QODER_LOG !== '1') return undefined
  const dir = join(dataDir, 'logs', 'qoder')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(dir, `${taskId}-${stamp}.jsonl`)
}

/** 把一条 SDKMessage 写入日志文件(若 file 为 undefined 则跳过)。 */
export function logQoderMessage(file: string | undefined, message: SDKMessage): void {
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), msg: message }) + '\n', 'utf8')
  } catch {
    /* 日志写不进去不能影响主流程 */
  }
}

/**
 * 安全关闭 query 句柄,带超时保护(避免 SDK 内部泄漏阻塞后续任务)。
 * 已经在关闭/中断状态下重复调用会被 SDK 吃掉。
 */
export async function closeQoderQuerySafely(query: Query, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      query.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 提取 SDKMessage 的可见文本(给 driver / review / probe 共用)。 */
export function qoderText(message: SDKMessage): string | undefined {
  const record = message as unknown as Record<string, any>
  if (message.type === 'result') return sdkResultText(record.result, record.errors)
  if (message.type !== 'assistant') return undefined
  const content = record.message?.content
  if (!Array.isArray(content)) return undefined
  return (
    content
      .filter((item: any) => item?.type === 'text')
      .map((item: any) => item.text)
      .filter(Boolean)
      .join('\n') || undefined
  )
}

/** 从任意位置抽取非空字符串(给 parent_tool_use_id 反查用,避开 SDK 在多处的字段漂移)。 */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 是否为"文件变更"类工具（B1：成功执行时额外落一条 kind='diff' 事件）。
 * 大小写不敏感;覆盖 Qoder / Claude Code 风格的 edit / write / replace / insert / delete。
 * 刻意不含 read / grep / bash 等只读或命令型工具。
 */
function isFileMutationTool(toolName: string): boolean {
  return /^(edit|write|create|str_replace|replace|insert|delete|multiedit|patch|apply_patch)$/i.test(toolName)
}

/** 从工具输入里提取目标文件路径（edit/write 类工具的 input 字段名有多种写法）。 */
function filePathFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  for (const key of ['file_path', 'filePath', 'path', 'file', 'filename', 'file_name', 'target']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * 进程级 `tool_use_id -> task_id` 映射,跨 `recordQoderMessage` 多次调用累积。
 *
 * - 写到该 Map 的唯一入口:`task_started` 消息处理时,以其 `tool_use_id` 为键。
 * - 读取入口:其它消息的 `parent_tool_use_id` 反查。
 * - 内存中保留全部历史 task_started 的映射,适用于:
 *   - 同一任务内嵌套多层子任务(Explore -> 内部又开 Plan 之类的);
 *   - 同进程跑多任务的串行 SDK 顺序(虽然 map 跨任务不清理,但因为 tool_use_id 是 UUID
 *     不会撞车,正确性 OK;性能上每次只 O(1) 写读,内存压力极低)。
 */
const recordQoderSubtaskCtx: {
  taskIdByToolUseId: Map<string, string>
  /** tool_use_id -> tool_name,用于在 tool_result 反查时携带名字(SDK 协议里 tool_result 不带 name)。 */
  toolNameByToolUseId: Map<string, string>
  /** tool_use_id -> input,用于 result 阶段提取文件路径(B1 diff 事件;tool_result block 不带 input)。 */
  toolInputByToolUseId: Map<string, unknown>
} = {
  taskIdByToolUseId: new Map<string, string>(),
  toolNameByToolUseId: new Map<string, string>(),
  toolInputByToolUseId: new Map<string, unknown>()
}

/**
 * driver pipeline phase → 子任务卡显示名兑底。
 * SDK task_started 不带 description 时，前端用此名作为子任务卡标题。
 * 与 trace/stage-label.ts 的 agentStageLabel 映射保持一致。
 */
function pipelinePhaseLabel(phase: string): string {
  switch (phase) {
    case 'keyword':
      return '关键词提取并注入'
    case 'chat':
      return '对话生成'
    case 'planning':
      return '计划生成'
    case 'implementation':
      return '代码实现'
    case 'review':
      return '代码审查'
    case 'test_generation':
      return '测试生成'
    case 'finish':
      return '完成'
    case 'memory':
      return '记忆整理'
    default:
      return phase
  }
}

/**
 * 记录一条 SDKMessage:更新 sessionUsage + 写任务事件 + emit qoder_event。
 * 拆出来是因为 plan / implementation / test_generation 三个阶段都共用,避免在 driver 内重复。
 *
 * 子任务透传:函数会从 message.parent_tool_use_id / message.task_id / message.subtype 抽取
 * `parentTaskId / subtaskId / sdkSubtype` 三个字段并随 `addTaskEvent` 写入,这样 CodingPage 的
 * Timeline 才能用 `groupByParentTask` 把子任务内的工具调用 / 文本 / 思考折叠成卡片。
 */
export function recordQoderMessage(
  store: TaskStore,
  taskId: string,
  message: SDKMessage,
  options: {
    recordText: boolean
    /** 当前 driver  pipeline 阶段，注入到子任务事件 payload 供渲染层显示。 */
    pipelinePhase?: string
    addTaskEvent: (event: {
      taskId: string
      kind: 'message' | 'status' | 'error' | 'tool' | 'diff'
      title: string
      detail?: string
      parentTaskId?: string
      subtaskId?: string
      sdkSubtype?: string
      payload?: unknown
    }) => void
    emitPi: (event: { type: 'qoder_event'; taskId: string; message: SDKMessage }) => void
  }
): void {
  // 任务不存在时不写库、不发事件：
  // - `store.updateTask` 在任务不存在时会抛 `Task not found: <id>`；
  // - `store.addEvent` 写入 events 表，该表对 task_id 有 FK 约束，会报 `FOREIGN KEY constraint failed`。
  // 主力调用者（QoderTaskAgentDriver）走的是真实任务，这条快路径；哨兵 taskId
  // （如 `agents:generate-content` 使用的 `__agent_generator__`）走这里。
  if (!store.getTask(taskId)) return
  const text = qoderText(message)
  const current = store.getTask(taskId)?.sessionUsage

  /**
   * 抽取 SDKMessage 上的子任务关联字段。
   *
   * Qoder SDK 在每条消息上同时携带 `parent_tool_use_id` 与可选的 `task_id` / `subtype`,
   * 维护 `taskIdByToolUseId` 这个 `tool_use_id -> task_id` 映射是子任务分组的唯一关键:
   * - 看到 `task_started` 时把其 `tool_use_id -> task_id` 写入映射;
   * - 其它消息根据 `parent_tool_use_id` 反查以决定是否归属子任务。
   *
   * 函数级映射:整个进程一个 Map,跨调用累积。`recordQoderMessage` 多次调用时按
   * SDK 顺序触发,所以同 task 内子任务的 tool_use_id 一定能命中。
   */
  const ctx = recordQoderSubtaskCtx
  const sdkMessage = message as unknown as Record<string, any>
  const messageParent = readNonEmptyString(sdkMessage.parent_tool_use_id)
  const innerMessageParent = readNonEmptyString(sdkMessage.message?.parent_tool_use_id)
  const parentToolUseId = messageParent ?? innerMessageParent
  if (
    sdkMessage.type === 'system' &&
    sdkMessage.subtype === 'task_started' &&
    typeof sdkMessage.task_id === 'string' &&
    typeof sdkMessage.tool_use_id === 'string'
  ) {
    ctx.taskIdByToolUseId.set(sdkMessage.tool_use_id, sdkMessage.task_id)
  }
  const resolvedParentTaskId = parentToolUseId ? ctx.taskIdByToolUseId.get(parentToolUseId) : undefined
  const isTaskStart =
    sdkMessage.type === 'system' && sdkMessage.subtype === 'task_started' && typeof sdkMessage.task_id === 'string'
  const isTaskProgress =
    sdkMessage.type === 'system' && sdkMessage.subtype === 'task_progress' && typeof sdkMessage.task_id === 'string'
  const isTaskNotification =
    sdkMessage.type === 'system' && sdkMessage.subtype === 'task_notification' && typeof sdkMessage.task_id === 'string'
  const subtaskId = isTaskStart || isTaskProgress || isTaskNotification ? (sdkMessage.task_id as string) : undefined
  const sdkSubtype = typeof sdkMessage.subtype === 'string' ? sdkMessage.subtype : undefined
  const previous = current?.provider === 'qoder' ? current : undefined

  if (message.type === 'assistant') {
    const u = (
      message as unknown as {
        message?: {
          usage?: {
            input_tokens?: number | null
            output_tokens?: number | null
            cache_read_input_tokens?: number | null
            cache_creation_input_tokens?: number | null
          }
        }
      }
    ).message?.usage
    if (u) {
      const inputTokens = (previous?.inputTokens ?? 0) + (u.input_tokens ?? 0)
      const outputTokens = (previous?.outputTokens ?? 0) + (u.output_tokens ?? 0)
      const cacheRead = (previous?.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      const cacheWrite = (previous?.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      store.updateTask(taskId, {
        sessionUsage: {
          provider: 'qoder',
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          totalTokens: inputTokens + outputTokens + cacheRead + cacheWrite,
          costUsd: previous?.costUsd,
          durationMs: previous?.durationMs,
          turns: previous?.turns
        }
      })
    }
  }

  if (message.type === 'result') {
    const result = message as unknown as {
      duration_ms: number
      num_turns: number
      total_cost_usd?: number
      modelUsage?: Record<
        string,
        {
          inputTokens: number
          outputTokens: number
          cacheReadInputTokens: number
          cacheCreationInputTokens: number
          costUSD: number
        }
      >
      usage?: {
        input_tokens?: number | null
        output_tokens?: number | null
        cache_read_input_tokens?: number | null
        cache_creation_input_tokens?: number | null
      }
    }
    const models = Object.values(result.modelUsage ?? {})
    const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'costUSD') =>
      models.reduce((s, m) => s + ((m?.[k] as number) ?? 0), 0)
    const mIn = sum('inputTokens'),
      mOut = sum('outputTokens'),
      mRd = sum('cacheReadInputTokens'),
      mWr = sum('cacheCreationInputTokens'),
      mCost = sum('costUSD')
    const uIn = result.usage?.input_tokens ?? 0,
      uOut = result.usage?.output_tokens ?? 0,
      uRd = result.usage?.cache_read_input_tokens ?? 0,
      uWr = result.usage?.cache_creation_input_tokens ?? 0
    const pick = (mv: number, uv: number, prev: number | undefined) => (mv > 0 ? mv : uv > 0 ? uv : (prev ?? 0))
    const inputTokens = pick(mIn, uIn, previous?.inputTokens)
    const outputTokens = pick(mOut, uOut, previous?.outputTokens)
    const cacheRead = pick(mRd, uRd, previous?.cacheReadTokens)
    const cacheWrite = pick(mWr, uWr, previous?.cacheWriteTokens)
    const cost = mCost > 0 ? mCost : (result.total_cost_usd ?? 0)
    const usage: SessionUsage = {
      provider: 'qoder',
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: inputTokens + outputTokens + cacheRead + cacheWrite,
      costUsd: (previous?.costUsd ?? 0) + cost,
      durationMs: (previous?.durationMs ?? 0) + result.duration_ms,
      turns: (previous?.turns ?? 0) + result.num_turns
    }
    store.updateTask(taskId, { sessionUsage: usage })
  }

  /**
   * 抽取 assistant.tool_use / user.tool_result → 缓存到 toolBlocks,作为 timeline 的「工具调用」子条目。
   *
   * 之前 log.ts 只在 assistant 文本上写 message 条目,tool_use / tool_result 直接被丢弃,所以
   * timeline 看不到子任务内的工具执行痕迹。这里按 SDK 顺序成对收集,执行了什么(input) 在
   * tool_use,结果是什么(output) 在 tool_result,稍后以 kind='tool' 事件写入 events 表,
   * 前端按 toolUseId 配对渲染。
   */
  type ExtractedToolBlock = {
    toolUseId: string
    toolName: string
    phase: 'use' | 'result'
    input?: unknown
    output?: unknown
    isError?: boolean
  }
  const toolBlocks: ExtractedToolBlock[] = []
  const msgContent = sdkMessage.message?.content
  if (Array.isArray(msgContent)) {
    for (const block of msgContent) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (
        message.type === 'assistant' &&
        b.type === 'tool_use' &&
        typeof b.id === 'string' &&
        typeof b.name === 'string'
      ) {
        const toolUseId = b.id
        const toolName = b.name
        ctx.toolNameByToolUseId.set(toolUseId, toolName)
        toolBlocks.push({ toolUseId, toolName, phase: 'use', input: b.input })
        ctx.toolInputByToolUseId.set(toolUseId, b.input)
      } else if (message.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const toolUseId = b.tool_use_id
        const toolName = ctx.toolNameByToolUseId.get(toolUseId) ?? 'tool'
        toolBlocks.push({ toolUseId, toolName, phase: 'result', output: b.content, isError: b.is_error === true })
      }
    }
  }

  // 子任务关联字段打包到 payload(数据库 events 表没有 parent_task_id / subtask_id 列,
  // 但 payload 本身就是 JSON 列,前端可读出来用于 groupByParentTask)。
  //
  // 子任务三类消息(task_started / task_progress / task_notification)自指
  // `parentTaskId = subtaskId`:SDK 在 system 任务消息上不会重复携带 parent_tool_use_id,
  // 所以这里用消息自身携带的 task_id 兜底,与 qoder-trace.ts 解析侧、qoder-chat-driver
  // 的 subtask-* part 保持一致;这样 groupByParentTask 能依据 `parentTaskId` 把它们归到
  // 同一子任务 group,task_started 被识别为 group header。其它消息仍走
  // `parent_tool_use_id` 反查路径。
  const subtaskPayload: {
    parentTaskId?: string
    subtaskId?: string
    sdkSubtype?: string
    pipelineStage?: string
    stageId?: string
  } = {
    ...(resolvedParentTaskId && !subtaskId ? { parentTaskId: resolvedParentTaskId } : {}),
    ...(subtaskId ? { subtaskId } : {}),
    ...(sdkSubtype ? { sdkSubtype } : {}),
    // pipeline 阶段名注入：子任务组内所有事件都携带，前端任意事件做 group header 时都能显示子任务卡标题
    ...(options.pipelinePhase && (subtaskId || resolvedParentTaskId)
      ? { pipelineStage: pipelinePhaseLabel(options.pipelinePhase) }
      : {}),
    // 阶段归属注入：子任务控制事件携带所属主任务 taskId，前端 interleaveTimeline 据此把子任务组
    // 嵌套进主任务阶段卡（而非与主流程平级）
    ...(subtaskId ? { stageId: taskId } : {})
  }
  if (subtaskId) subtaskPayload.parentTaskId = subtaskId
  const hasSubtaskMeta = Object.keys(subtaskPayload).length > 0

  if (text && options.recordText) {
    const usageObj = sdkMessage.message?.usage
    const usage = usageObj && typeof usageObj === 'object' ? (usageObj as Record<string, unknown>) : undefined
    options.addTaskEvent({
      taskId,
      kind: 'message',
      title: 'Qoder Agent',
      detail: text,
      ...(hasSubtaskMeta
        ? {
            payload: {
              ...subtaskPayload,
              ...(usage ? { usage } : {})
            }
          }
        : usage
          ? { payload: { usage } }
          : {})
    })
  } else if (message.type === 'system') {
    // 子任务三类消息独立成 title,与 trace 解析侧保持一致,
    // 渲染层(groupByParentTask)用 sdkSubtype 把它们从普通 status 里识别出来。
    let title = `Qoder ${message.subtype}`
    if (sdkMessage.subtype === 'task_started') title = 'Qoder 子任务启动'
    else if (sdkMessage.subtype === 'task_progress') title = 'Qoder 子任务进度'
    else if (sdkMessage.subtype === 'task_notification') title = 'Qoder 子任务收尾'
    options.addTaskEvent({
      taskId,
      kind: 'status',
      title,
      detail: JSON.stringify(message).slice(0, 2000),
      payload: {
        ...(hasSubtaskMeta ? subtaskPayload : {}),
        ...(sdkMessage.subtype === 'task_started'
          ? {
              taskType: readNonEmptyString(sdkMessage.task_type),
              subagentType: readNonEmptyString(sdkMessage.subagent_type),
              toolUseId: readNonEmptyString(sdkMessage.tool_use_id),
              description: readNonEmptyString(sdkMessage.description)
            }
          : {}),
        ...(sdkMessage.subtype === 'task_progress'
          ? {
              lastToolName: readNonEmptyString(sdkMessage.last_tool_name),
              description: readNonEmptyString(sdkMessage.description),
              summary: readNonEmptyString(sdkMessage.summary),
              usage: sdkMessage.usage
            }
          : {}),
        ...(sdkMessage.subtype === 'task_notification'
          ? {
              status: readNonEmptyString(sdkMessage.status),
              summary: readNonEmptyString(sdkMessage.summary),
              outputFile: readNonEmptyString(sdkMessage.output_file),
              usage: sdkMessage.usage
            }
          : {})
      }
    })
  }

  // 工具调用事件:每个 tool_use / tool_result block 写一条 kind='tool' 事件,前端按 toolUseId 配对展示。
  // 子任务归属走 resolvedParentTaskId:assistant/user 消息上的 parent_tool_use_id → task_started 的 task_id。
  const toolDetailLimit = 2000
  for (const block of toolBlocks) {
    const isUse = block.phase === 'use'
    let detail: string | undefined
    try {
      if (isUse) {
        detail = JSON.stringify(block.input, null, 2).slice(0, toolDetailLimit)
      } else {
        detail = JSON.stringify(block.output, null, 2).slice(0, toolDetailLimit)
      }
    } catch {
      detail = isUse ? '[unserializable input]' : '[unserializable output]'
    }
    options.addTaskEvent({
      taskId,
      kind: 'tool',
      title: block.toolName,
      ...(typeof detail === 'string' ? { detail } : {}),
      ...(resolvedParentTaskId || subtaskId
        ? {
            payload: {
              ...(resolvedParentTaskId ? { parentTaskId: resolvedParentTaskId } : {}),
              ...(subtaskId ? { subtaskId } : {}),
              toolName: block.toolName,
              toolUseId: block.toolUseId,
              ...(isUse
                ? { phase: 'use' as const, input: block.input }
                : { phase: 'result' as const, output: block.output, ...(block.isError ? { isError: true } : {}) })
            }
          }
        : isUse
          ? {
              payload: {
                toolName: block.toolName,
                toolUseId: block.toolUseId,
                phase: 'use' as const,
                input: block.input
              }
            }
          : {
              payload: {
                toolName: block.toolName,
                toolUseId: block.toolUseId,
                phase: 'result' as const,
                output: block.output,
                ...(block.isError ? { isError: true } : {})
              }
            })
    })
    // 文件变更事件(B1):编辑/写入/替换类工具成功执行 → 额外写一条 kind='diff',
    // 让任务 trace 有「文件变更」分类(此前该 kind 零写入)。仅 result 阶段写一次,失败不记。
    // 文件路径从 use 阶段缓存的 input 提取(tool_result 本身不带 input)。
    if (!isUse && block.isError !== true && isFileMutationTool(block.toolName)) {
      const filePath = filePathFromToolInput(block.input ?? ctx.toolInputByToolUseId.get(block.toolUseId))
      options.addTaskEvent({
        taskId,
        kind: 'diff',
        title: `edit ${filePath ?? block.toolName}`,
        ...(typeof filePath === 'string' ? { detail: filePath } : {}),
        ...(resolvedParentTaskId || subtaskId
          ? {
              payload: {
                ...(resolvedParentTaskId ? { parentTaskId: resolvedParentTaskId } : {}),
                ...(subtaskId ? { subtaskId } : {}),
                toolName: block.toolName,
                toolUseId: block.toolUseId,
                filePath
              }
            }
          : { payload: { toolName: block.toolName, toolUseId: block.toolUseId, filePath } })
      })
    }
  }
  options.emitPi({ type: 'qoder_event', taskId, message })
}
