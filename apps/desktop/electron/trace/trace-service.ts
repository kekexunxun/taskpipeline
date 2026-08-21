/**
 * TraceService v2 —— 新 trace 管道查询服务。
 *
 * 数据来源：JsonlTraceStorage（dataDir/traces/events + info），由埋点层/Bus 写入，
 * 本服务只读。列表页读 info/*.json 摘要（仪表盘聚合），详情读 events/*.jsonl 合并 span 快照。
 */

import type { AgentEvent, AgentSpan, TraceDashboardStats, TraceStorage, TraceSummary } from '@task-pipeline/core'
import { JsonlTraceStorage, agentStageLabel, buildSpanOwnershipIndex, ownerSubtaskOf } from '@task-pipeline/core'

export class TraceService {
  private readonly storage: TraceStorage

  constructor(dataDir: string) {
    this.storage = new JsonlTraceStorage(dataDir)
  }

  /** 列表 + 仪表盘统计（trace:list）。 */
  async listSummaries(): Promise<TraceSummary[]> {
    return this.storage.listTraces()
  }

  /** 仪表盘聚合统计（今日请求数 / 平均耗时 / 总成本）。 */
  async dashboardStats(): Promise<TraceDashboardStats> {
    return this.storage.dashboardStats()
  }

  /** 单条 trace 详情：span 树（按 sequence 排序，parentSpanId 挂载）。 */
  async getTrace(traceId: string): Promise<AgentSpan[] | undefined> {
    return this.storage.getTrace(traceId)
  }

  /** 删除一条 trace（info 摘要 + events 原始文件，不可恢复）。 */
  async deleteTrace(traceId: string): Promise<boolean> {
    return this.storage.deleteTrace(traceId)
  }

  /** 看板执行 Tab 数据源：任务 trace span 树 → AgentEvent 列表（events 表已废弃）。 */
  async getTaskEvents(taskId: string): Promise<AgentEvent[]> {
    const spans = await this.storage.getTrace(taskId)
    return spans ? spansToAgentEvents(spans) : []
  }
}

/**
 * 任务执行 span 树 → AgentEvent 列表（适配看板 Timeline / SubTaskGroup 的既有渲染结构）。
 * - 根 span（task.run/session.start）不产事件：它只是执行树锚点，阶段链由 agent.run 容器承载；
 * - tool.execute → use/result 两条（Timeline 按 toolUseId 配对合并成一行）；
 * - subtask.run → status 事件，payload 带 subtaskId/parentTaskId/sdkSubtype（子任务折叠）；
 * - llm.generate → message 事件（标题用 meta.traceLabel 语义名，否则「LLM 调用 · 模型名」）；
 * - error span → error 事件。
 * 所有事件的 payload 带 spanId 标记：Timeline 的 5 秒内容去重对 span 来源事件豁免
 * （相邻纯 thinking 等内容相同的记录是不同执行步骤，去重会误吞）。
 */
