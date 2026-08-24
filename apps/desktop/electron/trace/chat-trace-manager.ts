/**
 * 对话回合 trace 管理器：回合 begin/end + 辅助 LLM 调用 join。
 *
 * - 一个对话 = 一个 Trace，跨回合重开续接（seq 水位、历史根复用、摘要累计）
 * - turnKey（`${chatId}:${seq}`）隔离各回合的阶段容器
 * - 阶段容器（keyword / chat / memory）与任务路径同构
 */
import type { AgentSpan } from '@task-pipeline/core'
import type { ChatTraceManager, ChatStagePhase } from '../chat/chat-service.js'
import type { ChatDriverId, McpServiceId } from '../chat/chat-types.js'
import type { TracePipeline } from './bus/trace-pipeline.js'

// ── 状态 ─────────────────────────────────────────────────────────────────────

/** chatId → 对话回合 traceId（对话级：一个对话 = 一个 Trace，跨回合重开续接）。 */
const chatTurnTraceIds = new Map<string, string>()
/** chatId → 回合隔离序号（beginTurn 递增，endTurn 据此判断自己是否仍是最新回合）。 */
const chatTurnSeq = new Map<string, number>()
/** turnKey（`${chatId}:${seq}`）→ 当前阶段容器 agent.run span（endStage 收尾）。 */
const chatStageSpans = new Map<string, AgentSpan>()
/** chatId → 本回合 driver source（阶段容器 meta.source 用，与任务路径阶段同构）。 */
const chatStageSources = new Map<string, 'qoder' | 'openai'>()
/** 对话阶段 phase → 阶段名（与 stage-label 的 agentStageLabel 映射保持一致）。 */
const chatStageNames: Record<'keyword' | 'chat' | 'memory', string> = {
  keyword: '关键词提取并注入',
  chat: '对话生成',
  memory: '记忆整理'
}

// ── 初始化 ───────────────────────────────────────────────────────────────────

let tracePipeline: TracePipeline

export function initChatTraceManager(pipeline: TracePipeline): void {
  tracePipeline = pipeline
}

// ── ChatTraceManager 实现 ────────────────────────────────────────────────────

export const chatTraceManager: ChatTraceManager = {
  beginTurn(
    chatId: string,
    _messageId: string,
    text: string,
    driverId: ChatDriverId,
    model: string,
    extras?: { mcpServices?: McpServiceId[]; agentId?: string }
  ) {
    // 对话级 trace：同一对话的所有回合共用一个 traceId。回合之间靠 beginTrace 的
    // 「重开恢复」机制续接（seq 水位、历史根复用、摘要累计），一个 Trace 里显示多条
    // 「对话生成」记录，而不是每回合一条孤立 trace。跨模型切换（qoder/openai）也
    // 续接同一 trace，只更新 source/agentName 归属。
    // turnKey 是回合隔离令牌（per-chat 递增序号）：endTurn / 阶段容器按它识别
    // 「自己回合」，被新回合接管（连发/打断）时不会误关新回合的 trace 或误收其阶段。
    const traceId = `chat-${chatId}`
    const seq = (chatTurnSeq.get(chatId) ?? 0) + 1
    chatTurnSeq.set(chatId, seq)
    const turnKey = `${chatId}:${seq}`
    tracePipeline.ensureActive({
      traceId,
      kind: 'chat',
      title: text.slice(0, 80),
      source: driverId === 'qoder' ? 'qoder' : 'openai',
      agentName: driverId === 'qoder' ? 'Qoder' : 'OpenAI',
      model
    })
    // ensureRootSpan：重开回合复用历史 session.start 根，执行树跨回合不断裂。
    // 本回合 MCP / Agent 选择态写入根 meta（PayloadInspector 按 meta 展示，自然可见）。
    tracePipeline.ensureRootSpan(traceId, {
      type: 'session.start',
      name: '对话',
      meta: {
        source: driverId,
        ...(extras?.mcpServices?.length ? { mcpServices: extras.mcpServices } : {}),
        ...(extras?.agentId ? { agentId: extras.agentId } : {})
      }
    })
    chatTurnTraceIds.set(chatId, traceId)
    chatStageSources.set(chatId, driverId === 'qoder' ? 'qoder' : 'openai')
    return { traceId, turnKey }
  },
  endTurn(chatId: string, turnKey?: string) {
    if (!turnKey) return
    // 只收尾自己回合的阶段容器（stage 按 turnKey 隔离，不误收新回合的）。
    const stage = chatStageSpans.get(turnKey)
    if (stage) {
      chatStageSpans.delete(turnKey)
      try {
        tracePipeline.endSpan(stage.traceId, stage)
      } catch {
        /* trace 已结束时忽略 */
      }
    }
    // 仅当自己仍是该对话的当前回合（序号最新）才 endTrace：被新回合接管（连发/打断）时，
    // 对话级 trace 由最新回合的 endTurn 统一 finalize —— 数据不丢、不被提前截断。
    const mySeq = Number(turnKey.slice(turnKey.lastIndexOf(':') + 1))
    if (chatTurnSeq.get(chatId) === mySeq) {
      const traceId = chatTurnTraceIds.get(chatId)
      if (traceId) {
        tracePipeline.endTrace(traceId)
        chatTurnTraceIds.delete(chatId)
        chatStageSources.delete(chatId)
      }
    }
  },
  traceIdForChat(chatId: string) {
    return chatTurnTraceIds.get(chatId)
  },
  beginStage(chatId: string, phase: ChatStagePhase, turnKey: string) {
    const traceId = chatTurnTraceIds.get(chatId)
    if (!turnKey || !traceId || !tracePipeline.isActive(traceId)) return
    // 与任务路径阶段容器同构：agent.run + meta.phase，期间的 span 按栈自动挂入。
    const span = tracePipeline.startSpan(traceId, {
      type: 'agent.run',
      name: chatStageNames[phase as 'keyword' | 'chat' | 'memory'],
      meta: { source: chatStageSources.get(chatId) ?? 'openai', phase }
    })
    chatStageSpans.set(turnKey, span)
  },
  endStage(chatId: string, turnKey: string, status?: 'completed' | 'error') {
    const span = turnKey ? chatStageSpans.get(turnKey) : undefined
    if (turnKey) chatStageSpans.delete(turnKey)
    if (!turnKey || !span || !tracePipeline.isActive(span.traceId)) return
    tracePipeline.endSpan(
      span.traceId,
      span,
      status === 'error' ? { status: 'error', error: { message: '阶段执行失败' } } : undefined
    )
  }
}
