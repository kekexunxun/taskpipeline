/**
 * Qoder Chat Driver — ChatDriver 的 Qoder SDK 实现(常驻会话引擎版)。
 *
 * 职责(全部封在本文件内):
 *  - listModels: 通过 getQoderStatus 回调拿到 Qoder runtime 的可用模型;
 *  - streamChat: 每个 conversationId 常驻一个 `QoderSession`(见 ../../qoder/qoder-session.ts),
 *    一次 `streamChat` 调用 = 一个回合:用户消息经异步消息流送入同一会话,
 *    输出(part / task-created)实时转发,`result` 收尾 —— 官方多轮对话语义,不再拼历史;
 *  - 会话控制作为底层能力:首次创建;历史末尾有 `qoder.session` 时自动 `resume`(应用重启后
 *    打开历史对话可恢复上下文);`abort → interrupt`(停止当前回复、保留会话);
 *    `closeSession` 删除对话时调用;`dispose` 应用退出统一关闭;
 *  - 工具注入:把 `ToolSource` 翻译成 Qoder MCP server(共用 `./tool-source-mcp.ts`);
 *  - 任务已创建:每次 tool 执行后调 `ToolSource.describeResult(output)`,有结果就 emit
 *    `{ type: "task-created", result }` chunk;
 *  - 持久化:raw 字段存 SDK 自己的"原样"消息列表(由 driver 内部累积,流结束一次性 dump)。
 *
 * 上层 (ChatService) 完全不感知 SDK 协议。
 */

import {
  PLANNER_AGENT_NAME,
  PLANNER_DISALLOWED_TOOLS,
  markPlanRequest,
  planDelegationInstruction,
  planModeInstruction,
  planSuggestionGuidance,
  plannerAgentDescription
} from '@task-pipeline/core'
import { type CanUseToolOptions, type McpServerConfig, type PermissionResult } from '@qoder-ai/qoder-agent-sdk'
import type { ChatAttachmentCache } from '../../chat/chat-attachment-cache.js'
import type { ChatDriver, StreamChatInput } from '../../chat/drivers/chat-driver.js'
import type {
  ChatModelInfo,
  ChatStreamChunk,
  ChatUsage,
  DriverPart,
  StoredMessage,
  StoredMessageRecord,
  UserFileAttachment
} from '../../chat/chat-types.js'
import type { McpServiceProfileResolver } from '../../mcp/mcp-services.js'
import type { TracePipeline } from '../../trace/bus/trace-pipeline.js'
import { CODEBASE_SEARCH_STEERING, CODEBASE_SEARCH_SUBAGENT_STEERING } from '../../codeindex/codebase-search-tool.js'
import { MAX_CHAT_STEPS } from '../../chat/chat-step-limit.js'
import { QoderSession, QoderSessionRegistry } from './qoder-session.js'
import { QoderTraceBuilder } from './trace-builder.js'
import { buildToolSourceMcp } from './tool-source-mcp.js'

type QoderStatus = {
  enabled: boolean
  connected: boolean
  running: boolean
  models: Array<
    Pick<ChatModelInfo, 'value' | 'displayName'> & {
      isDefault?: boolean
      isReasoning?: boolean
      isVl?: boolean
      priceFactor?: number
    }
  >
}

type QoderTokenProvider = () => string | undefined

type QoderStatusProvider = () => Promise<QoderStatus>

/**
 * 工具调用 HITL 回调(对话板块)。
 * Qoder CLI 需要用户决策时调用:返回 'allow' 放行 / 'deny' 拒绝(带消息)。
 * AskUserQuestion 返回 { type: 'askUser', answers } —— driver 组装为 SDK 的 allow + updatedInput。
 * 拒绝时返回 { type: 'deny', message } —— driver 使用自定义消息。
 * 缺省不注入时,SDK 遇 `can_use_tool` 控制请求会直接抛错 —— 见 qoder-session 透传。
 */
export type QoderToolPermissionHandlerResult =
  | 'allow'
  | 'deny'
  | { type: 'askUser'; answers: string[] }
  | { type: 'deny'; message: string }
export type QoderToolPermissionHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  options: { signal: AbortSignal; conversationId: string; title?: string; displayName?: string; description?: string }
) => Promise<QoderToolPermissionHandlerResult>

