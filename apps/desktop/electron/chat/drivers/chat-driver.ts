/**
 * Chat Driver 抽象层。
 *
 * 背景：
 *  早期实现里 `chat-llm.ts` 同时塞进了 Qoder SDK (`@qoder-ai/qoder-agent-sdk`)
 *  和 `@ai-sdk/openai-compatible` 两套调用方，并各自重新包装任务创建工具
 *  (jira-related `get_jira_creation_schema` / `create_jira_issue` / `search_confluence` / `get_confluence_page`)。
 *  这导致：
 *  1. 同一份工具声明要在两个 SDK 中各写一遍,后续接入 GitHub / Linear 时需要改两处；
 *  2. Qoder 的 SDKMessage 事件流被强转成 ai-sdk 的 `UIMessage.parts: { type: "text" }[]`,
 *     丢掉了 thinking / tool_use / session_id 等信息;
 *  3. 存储层被迫用 ai-sdk 的统一结构,Qoder 自己的形态被规范化掉,无法做"原始格式"持久化。
 *
 * 设计：
 *  - `ChatDriver` 是统一的 chat 路径接口: listModels / streamChat / serializeUserMessage / deserializeMessage / dispose。
 *  - 每种 provider (qoder / openai) 实现一次,所有 Qoder SDK / ai-sdk 细节都封在自己内部。
 *  - 工具声明由 `ToolSource` 提供 (drivers/tool-source.ts),driver 负责把通用声明翻译成自己协议的 tool。
 *  - 上层 (ChatService / ChatStorage / Frontend) 不再感知 driver 内部 SDK 细节;
 *    历史消息按 `driverId` 各自反序列化,UI 端按 `driverId` 路由到对应 MessageView 组件。
 */

import type {
  ChatDriverId,
  ChatStreamChunk,
  ChatModelInfo,
  DriverPart,
  McpServiceId,
  ModelParams,
  StoredMessage,
  StoredMessageRecord,
  UserFileAttachment
} from '../chat-types.js'
import type { ToolSource } from './tool-source.js'

/**
 * StreamChat 输入参数。
 *
 * - `history` 已经过 driver.deserializeMessage 处理(parts 形态);
 * - `userInput` 是当前用户输入(纯文本,driver 负责包装成自己的 prompt 协议);
 * - `toolSource` 可选,提供 systemPrompt + 工具声明;driver 负责把工具翻译成自己的协议;
 *   driver 在 tool 执行后调 `ToolSource.describeResult(output)`,若返回 `ChatTaskCreationResult`
 *   就 emit `{ type: "task-created", result }` chunk,ChatService 据此把任务创建结果写入消息元数据。
 */
export type StreamChatInput = {
  conversationId: string
  model: string
  /**
   * 运行时模型参数（推理力度 / 思考模式 / 最大输出 Token 等）。
   * driver 按自己支持的能力翻译到协议参数；不认识 / 不支持的 key 一律忽略。
   */
  modelParams?: ModelParams
  history: StoredMessage[]
  userInput: { id: string; text: string; createdAt: string; files?: UserFileAttachment[] }
  signal: AbortSignal
  toolSource?: ToolSource
  /**
   * 用户选中的 MCP 服务（gitlab / jira / confluence）。driver 负责真正注入：
   * Qoder 走 SDK mcpServers（stdio 子进程），OpenAI 走 MCP 客户端桥接成 ai-sdk 工具。
   */
  mcpServices?: McpServiceId[]
  /** 选中的 Skill 名列表（driver 负责注入：Qoder 走 SDK skills，OpenAI 走 system 拼接）。 */
  skills?: string[]
  /**
   * 对话绑定的工作目录(项目对话)。driver 应让 Agent 在该目录下执行;
   * 缺省时回退到进程当前目录。
   */
  cwd?: string
  /**
   * 工作区上下文（多目录工作区描述 + agents.md 规范）。
   * OpenAI driver 用于构建分层系统提示；Qoder driver 不使用此字段。
   */
  workspaceContext?: string
  /**
   * 加入已存在的对话回合 trace（一次用户提问 = 一个 Trace）。
   * 主对话由 ChatService 传入；关键词提取 / 记忆整理等辅助 LLM 调用显式 join，
   * 让一次提问下的多次 LLM 调用串联在同一棵执行树里。缺省时 driver 自建独立 trace。
   */
  traceId?: string
  /**
   * trace 语义名：辅助 LLM 调用（关键词提取 / 记忆整理）的 span 名称覆盖。
   * 否则 span 名直接用模型名，任务执行树里会出现与任务模型无关的
   * 「LLM deepseek-v4-flash」等条目，被误读为任务主体模型。
   */
  traceLabel?: string
}

/**
 * ChatDriver 接口。
 *
 * 每个 driver 自带 listModels + streamChat + 消息序列化能力。
 * 上层 (ChatService) 通过 `driverId` 选 driver,完全不感知 driver 内部的 SDK 细节。
 */
export interface ChatDriver {
  readonly id: ChatDriverId
  readonly displayName: string
  listModels(): Promise<ChatModelInfo[]>
  /**
   * 把 driver 自己的 `raw` 形态反序列化为运行时 `StoredMessage`(带 `parts`)。
   * `raw` 由 driver.serializeUserMessage / driver.serializeAssistantMessage 决定形态。
   */
  deserializeMessage(record: StoredMessageRecord): StoredMessage
  /**
   * 把当前用户输入包装成 driver 自己的 `raw` 形态(给存储层用)。
   */
  serializeUserMessage(input: {
    id: string
    text: string
    createdAt: string
    files?: UserFileAttachment[]
  }): StoredMessageRecord
  /**
   * 把 assistant 消息在流式过程中累积的 `parts` 包装成 driver 自己的 `raw` 形态(给存储层用)。
   * driver 内部负责决定"如何把 parts 平展成 raw JSON",存储层不解析。
   * 对于 Qoder 之类能在 SDK 内继续续接 session 的 driver,可选择把 `sessionId` 写入 raw。
   */
  serializeAssistantMessage(input: {
    id: string
    parts: DriverPart[]
    createdAt: string
    sessionId?: string
  }): StoredMessageRecord
  /**
   * 流式生成。driver 内部负责:
   *  - 把 `history` 翻译成自己的 prompt / message 协议;
   *  - 解析自己 SDK 的流事件,把 thinking / tool_use / tool_result / text 拆成 DriverPart;
   *  - 工具执行后调 `toolSource.describeResult(output)`,若是任务创建则 emit
   *    `{ type: "task-created", result }` chunk;
   *  - 调 `signal.aborted` 主动停止自己内部的子进程 / 请求。
   */
  streamChat(input: StreamChatInput): AsyncGenerator<ChatStreamChunk>
  /**
   * 关闭一个逻辑会话(删除对话 / 任务结束)。支持常驻会话的 driver(如 Qoder)实现;
   * 无状态 driver(如 OpenAI,每轮全量发送)可不实现。
   */
  closeSession?(id: string): void
  /** 释放 driver 持有的资源(MCP client / HTTP pool / SDK 子进程)。 */
  dispose(): void
}
