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
  type SdkMcpToolDefinition
} from '@qoder-ai/qoder-agent-sdk'
import type {
  ChatModelInfo,
  ChatStreamChunk,
  DriverPart,
  StoredMessage,
  StoredMessageRecord
} from '../chat-types.js'
import { QoderSession, QoderSessionRegistry } from '../../qoder/qoder-session.js'
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

  constructor(
    private readonly tokenProvider: QoderTokenProvider,
    private readonly statusProvider: QoderStatusProvider,
    /** B2：逐条 SDKMessage 回调（chat trace 落盘用），透传给常驻会话。 */
    private readonly onSdkMessage?: (conversationId: string, message: unknown) => void
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

    // 常驻会话:已存在则复用(多轮上下文由会话提供);不存在则创建 ——
    // 历史末尾有 qoder.session 时自动 resume(底层能力,应用重启后上下文不丢)。
    const existing = this.sessions.get(input.conversationId)
    const session =
      existing ??
      this.sessions.register(
        input.conversationId,
        new QoderSession(input.conversationId, this.buildSessionOptions(input, token))
      )

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
      throw error
    }
    if (!input.signal.aborted) {
      yield { type: 'done', status: 'done' }
    }
  }

  closeSession(conversationId: string): void {
    void this.sessions.close(conversationId)
  }

  dispose(): void {
    void this.sessions.dispose()
  }

  private buildSessionOptions(input: StreamChatInput, token: string) {
    const resumeSessionId = extractLastSessionId(input.history)
    const taskSource = input.toolSource
    const mcpSetup = taskSource ? buildTaskCreationMcp(taskSource) : undefined
    return {
      token,
      cwd: input.cwd ?? process.cwd(),
      model: input.model.startsWith('qoder:') ? input.model.slice(6) : input.model,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      permissionMode: 'default' as const,
      controlRequestTimeoutMs: 15_000,
      // B2：逐条 SDKMessage 透传（chat trace 落盘 / 未来复用），失败不影响主流程。
      ...(this.onSdkMessage
        ? {
            onMessage: (message: unknown) => {
              try {
                this.onSdkMessage?.(input.conversationId, message)
              } catch {
                /* 忽略:trace 采集失败不能影响对话 */
              }
            }
          }
        : {}),
      ...(taskSource && mcpSetup
        ? {
            systemPrompt: taskSource.systemPrompt(),
            mcpServers: { task_creation: mcpSetup.server },
            allowedMcpServerNames: ['task_creation'],
            allowedTools: mcpSetup.toolNames,
            maxTurns: 10
          }
        : {})
    }
  }
}
