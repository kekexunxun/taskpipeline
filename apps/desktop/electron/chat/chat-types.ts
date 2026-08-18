/**
 * Chat 抽象层共享类型。
 *
 * 设计：
 *  - `ChatDriver` / `DriverPart` / `StoredMessage` / `ChatStreamChunk` 是 chat driver 抽象的核心;
 *  - `ChatTaskCreationResult` 是任务创建后端的统一返回形态 (UI / IPC 都可以用);
 *  - `ChatMessageMetadata` 仍然跨 driver 共享 (status / model / taskCreation);
 *  - `ChatConversation` / `ChatConversationMeta` / `ChatModelInfo` / `ChatModelGroup`
 *    保留旧的形态,前端不用大改。
 *  - `UserFileAttachment` 是用户上传附件的本地缓存描述（路径 + 元信息）。
 *
 * 注意：本文件**只放类型**。driver 的运行时实现见 `drivers/*`,存储见 `chat-storage.ts`。
 */

import type { UserFileAttachment } from './chat-attachment-cache.js'

export type { UserFileAttachment }

/** 当前支持的 chat driver。driverId 在所有抽象层 (主进程 / IPC / 前端) 保持一致。 */
export type ChatDriverId = 'qoder' | 'openai'

/**
 * Driver 推给上层的"消息片"统一外壳。
 *
 * - 父任务关联:除 `qoder.session` 这类纯元信息外,所有 part 都可携带 `parentTaskId?` 字段。
 *   Qoder driver 在解析 SDKMessage 时维护 `tool_use_id -> task_id` 映射,看到 `task_started`
 *   时写入映射,看到其它消息时用其 `parent_tool_use_id` 反查映射,得到的 task_id 即为
 *   该 part 所属子任务。PartRenderer 用 `groupByParentTask` 把 part 数组拆成"主流程 +
 *   子任务折叠卡",与 TracePage / CodingPage Timeline 一致。
 * - 子任务三类系统消息独立成 part:
 *   - `qoder.subtask-start`: 子任务起点 → 折叠卡 header(taskId / taskType / description)
 *   - `qoder.subtask-progress`: 过程态(SDK 会发多次)→ 折叠卡 children 里的过程态指示
 *   - `qoder.subtask-end`: 收尾 → status / summary,负责关闭折叠卡 + 状态徽章
 *
 * 三个 part 都带 `taskId`,与 `parentTaskId` 反向引用 —— header 识别逻辑(groupByParentTask
 * 里 `item.taskId === parent && !group.header`)直接利用这个事实,不需要额外字段。
 */
export type DriverPart =
  | { driverId: 'qoder'; type: 'qoder.session'; sessionId: string }
  | { driverId: 'qoder'; type: 'qoder.thinking'; text: string; signature?: string; parentTaskId?: string }
  | {
      driverId: 'qoder'
      type: 'qoder.tool-use'
      toolCallId: string
      name: string
      input: unknown
      parentTaskId?: string
    }
  | {
      driverId: 'qoder'
      type: 'qoder.tool-result'
      toolCallId: string
      output: unknown
      isError?: boolean
      parentTaskId?: string
    }
  | {
      driverId: 'qoder'
      type: 'qoder.subtask-start'
      taskId: string
      parentTaskId: string
      taskType?: string
      subagentType?: string
      description?: string
      toolUseId?: string
    }
  | {
      driverId: 'qoder'
      type: 'qoder.subtask-progress'
      taskId: string
      parentTaskId: string
      description?: string
      lastToolName?: string
      usage?: unknown
    }
  | {
      driverId: 'qoder'
      type: 'qoder.subtask-end'
      taskId: string
      parentTaskId: string
      status: string
      summary?: string
      outputFile?: string
      usage?: unknown
    }
  | {
      driverId: 'openai'
      type: 'openai.tool-call'
      toolCallId: string
      name: string
      input: unknown
      parentTaskId?: string
    }
  | { driverId: 'openai'; type: 'openai.tool-result'; toolCallId: string; output: unknown; parentTaskId?: string }
  | { driverId: 'openai'; type: 'openai.thinking'; text: string; parentTaskId?: string }
  | { driverId: ChatDriverId; type: 'text'; text: string; parentTaskId?: string }
  | {
      driverId: ChatDriverId
      type: 'file'
      mediaType: string
      localPath: string
      filename?: string
      parentTaskId?: string
    }
  | {
      driverId: ChatDriverId
      type: 'plan'
      plan: ChatPlan
      parentTaskId?: string
    }

/** 单条消息的流式用量（openai driver 从 ai-sdk finish chunk 收集；qoder 暂无数据）。 */
export type ChatUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd?: number
}

