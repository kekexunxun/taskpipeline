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
 *  - 工具注入:把 `ToolSource` 翻译成 Qoder MCP server(`qoderTool + createSdkMcpServer`);
 *  - 任务已创建:每次 tool 执行后调 `ToolSource.describeResult(output)`,有结果就 emit
 *    `{ type: "task-created", result }` chunk;
 *  - 持久化:raw 字段存 SDK 自己的"原样"消息列表(由 driver 内部累积,流结束一次性 dump)。
 *
 * 上层 (ChatService) 完全不感知 SDK 协议。
 */

import type { z } from 'zod'
import {
  createSdkMcpServer,
  tool as qoderTool,
  type CanUseToolOptions,
  type McpServerConfig,
  type PermissionResult,
  type SdkMcpToolDefinition
} from '@qoder-ai/qoder-agent-sdk'
import type { ChatModelInfo, ChatStreamChunk, DriverPart, StoredMessage, StoredMessageRecord } from '../chat-types.js'
import { QoderSession, QoderSessionRegistry } from '../../qoder/qoder-session.js'
import type { TracePipeline } from '../../trace/bus/trace-pipeline.js'
import { QoderTraceBuilder } from '../../trace/instrument/qoder-trace-builder.js'
import type { McpServiceProfileResolver } from '../mcp-services.js'
import type { ChatDriver, StreamChatInput } from './chat-driver.js'
import type { ToolSource } from './tool-source.js'

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
 * 缺省不注入时,SDK 遇 `can_use_tool` 控制请求会直接抛错 —— 见 qoder-session 透传。
 */
export type QoderToolPermissionHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  options: { signal: AbortSignal; conversationId: string; title?: string; displayName?: string; description?: string }
) => Promise<'allow' | 'deny'>

/**
 * Qoder driver 自己的 raw 形态(给存储层用):
 *  - 用户消息: `{ kind: "user", text: string }`;
 *  - 助手消息: `{ kind: "assistant", parts: { type, ... }[], sessionId?: string }` —— parts 与
 *    DriverPart 完全一致,driver 加载时直接透传;
 *  - 系统消息: `{ kind: "system", text: string }` (memory context 等)。
 */
type QoderRawMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; parts: DriverPart[]; sessionId?: string }
  | { kind: 'system'; text: string }

function emptyParts(): DriverPart[] {
  return []
}

function rawToParts(raw: unknown): DriverPart[] {
  if (!raw || typeof raw !== 'object') return emptyParts()
  const record = raw as QoderRawMessage
  if (record.kind === 'user' || record.kind === 'system')
    return [{ driverId: 'qoder', type: 'text', text: record.text }]
  if (record.kind === 'assistant' && Array.isArray(record.parts)) return record.parts
  return emptyParts()
}

/**
 * 把 ToolDeclaration[] 翻译成 Qoder MCP server。
 *  - `qoderTool(name, description, shape, execute, opts)` 直接吃单层 zod 字段;
 *  - `permissionPolicy: "always_allow"` 让工具不被 Qoder 权限检查拦截(任务创建工具不在 CLI 上下文内);
 *  - `modelToolResult` 把 execute 结果包成 MCP 标准 `CallToolResult` 形态。
 */
