import { Fragment, useMemo, type ReactNode } from 'react'
import { TextPart } from './parts/TextPart'
import { ThinkingPart } from './parts/ThinkingPart'
import { QoderSessionPart } from './parts/QoderSessionPart'
import type { DriverPart } from '@/api'
import {
  SubTaskGroup,
  SubTaskHeader,
  SubTaskProgressSummary,
  SubTaskResultBlock,
  ToolCallRow,
  aggregateSubTaskProgress,
  interleaveTimeline,
  spawnerToolUseIdOf,
  subtaskStatusOf,
  toolInputSummary,
  type ParentedItem,
  type SubTaskProgressSample,
  type ToolCallStatus
} from '@/components/SubTaskGroup'

/**
 * 把 `DriverPart` 适配成 `ParentedItem`,让通用 `interleaveTimeline` 工具可以拆分子任务。
 *
 * 字段映射:
 * - `parentTaskId`: DriverPart 上的可选 parentTaskId(子任务 ID,undefined = 主流程)
 * - `taskId` / `subtaskId`: subtask-start / subtask-progress / subtask-end 三个 part 上携带
 *   的子任务 ID,用于把 subtask-start 识别为 group header(规则:`item.taskId === parent`)。
 * - `sdkSubtype`: 透传"task_started"等,让另一条 header 识别规则生效。
 */
function parentedPartOf(part: DriverPart): ParentedItem {
  if (part.type === 'qoder.subtask-start') {
    return { parentTaskId: part.parentTaskId, taskId: part.taskId, sdkSubtype: 'task_started' }
  }
  if (part.type === 'qoder.subtask-progress') {
    return { parentTaskId: part.parentTaskId, taskId: part.taskId, sdkSubtype: 'task_progress' }
  }
  if (part.type === 'qoder.subtask-end') {
    return { parentTaskId: part.parentTaskId, taskId: part.taskId, sdkSubtype: 'task_notification' }
  }
  // 其它变体(text / thinking / tool-use / tool-result / openai.*)都可选带 parentTaskId。
  // qoder.session 不属于任何 part 的内容,不挂 parentTaskId。
  if (part.type === 'qoder.session') return {}
  return { parentTaskId: part.parentTaskId }
}

/** 是不是"子任务控制 part",渲染层不直接展示。 */
function isSubtaskControlPart(part: DriverPart): boolean {
  return (
    part.type === 'qoder.subtask-start' || part.type === 'qoder.subtask-progress' || part.type === 'qoder.subtask-end'
  )
}

/** tool-result part 的输出与错误标记(qoder / openai 两变体同构)。 */
function resultPayloadOf(part: DriverPart | undefined): { output?: unknown; isError?: boolean } | undefined {
  if (!part) return undefined
  if (part.type !== 'qoder.tool-result' && part.type !== 'openai.tool-result') return undefined
  return { output: part.output, isError: 'isError' in part ? part.isError === true : undefined }
}

/**
 * 按 `DriverPart.type` 路由到具体 part 渲染器。
 *
 * 设计要点:
 *  - 顶层用 `interleaveTimeline` 把 part 拆成"主流程 + 子任务折叠卡",子任务卡锚定在
 *    subtask-start 的真实时间点(不再是旧 groupByParentTask 的「先 main 后 groups」)。
 *  - `qoder.tool-use` / `openai.tool-call` 与 tool-result 按 toolCallId 全局配对,统一渲染成
 *    共享 ToolCallRow(Qoder 风格紧凑单行,点击展开输入/输出);孤儿 tool-result 单行兜底。
 *  - 主流程里发起子任务的那条工具调用(subtask-start.toolUseId 命中)被吸收进子任务卡,
 *    其 result 作为卡片底部「输出」段,主流程不再重复展示。
 *  - 多条 `qoder.subtask-progress` 聚合成卡片顶部一行统计(运行中附最新 description);
 *    subtask-start / subtask-end 只驱动 header 与状态徽章,不直接渲染。
 *  - `text` part 由 `TextPart` 渲染(`MessageResponse` 流式 markdown),不区分 driver。
 */
