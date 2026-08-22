import { Fragment, useMemo, type ReactNode } from 'react'
import { WrenchIcon } from 'lucide-react'
import { TextPart } from './parts/TextPart'
import { ThinkingPart } from './parts/ThinkingPart'
import { QoderSessionPart } from './parts/QoderSessionPart'
import {
  WriteToolBlock,
  EditToolBlock,
  ReadToolBlock,
  GrepToolBlock,
  BashToolBlock,
  McpToolBlock,
  WebFetchToolBlock
} from './parts/ToolBlocks'
import { TaskListCard } from './parts/TaskListCard'
import type { ChatPlan, DriverPart } from '@/api'
import { PlanCard } from '@/pages/ChatPage/components/PlanCard'
import {
  SubTaskGroup,
  SubTaskHeader,
  SubTaskProgressSummary,
  SubTaskResultBlock,
  ToolCallRow,
  aggregateSubTaskProgress,
  buildSpawnerContext,
  determineToolStatus,
  hasToolUse,
  interleaveTimeline,
  pairToolCalls,
  spawnerToolUseIdOf,
  subtaskStatusOf,
  toolInputSummary,
  type ParentedItem,
  type SubTaskProgressSample,
  type SubTaskStatus
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
    return { parentTaskId: part.parentTaskId, taskId: part.taskId, sdkSubtype: 'task_started', stageId: part.stageId }
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

/** text part 渲染入口：走流式 markdown。 */
function TextPartOrDSML({ part, isAnimating }: { part: Extract<DriverPart, { type: 'text' }>; isAnimating?: boolean }) {
  return <TextPart part={part} isAnimating={isAnimating} />
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
 *  - `plan` part 由 `PlanCard` 渲染，显示结构化计划并提供“执行计划”按钮。
 *  - 当 `isPlanMode` 为 true 时，文本 parts 被累积并渲染为 PlanCard（显示“计划生成中...”）。
 */
export function PartRenderer({
  parts,
  isStreaming,
  isPlanMode,
  onExecutePlan
}: {
  parts: DriverPart[]
  isStreaming?: boolean
  /** 计划模式标记：为 true 时将文本内容渲染为 PlanCard（显示“计划生成中...”）。 */
  isPlanMode?: boolean
  onExecutePlan?: (plan: ChatPlan) => void
}) {
  // 合并相邻的同类型流式增量 part:
  //  - qoder.thinking:SDK 按 thinking_delta 拆分,每条渲染一个折叠块会刷屏(8+ 个空标题块);
  //  - text:SDK 按 text_delta 拆分,每条渲染一个独立 markdown 块会让正文分段、代码块/列表断裂。
  // 合并后只保留一个「深度思考」折叠块、一个完整正文段。
  const mergedParts = useMemo(() => {
    const out: DriverPart[] = []
    for (const part of parts) {
      const last = out[out.length - 1]
      // qoder.thinking / openai.thinking 都是流式增量拆分,合并成单个「深度思考」折叠块,
      // 避免流式渲染时刷屏(8+ 个空标题块)。
      // 两者的 delta 都是 token 粒度(qoder 的 thinking_delta 与 openai 的 reasoning-delta
      // 一样逐词推送),一律直接拼接;若用 \n 分隔会把每个词拆成独立一行,思考文案被拆碎。
      if (part.type === 'qoder.thinking' && last?.type === 'qoder.thinking') {
        const signature = part.signature && last.signature !== part.signature ? part.signature : last.signature
        const parentTaskId = part.parentTaskId ?? last.parentTaskId
        out[out.length - 1] = {
          driverId: part.driverId,
          type: 'qoder.thinking',
          text: `${last.text}${part.text}`,
          ...(signature ? { signature } : {}),
          ...(parentTaskId ? { parentTaskId } : {})
        } as DriverPart
      } else if (part.type === 'openai.thinking' && last?.type === 'openai.thinking') {
        const parentTaskId = part.parentTaskId ?? last.parentTaskId
        out[out.length - 1] = {
          driverId: part.driverId,
          type: 'openai.thinking',
          text: `${last.text}${part.text}`,
          ...(parentTaskId ? { parentTaskId } : {})
        } as DriverPart
      } else if (
        part.type === 'text' &&
        last?.type === 'text' &&
        (part.parentTaskId ?? null) === (last.parentTaskId ?? null)
      ) {
        const parentTaskId = part.parentTaskId ?? last.parentTaskId
        out[out.length - 1] = {
          driverId: part.driverId,
          type: 'text',
          text: `${last.text}${part.text}`,
          ...(parentTaskId ? { parentTaskId } : {})
        } as DriverPart
      } else {
        out.push(part)
      }
    }
    return out
  }, [parts])

  // 同一次 interleaveTimeline 调用内要拿回原始 DriverPart,需要 ParentedItem 引用一致。
  // interleaveTimeline 内部 push 的就是这里传入的对象,所以 mergedParts.map(parentedPartOf) 这一份
  // 就是"唯一来源",byParented 与 blocks 都按它索引,引用相同才能 hit。
  const parentedList = useMemo(() => mergedParts.map(parentedPartOf), [mergedParts])
  const blocks = useMemo(() => interleaveTimeline(parentedList), [parentedList])
  const byParented = useMemo(() => {
    const out = new Map<ParentedItem, DriverPart>()
    parentedList.forEach((p, index) => out.set(p, mergedParts[index]!))
    return out
  }, [parentedList, mergedParts])

  // 全局工具配对:use + result 按 toolCallId 配对(共享算法)。
  const toolPairs = useMemo(
    () =>
      pairToolCalls<DriverPart>(
        mergedParts,
        (part) => {
          if (part.type === 'qoder.tool-use' || part.type === 'openai.tool-call') return part.toolCallId
          if (part.type === 'qoder.tool-result' || part.type === 'openai.tool-result') return part.toolCallId
          return undefined
        },
        (part) => part.type === 'qoder.tool-result' || part.type === 'openai.tool-result'
      ),
    [mergedParts]
  )

  // spawner 吸收上下文:发起子任务的工具调用不单独渲染,结果进子任务卡底部输出段。
  const { spawnerTaskByCallId, absorbedOutputByTaskId } = useMemo(
    () =>
      buildSpawnerContext<ParentedItem, DriverPart>(
        blocks,
        toolPairs,
        (header) => {
          const part = header ? byParented.get(header) : undefined
          return part ? spawnerToolUseIdOf(part) : undefined
        },
        (resultPart) => resultPayloadOf(resultPart)
      ),
    [blocks, toolPairs, byParented]
  )

  /** 单个 part 渲染(subtask-* 控制 part 与被吸收的 spawner 调用返回 null)。 */
  const renderSinglePart = (part: DriverPart, key: string): ReactNode => {
    if (part.type === 'text') {
      return <TextPartOrDSML key={key} part={part} isAnimating={isStreaming} />
    }
    if (part.type === 'plan') {
      // 对话已结束且计划未执行 → 标记为已取消
      const plan =
        !isStreaming && part.plan.status === 'pending' ? { ...part.plan, status: 'cancelled' as const } : part.plan
      return <PlanCard key={key} plan={plan} onExecute={onExecutePlan} disabled={isStreaming} />
    }
    if (part.type === 'qoder.thinking' || part.type === 'openai.thinking') {
      return <ThinkingPart key={key} part={part} isStreaming={isStreaming} />
    }
    if (part.type === 'qoder.session') {
      return <QoderSessionPart key={key} part={part} />
    }
    if (part.type === 'qoder.task-list') {
      return <TaskListCard key={key} header={part.header} items={part.items} />
    }
    if (part.type === 'qoder.tool-use' || part.type === 'openai.tool-call') {
      if (spawnerTaskByCallId.has(part.toolCallId)) return null // 吸收进子任务卡
      const pair = toolPairs.get(part.toolCallId)
      const result = resultPayloadOf(pair?.resultItem)
      const status = determineToolStatus(pair, result?.isError === true, !!isStreaming)
      // 按工具名路由到专用渲染器（大小写不敏感：Qoder 用首字母大写 Write/Edit/Read…，
      // Pi 用小写 write/edit/read…，统一匹配以让两套工具链路走同一套专用渲染器）。
      const toolNameLower = part.name.toLowerCase()
      if (toolNameLower === 'write') {
        return <WriteToolBlock key={key} input={part.input} output={result?.output} status={status} />
      }
      if (toolNameLower === 'edit') {
        return <EditToolBlock key={key} input={part.input} output={result?.output} status={status} />
      }
      if (toolNameLower === 'read' || toolNameLower === 'read_file') {
        return <ReadToolBlock key={key} input={part.input} output={result?.output} status={status} />
      }
      if (toolNameLower === 'grep') {
        return <GrepToolBlock key={key} input={part.input} output={result?.output} status={status} />
      }
      if (toolNameLower === 'bash') {
        return <BashToolBlock key={key} input={part.input} output={result?.output} status={status} />
      }
      if (toolNameLower === 'webfetch' || toolNameLower === 'web_fetch') {
        return <WebFetchToolBlock key={key} input={part.input} output={result?.output} status={status} />
      }
      // 目录列举类工具（Qoder Glob / Pi find+ls+list_dir）不单独展示，统一隐藏
      if (
        toolNameLower === 'glob' ||
        toolNameLower === 'find' ||
        toolNameLower === 'ls' ||
        toolNameLower === 'list_dir'
      ) {
        return null
      }
      // AskUserQuestion：交互由内联 AskUserQuestionCard（approval 体系）承载，通用 ToolCallRow 隐藏。
      if (toolNameLower === 'askuserquestion') {
        return null
      }
      if (part.name.startsWith('mcp__')) {
        return <McpToolBlock key={key} name={part.name} input={part.input} output={result?.output} status={status} />
      }
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
      // 孤儿兜底:对应 tool-use 不存在(乱序历史/HITL 超时拒绝)才单独展示;
      // 已配对的内容已并入 tool-use 行。用 Bash 卡片风格展示,确保拒绝信息可见。
      if (hasToolUse(toolPairs, part.toolCallId)) return null
      return (
        <BashToolBlock
          key={key}
          input={{ description: '工具执行' }}
          output={part.output}
          status={'isError' in part && part.isError ? 'error' : 'done'}
          icon={WrenchIcon}
        />
      )
    }
    if (part.type === 'qoder.task-update') {
      return (
        <TaskListCard
          key={key}
          header={part.header}
          items={part.items}
          updatedTaskId={part.updatedTaskId}
          updatePhase={part.updatePhase}
        />
      )
    }
    // subtask-start / subtask-progress / subtask-end 不直接渲染:
    //  - subtask-start: 已被提升为 group header(SubTaskHeader)
    //  - subtask-progress: 聚合成卡片顶部统计行(SubTaskProgressSummary)
    //  - subtask-end: 只驱动 header 状态徽章(task_notification 内容不重复展示)
    return null
  }

  // 收集所有顶层 + 嵌套 subtask-start 的顺序，用于判断各组独立状态：
  // 管道阶段是顺序执行的，如果后面有组启动了，前面的组即使没有 subtask-end 也算完成。
  const allGroupStarts: { block: (typeof blocks)[number] }[] = []
  function collectGroups(blks: typeof blocks) {
    for (const b of blks) {
      if (b.kind === 'group') {
        allGroupStarts.push({ block: b })
        if (b.nested?.length) collectGroups(b.nested)
      }
    }
  }
  collectGroups(blocks)

  const renderBlock = (block: (typeof blocks)[number], index: number): ReactNode => {
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
    // 各组独立状态：有 subtask-end 取真实状态；否则看是否有后续组已启动（管道顺序执行）
    let status: SubTaskStatus
    if (endPart) {
      status = subtaskStatusOf({ payload: { status: endPart.status } })
    } else if (!isStreaming) {
      status = 'completed'
    } else {
      // 任务执行中：如果后面有组启动了 subtask-start，本组已完成；否则本组是当前活跃组
      const myIdx = allGroupStarts.findIndex((g) => g.block === block)
      const laterStarted = allGroupStarts.slice(myIdx + 1).some((g) => {
        if (g.block.kind !== 'group') return false
        const hp = g.block.header ? byParented.get(g.block.header) : undefined
        return hp?.type === 'qoder.subtask-start'
      })
      status = laterStarted ? 'completed' : 'running'
    }
    const samples: SubTaskProgressSample[] = childParts
      .filter((p): p is Extract<DriverPart, { type: 'qoder.subtask-progress' }> => p.type === 'qoder.subtask-progress')
      .map((p) => ({
        lastToolName: p.lastToolName,
        description: p.description,
        usage: p.usage as SubTaskProgressSample['usage']
      }))
    const aggregate = aggregateSubTaskProgress(samples)
    const absorbed = absorbedOutputByTaskId.get(block.taskId)
    // 嵌套子组的 header 会被提升为独立的子任务卡，不应计入本组可见操作数
    const nestedTaskIds = new Set(block.nested?.filter((n) => n.kind === 'group').map((n) => n.taskId) ?? [])
    const visibleChildren = childParts.filter(
      (p) => !isSubtaskControlPart(p) && !(p.type === 'qoder.subtask-start' && nestedTaskIds.has(p.taskId))
    )
    // 停止对话时,Agent 可能已启动(subtask-start)但未产出任何内容;
    // 没有可见子项且没有吸收输出时不展示该 Agent 卡片。
    if (visibleChildren.length === 0 && !absorbed && (!block.nested || block.nested.length === 0)) return null

    // 子项与嵌套子组按时间线穿插排列（以各自在 parentedList 中的位置为准）：
    // 嵌套子组不再一律沉到卡片末尾，否则发生在阶段中段的子任务（如 planning 中途
    // 委派的 Explore）会显示在该阶段后续操作之后，视觉上时序倒挂。
    const partIndexOf = (part: DriverPart) => mergedParts.indexOf(part)
    const blockIndexOf = (b: (typeof blocks)[number]): number => {
      if (b.kind === 'group') {
        if (b.header) return parentedList.indexOf(b.header)
        const first = b.children[0]
        if (first) return parentedList.indexOf(first)
      }
      return Number.MAX_SAFE_INTEGER
    }
    const entries: Array<{ index: number; node: ReactNode }> = [
      ...visibleChildren.map((part) => {
        const idx = partIndexOf(part)
        return { index: idx, node: renderSinglePart(part, `p-${idx}`) }
      }),
      ...(block.nested ?? []).map((nested, ni) => ({ index: blockIndexOf(nested), node: renderBlock(nested, ni) }))
    ]
    entries.sort((a, b) => a.index - b.index)

    return (
      <SubTaskGroup
        key={`g-${block.taskId}-${index}`}
        taskId={block.taskId}
        status={status}
        header={
          <SubTaskHeader
            description={startPart?.description}
            taskType={startPart?.taskType}
            subagentType={startPart?.subagentType}
            childCount={visibleChildren.length}
            status={status}
            // pipeline 阶段卡（coding 页执行 Tab 的 计划生成/代码实现 等）不挂 Agent 标签，
            // 该标签仅用于常规委派子 Agent 的渲染数据。
            showAgentTag={!startPart?.isStage}
          />
        }
      >
        <SubTaskProgressSummary aggregate={aggregate} running={status === 'running'} />
        {entries.map((e) => e.node)}
        <SubTaskResultBlock output={absorbed?.output} isError={absorbed?.isError} />
      </SubTaskGroup>
    )
  }

  // 计划模式：将文本 parts 累积并渲染为 PlanCard（显示"计划生成中..."）
  if (isPlanMode) {
    const textContent = mergedParts
      .filter((p): p is Extract<DriverPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('')
    if (textContent.trim()) {
      // 对话已结束但计划仍在生成中 → 标记为已取消
      const planStatus = !isStreaming ? ('cancelled' as const) : ('executing' as const)
      return (
        <PlanCard
          plan={{
            id: 'generating',
            chatId: '',
            createdAt: new Date().toISOString(),
            status: planStatus,
            content: textContent,
            filePath: ''
          }}
          onExecute={onExecutePlan}
          disabled={true}
        />
      )
    }
  }

  return <>{blocks.map((block, index) => renderBlock(block, index))}</>
}