/** 持久化形态: driver 自己的 raw + 共用元数据。 */
export type StoredMessageRecord = {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: string
  driverId: ChatDriverId
  /** driver 自己的序列化形态,任意 JSON。 */
  raw: unknown
  /** assistant 消息的流式用量（Trace 展示用，其它角色无）。 */
  usage?: ChatUsage
  /** assistant 消息的接口异常详情（openai/qoder 驱动失败时落盘，界面红色错误块展示）。 */
  errorMessage?: string
}

/** 运行时消息: 在 `StoredMessageRecord` 基础上多一份 `parts` 供 UI 渲染。 */
export type StoredMessage = StoredMessageRecord & {
  parts: DriverPart[]
}

export type ChatMessageStatus = 'done' | 'error' | 'aborted'
export type ChatAgentMode = 'chat' | 'task-create'

/**
 * 对话模式：normal=常规对话, plan=只读计划模式。
 * 后续可扩展更多模式（如 'review'、'debug' 等），只需扩展联合类型 + 各处 switch-case。
 * 注意：与 Coding Pipeline 的 `TaskStartMode` 完全隔离，互不影响。
 */
export type ChatConversationMode = 'normal' | 'plan'

/** 任务创建结果(跨 driver 共享)。 */
export type ChatTaskCreationResult = {
  backend: 'jira' | 'github' | 'linear'
  externalKey: string
  summary: string
  projectKey: string
  issueType: string
}

export type ChatMessageMetadata = {
  createdAt: string
  model?: string
  status?: ChatMessageStatus
  agentMode?: ChatAgentMode
  taskCreation?: ChatTaskCreationResult
  /** 本次回复的流式用量（openai driver 提供，Trace 展示用）。 */
  usage?: ChatUsage
}

/** driver 流式过程事件。 */
export type ChatStreamChunk =
  | { type: 'start'; messageId: string; messageMetadata?: ChatMessageMetadata }
  | { type: 'part'; part: DriverPart }
  | { type: 'model'; model: string }
  | { type: 'task-created'; result: ChatTaskCreationResult }
  /** 阶段提示：主进程在执行耗时的预处理（关键词提取/记忆检索等）时推给前端展示，避免用户干等。 */
  | { type: 'status'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; status: ChatMessageStatus; usage?: ChatUsage; model?: string }
  /** 计划模式开始：前端将后续文本 parts 渲染为 PlanCard（显示“计划生成中...”）。 */
  | { type: 'plan-start' }
  /** 计划模式：用计划卡片替换消息的所有文本 parts。 */
  | { type: 'plan-part'; parts: DriverPart[] }

/**
 * 模型可调参数能力声明（driver 自描述，schema 驱动）。
 * 选择器按 capabilities 渲染运行时调节控件；不支持的能力不声明，避免无效 UI。
 * - reasoningEffort: 推理力度档位（OpenAI reasoning / DeepSeek reasoningEffort）；
 * - thinking: 思考模式开关（DeepSeek thinking.type enabled/disabled）；
 * - maxOutputTokens: 最大输出 Token（上下文窗口控制）。
 */
export type ModelCapability =
  | { key: 'reasoningEffort'; kind: 'enum'; options: string[] }
  | { key: 'thinking'; kind: 'toggle' }
  | { key: 'maxOutputTokens'; kind: 'number'; max?: number }

/** 运行时模型参数（与 capabilities 的 key 对应；按对话持久化）。 */
export type ModelParams = Record<string, unknown>

/** 模型清单项 / 分组 — 与前端 `ChatModelInfo / ChatModelGroup` 对齐。 */
export type ChatModelInfo = {
  value: string
  displayName: string
  isDefault?: boolean
  isReasoning?: boolean
  isVl?: boolean
  priceFactor?: number
  /** 该模型支持的运行时可调参数；缺省 = 无可调参数。 */
  capabilities?: ModelCapability[]
}
export type ChatModelGroup = {
  driverId: ChatDriverId
  displayName: string
  models: ChatModelInfo[]
  /** Qoder 分组额度不足（无 credit / 仅免费模型可用）时置 true，前端据此提示「当前仅 lite 可用」。 */
  quotaExhausted?: boolean
}

/**
 * 对话计划结构（plan 模式下 LLM 输出的 Markdown 计划）。
 * 存储于 dataDir/plans/{chatId}/{messageId}.md，执行时告知 LLM 文件路径避免上下文爆炸。
 */
export type ChatPlan = {
  /** 计划唯一 ID（与消息 ID 关联）。 */
  id: string
  /** 关联的对话 ID。 */
  chatId: string
  /** 计划创建时间。 */
  createdAt: string
  /** 计划状态：pending=待执行, executing=执行中, completed=已完成, failed=失败。 */
  status: ChatPlanStatus
  /** Markdown 格式的计划内容。 */
  content: string
  /** 计划文件存储路径（执行时告知 LLM）。 */
  filePath: string
}

/** 计划状态。 */
export type ChatPlanStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled'