function buildTaskCreationMcp(source: ToolSource): {
  server: ReturnType<typeof createSdkMcpServer>
  toolNames: string[]
} {
  const declarations = source.tools()
  if (declarations.length === 0) {
    return { server: createSdkMcpServer({ name: 'task-creation', version: '1.0.0', tools: [] }), toolNames: [] }
  }
  const tools: SdkMcpToolDefinition<any>[] = declarations.map((decl) => {
    const annotations = decl.annotations ?? {}
    const mcpAnnotations: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } = {}
    if (annotations.readOnlyHint) mcpAnnotations.readOnlyHint = true
    if (annotations.destructiveHint) mcpAnnotations.destructiveHint = true
    if (annotations.openWorldHint) mcpAnnotations.openWorldHint = true
    return qoderTool(
      decl.name,
      decl.description,
      decl.schema as Record<string, z.ZodTypeAny>,
      async (input: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(await decl.execute(input)) }]
      }),
      { annotations: mcpAnnotations, permissionPolicy: 'always_allow' }
    )
  })
  return {
    server: createSdkMcpServer({ name: 'task-creation', version: '1.0.0', tools }),
    toolNames: declarations.map((decl) => `mcp__task_creation__${decl.name}`)
  }
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
    private readonly skillsConfigRoot?: string
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

  serializeUserMessage(input: { id: string; text: string; createdAt: string }): StoredMessageRecord {
    return {
      id: input.id,
      role: 'user',
      createdAt: input.createdAt,
      driverId: 'qoder',
      raw: { kind: 'user', text: input.text } satisfies QoderRawMessage
    }
  }

  serializeAssistantMessage(input: {
    id: string
    parts: DriverPart[]
    createdAt: string
    sessionId?: string
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
      } satisfies QoderRawMessage
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
    const mcpKey = [...(input.mcpServices ?? [])].sort().join(',')
    let session = this.sessions.get(input.conversationId)
    if (session && this.sessionMcpKeys.get(input.conversationId) !== mcpKey) {
      this.closeSession(input.conversationId)
      session = undefined
    }
    if (!session) {
      session = this.sessions.register(
        input.conversationId,
        new QoderSession(input.conversationId, this.buildSessionOptions(input, token, traceId))
      )
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
      // 本回合发送给模型的用户输入：作首个 llm span 的 input（SDK 不一定回显 user 文本消息，
      // 尤其一次性辅助会话——关键词提取/记忆整理的 span 此前因此看不到 Prompt）。
      traceBuilder.setTurnInput(input.userInput.text)
      this.traceBuilders.set(builderKey, traceBuilder)
    }

    // 一个回合:消息入队 → 实时转发输出 → result / error / abort 收尾。
    try {
      for await (const chunk of session.turn({
        text: input.userInput.text,
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
      yield { type: 'done', status: 'done' }
    }
  }

  closeSession(conversationId: string): void {
    this.sessionMcpKeys.delete(conversationId)
    void this.sessions.close(conversationId)
  }

  dispose(): void {
    void this.sessions.dispose()
  }

  private buildSessionOptions(input: StreamChatInput, token: string, traceId?: string) {
    const resumeSessionId = extractLastSessionId(input.history)
    const taskSource = input.toolSource
    const mcpSetup = taskSource ? buildTaskCreationMcp(taskSource) : undefined
    // 用户勾选的外部 MCP 服务（gitlab/jira/confluence）→ SDK stdio mcpServers，
    // 凭据缺失的服务由 resolver 返回 undefined 直接跳过（不误注入空配置）。
    const mcpServers: Record<string, McpServerConfig> = {}
    if (taskSource && mcpSetup) mcpServers.task_creation = mcpSetup.server
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
    return {
      token,
      cwd: input.cwd ?? process.cwd(),
      model: input.model.startsWith('qoder:') ? input.model.slice(6) : input.model,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      permissionMode: 'default' as const,
      controlRequestTimeoutMs: 15_000,
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
      ...(taskSource && mcpSetup
        ? {
            systemPrompt: taskSource.systemPrompt(),
            allowedTools: mcpSetup.toolNames,
            maxTurns: 10
          }
        : {}),
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
              if (sdkOpts.signal.aborted) return { behavior: 'deny', message: '工具调用已中止', interrupt: false }
              const decision = await this.onToolPermission!(toolName, toolInput, {
                signal: sdkOpts.signal,
                conversationId: input.conversationId,
                ...(sdkOpts.title ? { title: sdkOpts.title } : {}),
                ...(sdkOpts.displayName ? { displayName: sdkOpts.displayName } : {}),
                ...(sdkOpts.description ? { description: sdkOpts.description } : {})
              })
              return decision === 'deny'
                ? { behavior: 'deny', message: '用户拒绝了此操作，请改用其他方案', interrupt: false }
                : { behavior: 'allow' }
            }
          }
        : {})
    }
  }
}