export function spansToAgentEvents(spans: AgentSpan[]): AgentEvent[] {
  const events: AgentEvent[] = []
  // spanId → 所属 subtaskId（subtask 树内的 span 都要打上 parentTaskId 才能被 SubTaskGroup 分组）。
  const subtaskOf = new Map<string, string>()
  // spanId → 所属 agent.run 阶段 id（planning/implementing 等阶段的内部步骤折叠成一张阶段卡，
  // 跟「关键词提取 → Plan → Exec」的阶段划分对齐，不再平铺在主流程里）。
  const stageOf = new Map<string, string>()
  // 归属重定向索引（与 Waterfall 共用同一套规则）：新数据按 meta.parentToolUseId 链解析
  // 子代理内部 span 的真实归属（task_started 滞后时 parentSpanId 只是当时锚点），
  // 旧数据由 parentSpanId 走查兼容。
  const ownership = buildSpanOwnershipIndex(spans)
  const byId = ownership.byId
  for (const span of spans) {
    if (span.type === 'subtask.run') {
      const subtaskId = typeof span.meta?.taskId === 'string' ? span.meta.taskId : span.spanId
      subtaskOf.set(span.spanId, subtaskId)
    } else if (span.type === 'agent.run') {
      stageOf.set(span.spanId, span.spanId)
    }
  }
  // 优先归入子任务（归属重定向：meta.parentToolUseId 链 + 旧数据 parentSpanId 走查），
  // 否则归入最近的 agent.run 阶段；都没有则平铺主流程。
  const resolveGroup = (span: AgentSpan): string | undefined => {
    const owner = ownerSubtaskOf(span, ownership)
    if (owner) return subtaskOf.get(owner.spanId) ?? owner.spanId
    let cur = span.parentSpanId
    let guard = 0
    while (cur && guard++ < 64) {
      const stage = stageOf.get(cur)
      if (stage) return stage
      cur = byId.get(cur)?.parentSpanId
    }
    return undefined
  }
  // 子任务自身的阶段归属：沿 parent 链找最近的 agent.run（用于把子任务组嵌套进阶段卡）。
  const resolveStageId = (span: AgentSpan): string | undefined => {
    let cur = span.parentSpanId
    let guard = 0
    while (cur && guard++ < 64) {
      const stage = stageOf.get(cur)
      if (stage) return stage
      cur = byId.get(cur)?.parentSpanId
    }
    return undefined
  }

  for (const span of spans) {
    const base = {
      id: span.spanId,
      taskId: span.traceId,
      createdAt: span.createdAt
    }
    const parentTaskId = resolveGroup(span)
    const meta = (span.meta ?? {}) as Record<string, unknown>
    // spanId 标记：Timeline 的 5 秒内容去重对 span 来源事件豁免（遗留事件无此标记，仍按内容去重）。
    const spanRef = { spanId: span.spanId }
    switch (span.type) {
      case 'llm.generate': {
        // Qoder llm span 的 output 可能是 { thinking, text } 对象：thinking 是模型内部推理，
        // 不算主流程数据，拆到 payload.thinking 由前端折叠标注；主文本进 detail。
        const outputObj =
          span.output && typeof span.output === 'object' && !Array.isArray(span.output)
            ? (span.output as Record<string, unknown>)
            : undefined
        const thinking = typeof outputObj?.thinking === 'string' && outputObj.thinking ? outputObj.thinking : undefined
        const text =
          typeof outputObj?.text === 'string' && outputObj.text
            ? outputObj.text
            : typeof span.output === 'string' && span.output
              ? span.output
              : undefined
        // 语义名优先（关键词提取/记忆整理等辅助调用），否则「LLM 调用 · 模型名」。
        const traceLabel = typeof meta.traceLabel === 'string' && meta.traceLabel ? meta.traceLabel : undefined
        events.push({
          ...base,
          kind: 'message',
          title: traceLabel ?? (span.model ? `LLM 调用 · ${span.model}` : 'LLM 调用'),
          ...(text ? { detail: text } : {}),
          payload: {
            ...spanRef,
            model: span.model,
            usage: span.usage,
            output: span.output,
            input: span.input,
            ...(thinking ? { thinking } : {}),
            ...(parentTaskId ? { parentTaskId } : {})
          }
        })
        break
      }
      case 'tool.execute': {
        const toolUseId = typeof meta.toolCallId === 'string' ? meta.toolCallId : span.spanId
        events.push({
          ...base,
          kind: 'tool',
          title: span.name,
          payload: {
            ...spanRef,
            toolName: span.name,
            toolUseId,
            phase: 'use' as const,
            input: span.input,
            ...(parentTaskId ? { parentTaskId } : {})
          }
        })
        events.push({
          ...base,
          id: `${span.spanId}-r`,
          kind: 'tool',
          title: span.name,
          payload: {
            ...spanRef,
            toolName: span.name,
            toolUseId,
            phase: 'result' as const,
            output: span.output,
            ...(span.status === 'error' ? { isError: true } : {}),
            ...(parentTaskId ? { parentTaskId } : {})
          }
        })
        break
      }
      case 'subtask.run': {
        // 阶段归属：阶段容器（agent.run）内发起的子任务带 stageId，
        // 前端 interleaveTimeline 据此把该子任务组嵌套进阶段卡（不再与阶段卡平级）。
        // fallback：resolveStageId 可能因 parent 链异常返回 undefined，
        // 此时用 resolveGroup 的结果——仅当 resolveGroup 指向 stageOf 中的阶段时生效。
        let stageId = resolveStageId(span)
        if (!stageId) {
          const groupId = resolveGroup(span)
          if (groupId && stageOf.has(groupId)) stageId = groupId
        }
        // subtask.run span 的 meta.sdkSubtype 会被 task_progress / task_notification 顺序覆盖，
        // 落盘终值几乎总是 task_notification；若按终值单发事件，前端只会收到「收尾」事件，
        // 丢 task_started header（stageId / toolUseId / 委派时原始标题），子 Agent 卡会被提到
        // 顶层、委派工具行也无法吸收。这里按 SDK 消息语义拆成 start + end 两条事件：
        // - start：sdkSubtype=task_started，description 取 span.name（委派时原始描述，
        //   不被 task_progress 的过程态文本覆盖），携带 toolUseId / stageId，
        //   供前端做组 header、阶段嵌套与委派工具行吸收；
        // - end：span 已收尾时才发，sdkSubtype=task_notification，携带 status / summary 驱动状态徽章。
        const subtaskId = typeof meta.taskId === 'string' ? meta.taskId : span.spanId
        const parentId = typeof meta.parentTaskId === 'string' ? meta.parentTaskId : subtaskId
        events.push({
          ...base,
          kind: 'status',
          title: span.name,
          payload: {
            ...spanRef,
            subtaskId,
            parentTaskId: parentId,
            sdkSubtype: 'task_started',
            description: span.name,
            ...(typeof meta.taskType === 'string' ? { taskType: meta.taskType } : {}),
            ...(typeof meta.subagentType === 'string' ? { subagentType: meta.subagentType } : {}),
            // 委派工具 callId：Timeline 用它把发起调用的工具行吸收进子任务卡（不平级展示）。
            ...(typeof meta.toolUseId === 'string' ? { toolUseId: meta.toolUseId } : {}),
            ...(stageId ? { stageId } : {})
          }
        })
        if (span.status !== 'started' && span.status !== 'running') {
          events.push({
            ...base,
            id: `${span.spanId}-end`,
            // createdAt 取 span 收尾时间（而非 base 的 span.createdAt）：前端按 createdAt 排序，
            // 若用创建时间，end 会紧跟 start，子任务内部事件全部排在「收尾」之后，时序错乱。
            createdAt: typeof span.endedAt === 'number' ? new Date(span.endedAt).toISOString() : base.createdAt,
            kind: 'status',
            title: span.name,
            payload: {
              ...spanRef,
              subtaskId,
              parentTaskId: parentId,
              sdkSubtype: 'task_notification',
              ...(typeof meta.summary === 'string' ? { summary: meta.summary } : {}),
              ...(typeof meta.lastToolName === 'string' ? { lastToolName: meta.lastToolName } : {}),
              ...(stageId ? { stageId } : {}),
              // 与 agent.run 一致的状态映射：error→failed / cancelled→stopped，避免徽章误判「执行中」
              status: span.status === 'error' ? 'failed' : span.status === 'cancelled' ? 'stopped' : span.status
            }
          })
        }
        break
      }
      case 'agent.run':
        // 阶段容器：自身事件作 header（parentTaskId/subtaskId 自指，interleaveTimeline 据此折叠成卡），
        // 阶段内步骤（llm/tool，无 subtask 祖先时）已由 resolveGroup 打上 parentTaskId。
        // sdkSubtype=task_started 让前端走标准 subtask-start 路径（携带阶段标记字段）；
        // stage 标记告知渲染层这是 pipeline 阶段卡（非委派子 Agent），不挂 Agent 标签；
        // description 取阶段显示名（与 Trace 瀑布图共用 agentStageLabel 映射，如 计划生成/代码审查），
        // 不回退 span 原始名（Agent planning 等英文）；
        // error 状态映射成 failed，让卡片状态徽章显示「失败」而非误判「执行中」。
        events.push({
          ...base,
          kind: 'status',
          title: span.name,
          payload: {
            ...spanRef,
            subtaskId: span.spanId,
            parentTaskId: span.spanId,
            sdkSubtype: 'task_started',
            stage: true,
            status: span.status === 'error' ? 'failed' : span.status,
            description: agentStageLabel(span) ?? span.name,
            ...(typeof meta.phase === 'string' && meta.phase ? { taskType: meta.phase } : {})
          }
        })
        break
      case 'task.run':
      case 'session.start':
        // 根 span 不产事件：它只是执行树锚点，阶段链由 agent.run 容器承载，
        // 根事件会把整条时间线压进一个无谓的顶层分组。
        break
      default:
        events.push({ ...base, kind: 'status', title: span.name, payload: { ...spanRef } })
        break
    }
    if (span.status === 'error' && span.type !== 'tool.execute') {
      events.push({
        ...base,
        id: `${span.spanId}-err`,
        kind: 'error',
        title: '执行错误',
        detail: span.error?.message ?? 'span 执行失败',
        payload: { ...spanRef }
      })
    }
  }
  return events
}