/**
 * 可选的 MCP 服务 id（Chat 页 MCP 选择器与 driver 注入共用）。
 * 内置固定 gitlab / jira / confluence，另可由设置页新增自定义服务（统一存 dataDir/mcp.json）。
 */
export type McpServiceId = string

/** HITL (Human-in-the-Loop) 模式：按对话/任务独立存储。 */
export type HitlMode = 'ask' | 'auto' | 'yolo'

/** 对话持久化形态。 */
export type ChatConversationMeta = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  model?: string
  driverId?: ChatDriverId
  /** 对话级运行时模型参数（推理力度/思考模式等），随对话持久化。 */
  modelParams?: ModelParams
  /** 最近一轮选中的 MCP 服务列表（随对话落盘，切换对话后恢复并注入 driver）。 */
  mcpService?: McpServiceId[]
  /** 最近一轮选中的 Skill 名列表（随对话落盘，切换对话后恢复并注入 driver）。 */
  skills?: string[]
  /** 最近一轮选中的 Agent id（随对话落盘，切换对话后恢复选择态）。 */
  agentId?: string
  /** 对话级 HITL 模式（随对话落盘，切换对话后恢复）。未设置时沿用全局默认 'ask'。 */
  hitlMode?: HitlMode
  /** 对话模式（随对话落盘，切换对话后恢复）。未设置时默认 'normal'。 */
  chatMode?: ChatConversationMode
  messageCount: number
  /**
   * 绑定的本地工作目录(项目对话)。
   * 有值 = 项目对话,Agent 在该目录下执行(类 Codex 的 cwd 语义);
   * 无值/undefined = 普通对话。
   */
  workingDirectory?: string
  /**
   * 是否已做过记忆上下文提取注入（每对话只做一次；整轮成功后才置位，失败/中止不消耗资格，
   * 重试仍会重新提取）。持久化保证应用重启后不重复提取。
   */
  memoryInjected?: boolean
}
/**
 * 对话完整形态。`messages` 是 driver 透传的 record 列表(不包含运行时 `parts`),
 * UI / ChatService 在拿到 `ChatConversation` 后,再按每条 `driverId` 调对应
 * `ChatDriver.deserializeMessage()` 把 `parts` 拼上去。
 */
export type ChatConversation = ChatConversationMeta & { messages: StoredMessageRecord[] }

/**
 * 统一分组实体 — 替代原 ChatProject + 独立 chat-workspaces.json。
 * chatType='directory': 对话绑定工作目录时自动创建;
 * chatType='workspace': 用户通过创建对话框显式创建(多目录逻辑分组)。
 * 与具体会话解耦: 目录下所有会话被删除后分组仍保留, 显示「没有对话」。
 */
export type ChatGroup = {
  id: string
  chatType: 'directory' | 'workspace'
  /** workspace 有值(用户命名), directory 无值(前端取 baseName(directory))。 */
  name?: string
  /** workspace 可多个目录, directory 只有一个。 */
  directories: string[]
  createdAt: string
  /** 取组内最新对话 updatedAt, 动态更新; 空组取自身创建/操作时间。 */
  updatedAt: string
}

/** 流式启动 / 终止入参。 */
export type StartChatStreamInput = {
  streamId: string
  chatId: string
  driverId: ChatDriverId
  model: string
  /** 运行时模型参数（选择器调节产出；ChatService 随对话落盘并透传给 driver）。 */
  modelParams?: ModelParams
  /** 用户当前输入(未持久化),ChatService 会按 driverId 调 `driver.serializeUserMessage` 包成 record。 */
  message: { id: string; text: string; createdAt: string; files?: UserFileAttachment[] }
  mode?: ChatAgentMode
  /** 对话模式（normal=常规对话, plan=只读计划模式）。前端指定或由后端自动切换。 */
  chatMode?: ChatConversationMode
  /** 选中的 MCP 服务列表（落盘 + 注入 driver 工具：Qoder 走 mcpServers，OpenAI 走 MCP 桥接工具）。 */
  mcpService?: McpServiceId[]
  /** 选中的 Skill 名列表（落盘 + 注入 driver：Qoder 走 SDK skills，OpenAI 走 system 拼接）。 */
  skills?: string[]
  /** 选中 Agent 的 id（落盘与 Trace 展示用；systemPrompt 单独注入）。 */
  agentId?: string
  /** 选中 Agent 的 systemPrompt，注入为本轮 system 消息并随对话落盘。 */
  systemPrompt?: string
}
export type AbortChatStreamInput = { streamId: string; chatId: string }

/** IPC 事件:逐 part / 错误 / 完成 推到前端。 */
export type ChatStreamEvent = {
  streamId: string
  chatId: string
  driverId: ChatDriverId
  chunk?: ChatStreamChunk
  error?: string
  done?: boolean
}