/**
 * Qoder driver 自己的 raw 形态(给存储层用):
 *  - 用户消息: `{ kind: "user", text: string }`;
 *  - 助手消息: `{ kind: "assistant", parts: { type, ... }[], sessionId?: string }` —— parts 与
 *    DriverPart 完全一致,driver 加载时直接透传;
 *  - 系统消息: `{ kind: "system", text: string }` (memory context 等)。
 */
type QoderRawMessage =
  | { kind: 'user'; text: string; files?: UserFileAttachment[] }
  | { kind: 'assistant'; parts: DriverPart[]; sessionId?: string }
  | { kind: 'system'; text: string }

function emptyParts(): DriverPart[] {
  return []
}

function rawToParts(raw: unknown): DriverPart[] {
  if (!raw || typeof raw !== 'object') return emptyParts()
  const record = raw as QoderRawMessage
  if (record.kind === 'user') {
    const parts: DriverPart[] = [{ driverId: 'qoder', type: 'text', text: record.text }]
    if (record.files?.length) {
      for (const file of record.files) {
        parts.push({
          driverId: 'qoder',
          type: 'file',
          mediaType: file.mediaType,
          localPath: file.localPath,
          filename: file.filename
        })
      }
    }
    return parts
  }
  if (record.kind === 'system') return [{ driverId: 'qoder', type: 'text', text: record.text }]
  if (record.kind === 'assistant' && Array.isArray(record.parts)) return record.parts
  return emptyParts()
}

/** 从历史末尾倒序找最后一个 `qoder.session` part(恢复会话的锚点)。 */
function extractLastSessionId(history: StoredMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]
    if (!message || message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (part.type === 'qoder.session' && part.sessionId) return part.sessionId
    }
  }
  return undefined
}

/**
 * Qoder Chat Driver(常驻会话版)。
 */
export class QoderChatDriver implements ChatDriver {
  readonly id = 'qoder' as const
  readonly displayName = 'Qoder Agent SDK'

  private readonly sessions = new QoderSessionRegistry()

  /** conversationId → 对话 trace builder（一次用户提问 = 一个 trace）。 */
  private readonly traceBuilders = new Map<string, QoderTraceBuilder>()

  /** conversationId → 常驻会话创建时的 MCP 选择指纹（选择变化时重建会话使注入生效）。 */
  private readonly sessionMcpKeys = new Map<string, string>()

  constructor(
    private readonly tokenProvider: QoderTokenProvider,
    private readonly statusProvider: QoderStatusProvider,
    /** 埋点管线：对话路径 span 采集（可选，缺省不采集）。 */
    private readonly tracePipeline?: TracePipeline,
    /** 用户勾选的 MCP 服务 → stdio 配置（缺省 = 不注入外部 MCP）。 */
    private readonly mcpProfileResolver?: McpServiceProfileResolver,
    /** 工具调用 HITL：需要用户决策时回调（缺省 = 不注入，SDK 遇 can_use_tool 会抛错）。 */
    private readonly onToolPermission?: QoderToolPermissionHandler,
    /**
     * Skill 配置根（dataDir，其下有 skills/<name>/SKILL.md）。
     * 选中技能时透传 SDK `skills` 并切 QODER_CONFIG_DIR 让 CLI 从该目录发现技能（实测定案，见计划 §4.2）。
     */
    private readonly skillsConfigRoot?: string,
    /** 附件缓存（用于读取本地文件内容，构建多模态消息）。 */
    private readonly attachmentCache?: ChatAttachmentCache
  ) {
    if (!tokenProvider) throw new Error('QoderChatDriver requires a token provider')
    if (!statusProvider) throw new Error('QoderChatDriver requires a status provider')
  }

  async listModels(): Promise<ChatModelInfo[]> {
    try {
      const status = await this.statusProvider()
      if (!status.enabled || !status.connected) return []
      return status.models.map((model) => ({
        value: `qoder:${model.value}`,
        displayName: model.displayName,
        isDefault: model.isDefault,
        isReasoning: model.isReasoning,
        isVl: model.isVl,
        priceFactor: model.priceFactor
      }))
    } catch {
      return []
    }
  }

  serializeUserMessage(input: {
    id: string
    text: string
    createdAt: string
    files?: UserFileAttachment[]
  }): StoredMessageRecord {
    return {
      id: input.id,
      role: 'user',
      createdAt: input.createdAt,
      driverId: 'qoder',
      raw: {
        kind: 'user',
        text: input.text,
        ...(input.files?.length ? { files: input.files } : {})
      } satisfies QoderRawMessage
    }
  }

