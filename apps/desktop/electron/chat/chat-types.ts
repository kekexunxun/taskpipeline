/**
 * Chat 抽象层共享类型。
 *
 * 设计：
 *  - `ChatDriver` / `DriverPart` / `StoredMessage` / `ChatStreamChunk` 是 chat driver 抽象的核心;
 *  - `ChatTaskCreationResult` 是任务创建后端的统一返回形态 (UI / IPC 都可以用);
 *  - `ChatMessageMetadata` 仍然跨 driver 共享 (status / model / taskCreation);
 *  - `ChatConversation` / `ChatConversationMeta` / `ChatModelInfo` / `ChatModelGroup`
 *    保留旧的形态,前端不用大改。
 *
 * 注意：本文件**只放类型**。driver 的运行时实现见 `drivers/*`,存储见 `chat-storage.ts`。
 */

/** 当前支持的 chat driver。driverId 在所有抽象层 (主进程 / IPC / 前端) 保持一致。 */
export type ChatDriverId = "qoder" | "openai";

/** Driver 推给上层的"消息片"统一外壳。 */
export type DriverPart =
  | { driverId: "qoder"; type: "qoder.session"; sessionId: string }
  | { driverId: "qoder"; type: "qoder.thinking"; text: string; signature?: string }
  | { driverId: "qoder"; type: "qoder.tool-use"; toolCallId: string; name: string; input: unknown }
  | { driverId: "qoder"; type: "qoder.tool-result"; toolCallId: string; output: unknown; isError?: boolean }
  | { driverId: "openai"; type: "openai.tool-call"; toolCallId: string; name: string; input: unknown }
  | { driverId: "openai"; type: "openai.tool-result"; toolCallId: string; output: unknown }
  | { driverId: ChatDriverId; type: "text"; text: string };

/** 持久化形态: driver 自己的 raw + 共用元数据。 */
export type StoredMessageRecord = {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  driverId: ChatDriverId;
  /** driver 自己的序列化形态,任意 JSON。 */
  raw: unknown;
};

/** 运行时消息: 在 `StoredMessageRecord` 基础上多一份 `parts` 供 UI 渲染。 */
export type StoredMessage = StoredMessageRecord & {
  parts: DriverPart[];
};

export type ChatMessageStatus = "done" | "error" | "aborted";
export type ChatAgentMode = "chat" | "task-create";

/** 任务创建结果(跨 driver 共享)。 */
export type ChatTaskCreationResult = {
  backend: "jira" | "github" | "linear";
  externalKey: string;
  summary: string;
  projectKey: string;
  issueType: string;
};

export type ChatMessageMetadata = {
  createdAt: string;
  model?: string;
  status?: ChatMessageStatus;
  agentMode?: ChatAgentMode;
  taskCreation?: ChatTaskCreationResult;
};

/** driver 流式过程事件。 */
export type ChatStreamChunk =
  | { type: "start"; messageId: string; messageMetadata?: ChatMessageMetadata }
  | { type: "part"; part: DriverPart }
  | { type: "model"; model: string }
  | { type: "task-created"; result: ChatTaskCreationResult }
  | { type: "error"; message: string }
  | { type: "done"; status: ChatMessageStatus };

/** 模型清单项 / 分组 — 与前端 `ChatModelInfo / ChatModelGroup` 对齐。 */
export type ChatModelInfo = {
  value: string;
  displayName: string;
  isDefault?: boolean;
  isReasoning?: boolean;
  isVl?: boolean;
  priceFactor?: number;
};
export type ChatModelGroup = {
  driverId: ChatDriverId;
  displayName: string;
  models: ChatModelInfo[];
};

/** 对话持久化形态。 */
export type ChatConversationMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  driverId?: ChatDriverId;
  messageCount: number;
};
/**
 * 对话完整形态。`messages` 是 driver 透传的 record 列表(不包含运行时 `parts`),
 * UI / ChatService 在拿到 `ChatConversation` 后,再按每条 `driverId` 调对应
 * `ChatDriver.deserializeMessage()` 把 `parts` 拼上去。
 */
export type ChatConversation = ChatConversationMeta & { messages: StoredMessageRecord[] };

/** 流式启动 / 终止入参。 */
export type StartChatStreamInput = {
  streamId: string;
  chatId: string;
  driverId: ChatDriverId;
  model: string;
  /** 用户当前输入(未持久化),ChatService 会按 driverId 调 `driver.serializeUserMessage` 包成 record。 */
  message: { id: string; text: string; createdAt: string };
  mode?: ChatAgentMode;
};
export type AbortChatStreamInput = { streamId: string; chatId: string };

/** IPC 事件:逐 part / 错误 / 完成 推到前端。 */
export type ChatStreamEvent = { streamId: string; chatId: string; driverId: ChatDriverId; chunk?: ChatStreamChunk; error?: string; done?: boolean };