export function PartRenderer({ parts, isStreaming }: { parts: DriverPart[]; isStreaming?: boolean }) {
  // 同一次 interleaveTimeline 调用内要拿回原始 DriverPart,需要 ParentedItem 引用一致。
  // interleaveTimeline 内部 push 的就是这里传入的对象,所以 parts.map(parentedPartOf) 这一份
  // 就是"唯一来源",byParented 与 blocks 都按它索引,引用相同才能 hit。
  const parentedList = useMemo(() => parts.map(parentedPartOf), [parts])
  const blocks = useMemo(() => interleaveTimeline(parentedList), [parentedList])
  const byParented = useMemo(() => {
    const out = new Map<ParentedItem, DriverPart>()
    parentedList.forEach((p, index) => out.set(p, parts[index]!))
    return out
  }, [parentedList, parts])

  // 全局工具配对上下文:tool-result 按 callId 索引,tool-use 的 callId 集合用于孤儿判断。
  const toolCtx = useMemo(() => {
    const resultByCallId = new Map<string, DriverPart>()
    const useCallIds = new Set<string>()
    for (const part of parts) {
      if (part.type === 'qoder.tool-result' || part.type === 'openai.tool-result')
        resultByCallId.set(part.toolCallId, part)
      if (part.type === 'qoder.tool-use' || part.type === 'openai.tool-call') useCallIds.add(part.toolCallId)
    }
    return { resultByCallId, useCallIds }
  }, [parts])

  // 主流程里发起子任务的工具调用(subtask-start.toolUseId → taskId)。
  // 这些调用不再单独渲染成行 —— 子任务折叠卡就是它们的呈现(跟 Qoder 一致)。
  const spawnerTaskByCallId = useMemo(() => {
    const map = new Map<string, string>()
    for (const block of blocks) {
      if (block.kind !== 'group') continue
      const headerPart = block.header ? byParented.get(block.header) : undefined
      const toolUseId = headerPart ? spawnerToolUseIdOf(headerPart) : undefined
      if (toolUseId) map.set(toolUseId, block.taskId)
    }
    return map
  }, [blocks, byParented])

  // 被吸收调用的结果输出(taskId → output),作为卡片底部「输出」段。
  const absorbedOutputByTaskId = useMemo(() => {
    const map = new Map<string, { output?: unknown; isError?: boolean }>()
    for (const [callId, taskId] of spawnerTaskByCallId) {
      const result = resultPayloadOf(toolCtx.resultByCallId.get(callId))
      if (!result) continue
      map.set(taskId, result)
    }
    return map
  }, [spawnerTaskByCallId, toolCtx])

  /** 单个 part 渲染(subtask-* 控制 part 与被吸收的 spawner 调用返回 null)。 */
  const renderSinglePart = (part: DriverPart, key: string): ReactNode => {
    if (part.type === 'text') {
      return <TextPart key={key} part={part} isAnimating={isStreaming} />
    }
    if (part.type === 'qoder.thinking') {
      return <ThinkingPart key={key} part={part} isStreaming={isStreaming} />
    }
    if (part.type === 'qoder.session') {
      return <QoderSessionPart key={key} part={part} />
    }
    if (part.type === 'qoder.tool-use' || part.type === 'openai.tool-call') {
      if (spawnerTaskByCallId.has(part.toolCallId)) return null // 吸收进子任务卡
      const result = resultPayloadOf(toolCtx.resultByCallId.get(part.toolCallId))
      const status: ToolCallStatus = result?.isError ? 'error' : !result && isStreaming ? 'running' : 'done'
      return (
        <ToolCallRow
          key={key}
          name={part.name}
          summary={toolInputSummary(part.input)}
          input={part.input}
          output={result?.output}
          status={status}
        />
      )
    }
    if (part.type === 'qoder.tool-result' || part.type === 'openai.tool-result') {
      // 孤儿兜底:对应 tool-use 不存在(乱序历史)才单独展示;已配对的内容已并入 tool-use 行。
      if (toolCtx.useCallIds.has(part.toolCallId)) return null
      return (
        <ToolCallRow
          key={key}
          name="工具结果"
          output={part.output}
          status={'isError' in part && part.isError ? 'error' : 'done'}
        />
      )
    }
    // subtask-start / subtask-progress / subtask-end 不直接渲染:
    //  - subtask-start: 已被提升为 group header(SubTaskHeader)
    //  - subtask-progress: 聚合成卡片顶部统计行(SubTaskProgressSummary)
    //  - subtask-end: 只驱动 header 状态徽章(task_notification 内容不重复展示)
    return null
  }

  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'main') {
          const part = byParented.get(block.item)
          if (!part) return null
          return <Fragment key={`m-${index}`}>{renderSinglePart(part, `p-${index}`)}</Fragment>
        }
        const headerPart = block.header ? byParented.get(block.header) : undefined
        const startPart = headerPart?.type === 'qoder.subtask-start' ? headerPart : undefined
        const childParts = block.children.map((p) => byParented.get(p)).filter((p): p is DriverPart => Boolean(p))
        // 找收尾(子任务最后一个 subtask-end)→ 决定 header 状态徽章
        const endPart = childParts.find(
          (p): p is Extract<DriverPart, { type: 'qoder.subtask-end' }> => p.type === 'qoder.subtask-end'
        )
        const status = endPart
          ? subtaskStatusOf({ payload: { status: endPart.status } })
          : startPart
            ? 'running'
            : 'unknown'
        const samples: SubTaskProgressSample[] = childParts
          .filter(
            (p): p is Extract<DriverPart, { type: 'qoder.subtask-progress' }> => p.type === 'qoder.subtask-progress'
          )
          .map((p) => ({
            lastToolName: p.lastToolName,
            description: p.description,
            usage: p.usage as SubTaskProgressSample['usage']
          }))
        const aggregate = aggregateSubTaskProgress(samples)
        const absorbed = absorbedOutputByTaskId.get(block.taskId)
        const visibleChildren = childParts.filter((p) => !isSubtaskControlPart(p))
        return (
          <SubTaskGroup
            key={`g-${block.taskId}-${index}`}
            taskId={block.taskId}
            header={
              <SubTaskHeader
                description={startPart?.description}
                taskType={startPart?.taskType}
                subagentType={startPart?.subagentType}
                status={status}
              />
            }
          >
            <SubTaskProgressSummary aggregate={aggregate} running={status === 'running'} />
            {visibleChildren.map((part, i) => renderSinglePart(part, `${block.taskId}-${i}`))}
            <SubTaskResultBlock output={absorbed?.output} isError={absorbed?.isError} />
          </SubTaskGroup>
        )
      })}
    </>
  )
}