  serializeAssistantMessage(input: {
    id: string
    parts: DriverPart[]
    createdAt: string
    sessionId?: string
    usage?: ChatUsage
  }): StoredMessageRecord {
    return {
      id: input.id,
      role: 'assistant',
      createdAt: input.createdAt,
      driverId: 'qoder',
      raw: {
        kind: 'assistant',
        parts: input.parts,
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      } satisfies QoderRawMessage,
      ...(input.usage ? { usage: input.usage } : {})
    }
  }

  deserializeMessage(record: StoredMessageRecord): StoredMessage {
    return { ...record, parts: rawToParts(record.raw) }
  }

  async *streamChat(input: StreamChatInput): AsyncGenerator<ChatStreamChunk> {
    const token = this.tokenProvider()
    if (!token) throw new Error('请先在设置中配置 Qoder Token')

    // 对话 trace：对话级 traceId（一个对话 = 一个 Trace）。主对话由 ChatService 传 traceId（join），
    // 辅助 LLM 调用也 join 同一回合；无 traceId 时自建独立 trace。
    const traceId = input.traceId ?? `chat-${input.conversationId}-${input.userInput.id}`
    const join = Boolean(input.traceId)

    // 常驻会话:已存在则复用(多轮上下文由会话提供);不存在则创建 ——
    // 历史末尾有 qoder.session 时自动 resume(底层能力,应用重启后上下文不丢)。
    // mcpServers 在会话创建时固化:本轮 MCP 选择与会话创建时不一致则关闭重建
    // (上下文经 resume 恢复),保证勾选变化真正生效。
    // chatMode 不在此列:规划靠逐轮打委派标记(PLAN_REQUEST_MARK),子代理定义又与会话
    // 同生命周期,所以模式切换不需要重建会话。
    const mcpKey = [...(input.mcpServices ?? [])].sort().join(',')
    let session = this.sessions.get(input.conversationId)
    if (session && this.sessionMcpKeys.get(input.conversationId) !== mcpKey) {
      this.closeSession(input.conversationId)
      session = undefined
    }
    if (!session) {
      // 可变引用:buildSessionOptions 先于 session 创建执行,canUseTool 通过 ref 延迟访问 session。
      const sessionRef: { current: QoderSession | undefined } = { current: undefined }
      session = this.sessions.register(
        input.conversationId,
        new QoderSession(input.conversationId, this.buildSessionOptions(input, token, traceId, sessionRef))
      )
      sessionRef.current = session
      this.sessionMcpKeys.set(input.conversationId, mcpKey)
    }

    const model = input.model.startsWith('qoder:') ? input.model.slice(6) : input.model
    // 本回合的 trace builder：闭包引用 + 注册到 map（onMessage 按 key 反查）。
    // 对话级 traceId 下多回合共享同一 key —— 回合被新回合接管（连发/打断）时 map 会被覆盖，
    // 收尾必须只 finish/delete 自己的 builder，不能误伤新回合的（否则新回合采集全空）。
    // 辅助回合（记忆整理/关键词提取，带 traceLabel）用独立 key，避免与主回合 builder
    // 互相覆盖（辅助调用是独立 session + 一次性，onMessage 闭包捕获同一 aux key）。
    const builderKey = input.traceLabel ? `aux:${traceId}` : traceId
    let traceBuilder: QoderTraceBuilder | undefined
    if (this.tracePipeline) {
      if (join) {
        this.tracePipeline.ensureActive({
          traceId,
          kind: 'chat',
          title: input.userInput.text.slice(0, 80),
          source: 'qoder',
          agentName: 'Qoder',
          model
        })
      } else {
        this.tracePipeline.beginTrace({
          traceId,
          kind: 'chat',
          title: input.userInput.text.slice(0, 80),
          source: 'qoder',
          agentName: 'Qoder',
          model
        })
        this.tracePipeline.startSpan(traceId, { type: 'session.start', name: '对话', meta: { source: 'qoder' } })
      }
      // 辅助调用（关键词提取/记忆整理）传入 traceLabel 作 llm span 语义名。
      traceBuilder = new QoderTraceBuilder(this.tracePipeline, traceId, 'chat', 'qoder', model, input.traceLabel)
      // 本回合用户输入：SDK 不一定回显 user 文本消息，尤其一次性辅助会话——
      // 关键词提取/记忆整理的 span 此前因此看不到 Prompt。
      traceBuilder.setTurnInput(input.userInput.text)
      this.traceBuilders.set(builderKey, traceBuilder)
    }

    // 一个回合:消息入队 → 实时转发输出 → result / error / abort 收尾。
    // 计划模式：只给本轮消息打委派标记，让主会话把规划工作交给 planner 子代理；
    // 主会话的权限、工具集、系统提示一概不变 —— 后续「执行计划」的轮次不会被限权。
    const isPlanTurn = (input.chatMode ?? 'normal') === 'plan'
    try {
      for await (const chunk of session.turn({
        text: isPlanTurn ? markPlanRequest(input.userInput.text) : input.userInput.text,
        files: input.userInput.files,
        attachmentCache: this.attachmentCache,
        toolSource: input.toolSource,
        signal: input.signal
      })) {
        yield chunk
      }
    } catch (error) {
      // 回合失败说明会话状态可能已损坏(消费循环已结束),关闭它,下次自动重建全新会话。
      this.closeSession(input.conversationId)
      traceBuilder?.finish({
        status: 'error',
        error: { message: error instanceof Error ? error.message : String(error) }
      })
      if (this.traceBuilders.get(builderKey) === traceBuilder) this.traceBuilders.delete(builderKey)
      throw error
    } finally {
      if (this.tracePipeline) {
        traceBuilder?.finish()
        // 只清理自己的 builder：map 里已是新回合的 builder 时（并发接管）不误删。
        if (this.traceBuilders.get(builderKey) === traceBuilder) this.traceBuilders.delete(builderKey)
        // join 模式：trace 生命周期由回合层（ChatService）统一 endTrace。
        if (!join) this.tracePipeline.endTrace(traceId)
      }
    }
    if (!input.signal.aborted) {
      // Qoder 不回填绝对 token，只有 context_usage_ratio（上下文占比）与 credits（成本）：
      // 用这两个口径作为本回合用量，交给 ChatService 落盘 + 透传前端展示。
      const turnUsage = session.getTurnUsage()
      const usage: ChatUsage | undefined =
        turnUsage.contextUsageRatio !== undefined || turnUsage.credits !== undefined
          ? {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              ...(turnUsage.contextUsageRatio !== undefined ? { contextUsageRatio: turnUsage.contextUsageRatio } : {}),
              ...(turnUsage.credits !== undefined ? { credits: turnUsage.credits } : {})
            }
          : undefined
      yield { type: 'done', status: 'done', ...(usage ? { usage } : {}) }
    }
  }

  closeSession(conversationId: string): void {
    this.sessionMcpKeys.delete(conversationId)
    void this.sessions.close(conversationId)
  }

  injectGuidance(conversationId: string, text: string): void {
    const session = this.sessions.get(conversationId)
    session?.injectGuidance(text)
  }

  dispose(): void {
    void this.sessions.dispose()
  }

  private buildSessionOptions(
    input: StreamChatInput,
    token: string,
    traceId?: string,
    sessionRef?: { current: QoderSession | undefined }
  ) {
    const resumeSessionId = extractLastSessionId(input.history)
    const taskSource = input.toolSource
    const mcpSetup = taskSource ? buildToolSourceMcp('task_creation', taskSource.tools()) : undefined
    // 记忆检索工具（search_memory）：与 task_creation 并列、各自一个 MCP server,互不冲突。
    const memoryMcp = input.memoryTools?.length ? buildToolSourceMcp('memory_search', input.memoryTools) : undefined
    // 用户勾选的外部 MCP 服务（gitlab/jira/confluence）→ SDK stdio mcpServers，
    // 凭据缺失的服务由 resolver 返回 undefined 直接跳过（不误注入空配置）。
    const mcpServers: Record<string, McpServerConfig> = {}
    if (taskSource && mcpSetup) mcpServers.task_creation = mcpSetup.server
    if (memoryMcp) mcpServers.memory_search = memoryMcp.server
    for (const serviceId of input.mcpServices ?? []) {
      const profile = this.mcpProfileResolver?.(serviceId)
      if (!profile || profile.transport !== 'stdio' || !profile.command) continue
      mcpServers[serviceId] = {
        type: 'stdio',
        command: profile.command,
        ...(profile.args?.length ? { args: profile.args } : {}),
        ...(profile.env && Object.keys(profile.env).length ? { env: profile.env } : {})
      }
    }
    const serverNames = Object.keys(mcpServers)
    // 构建系统提示：任务指令 + 工作区上下文（project_instructions + agents_instructions）
    // Qoder SDK 内部管理会话历史，不会处理 history 中的 system 消息，需显式注入。
    const systemParts: string[] = []
    if (taskSource?.systemPrompt()) {
      systemParts.push(taskSource.systemPrompt())
    }
    if (input.workspaceContext) {
      systemParts.push(input.workspaceContext)
    }
    const baseSystemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
    // 计划模式不再拼进主会话系统提示：常驻会话的 systemPrompt 在创建时冻结，逐轮改模式
    // 本就无效（旧实现的隐藏 bug）。改为：常驻「委派规则」+「复杂度自检建议」，
    // 规划轮次只逐轮给消息打委派标记；真正的 planner 角色提示只给子代理（见 agents）。
    const systemPromptParts = [
      ...(baseSystemPrompt ? [baseSystemPrompt] : []),
      planDelegationInstruction(),
      planSuggestionGuidance()
    ]
    // 检索类工具使用指引（静态、恒在,不依赖检索结果）：与 OpenAI 链路保持一致的提示。
    if (memoryMcp) {
      const toolNames = new Set((input.memoryTools ?? []).map((t) => t.name))
      if (toolNames.has('search_memory')) {
        systemPromptParts.push(
          '当问题涉及工程约定、编码规范、历史决策或仓库文档（repowiki）时,先调用 search_memory 工具检索相关记忆再作答,不要凭空假设项目约定。'
        )
      }
      if (toolNames.has('codebase_search')) {
        systemPromptParts.push(CODEBASE_SEARCH_STEERING)
        // 子代理看不到 codebase_search：额外要求主会话先自己取锚点再委派，避免整包甩给 Explore 退回 grep。
        systemPromptParts.push(CODEBASE_SEARCH_SUBAGENT_STEERING)
      }
    }
    const systemPrompt = systemPromptParts.join('\n\n')
    return {
      token,
      cwd: input.cwd ?? process.cwd(),
      model: input.model.startsWith('qoder:') ? input.model.slice(6) : input.model,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      // 主会话常驻 default：不用 SDK 的 permissionMode:'plan'（那是 Coding 场景的主线计划态，
      // 会期望 ExitPlanMode 并反过来限制主线）——计划的只读边界全部下沉到 planner 子代理。
      permissionMode: 'default' as const,
      // planner 子代理（与会话同生命周期注册，不随 chatMode 开关重建）：写类工具在子代理
      // 层面硬禁，主会话不吃任何限制 —— 这是「计划不改主线权限」的实现点。
      agents: {
        [PLANNER_AGENT_NAME]: {
          description: plannerAgentDescription(),
          prompt: planModeInstruction(),
          disallowedTools: [...PLANNER_DISALLOWED_TOOLS],
          permissionMode: 'default' as const
        }
      },
      // HITL 确认需要用户人工决策，不设超时上限（SDK 条件：<=0 则不启动 setTimeout）。
      // 安全兜底两层：前端流看门狗（STREAM_WATCHDOG_MS 无事件 → abort 死流 → flushApprovals 拒绝）
      // 探 IPC 断连；主进程 ChatService 的 driver 静默检测（CHAT_DRIVER_STALL_MS，HITL 在飞期间豁免）
      // 探子进程挂死；另有用户主动停止按钮，应用退出时 pendingUi 统一 resolve cancelled。
      controlRequestTimeoutMs: 0,
      // 对话 trace：SDKMessage 逐条喂给 span 转换器（采集失败不影响主流程）。
      // 主回合与辅助回合（traceLabel 存在）按各自 key 路由，互不覆盖。
      onMessage: (message: unknown) => {
        try {
          const key = input.traceLabel ? `aux:${traceId}` : traceId
          if (key) this.traceBuilders.get(key)?.onMessage(message as never)
        } catch {
          /* 忽略:trace 采集失败不能影响对话 */
        }
      },
      ...(systemPrompt ? { systemPrompt } : {}),
      // allowedTools = 预授权名单（不是能力上限，其余工具仍走 canUseTool HITL）。
      // 始终预授权 `Agent`：委派 planner 子代理不该再弹一层确认框。
      // search_memory 由宿主自己检索、无副作用,同样预授权免弹框。
      allowedTools: ['Agent', ...(mcpSetup?.toolNames ?? []), ...(memoryMcp?.toolNames ?? [])],
      // 挂任务工具的 chat 也要留够主循环步数:与 OpenAI 路径共享 MAX_CHAT_STEPS 口径,
      // 撞线时 SDK 发 result.subtype='error_max_turns',由 qoder-session 补可见提示收尾。
      ...(taskSource && mcpSetup ? { maxTurns: MAX_CHAT_STEPS } : {}),
      ...(serverNames.length
        ? {
            mcpServers,
            allowedMcpServerNames: serverNames
          }
        : {}),
      // 选中的 Skill：SDK `skills` 按 SKILL.md name 映射 Skill(<name>) 工具 + CLI `<available_skills>`
      // 注入；技能根不在 CLI 默认 ~/.qoder 时切 QODER_CONFIG_DIR（实测定案：config root 的 skills/ 即技能根）。
      ...(input.skills?.length && this.skillsConfigRoot
        ? {
            skills: input.skills,
            env: { QODER_CONFIG_DIR: this.skillsConfigRoot }
          }
        : {}),
      // 工具调用 HITL：SDK 的 can_use_tool 控制请求 → 上层弹窗让用户决策(allow 由用户显式确认，不自动放行)。
      ...(this.onToolPermission
        ? {
            canUseTool: async (
              toolName: string,
              toolInput: Record<string, unknown>,
              sdkOpts: CanUseToolOptions
            ): Promise<PermissionResult> => {
              // SDK 侧已中止(超时/会话关闭/用户停止):弹窗前直接拒绝,避免确认框挂到 10 分钟超时。
              // interrupt:true 让 SDK 立即停止当前回合,避免继续生成「用户拒绝」回复导致会话状态混乱。
              if (sdkOpts.signal.aborted) {
                // HITL 拒绝标记:记录 toolUseID,handleToolResult 据此补标 isError。
                sessionRef?.current?.deniedCallIds.add(sdkOpts.toolUseID)
                return { behavior: 'deny', message: '工具调用已中止', interrupt: true }
              }
              const decision = await this.onToolPermission!(toolName, toolInput, {
                signal: sdkOpts.signal,
                conversationId: input.conversationId,
                ...(sdkOpts.title ? { title: sdkOpts.title } : {}),
                ...(sdkOpts.displayName ? { displayName: sdkOpts.displayName } : {}),
                ...(sdkOpts.description ? { description: sdkOpts.description } : {})
              })
              // 等待用户响应期间信号被中止(看门狗超时/用户主动停止):
              // 返回 interrupt:true 让 SDK 立即停止,而非继续生成回复导致会话状态不一致。
              if (sdkOpts.signal.aborted) {
                sessionRef?.current?.deniedCallIds.add(sdkOpts.toolUseID)
                return { behavior: 'deny', message: '工具调用已中止', interrupt: true }
              }
              // AskUserQuestion:用户回答通过 allow + updatedInput 注入(官方 SDK 协议),
              // answers 的 key 是完整的 question 文本,SDK 据此生成正常的 tool_result(非 error)。
              if (typeof decision === 'object' && decision.type === 'askUser') {
                const questions = (toolInput as { questions?: Array<{ question?: string }> }).questions
                const answers: Record<string, string> = {}
                if (Array.isArray(questions)) {
                  questions.forEach((q, i) => {
                    if (q.question && decision.answers[i] !== undefined) {
                      answers[q.question] = decision.answers[i]
                    }
                  })
                }
                return {
                  behavior: 'allow',
                  updatedInput: { questions: questions ?? [], answers }
                }
              }
              if (typeof decision === 'object' && decision.type === 'deny') {
                // 自定义拒绝消息(如 AskUserQuestion 取消)
                sessionRef?.current?.deniedCallIds.add(sdkOpts.toolUseID)
                return { behavior: 'deny', message: decision.message, interrupt: false }
              }
              if (decision === 'deny') {
                // HITL 拒绝标记:记录 toolUseID,handleToolResult 据此补标 isError。
                sessionRef?.current?.deniedCallIds.add(sdkOpts.toolUseID)
                return { behavior: 'deny', message: '用户拒绝了此操作，请改用其他方案', interrupt: false }
              }
              return { behavior: 'allow' }
            }
          }
        : {})
    }
  }
}
