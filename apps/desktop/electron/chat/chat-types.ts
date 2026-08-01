import type { UIMessage, UIMessageChunk } from "ai";

export type ChatMessageStatus = "done" | "error" | "aborted";
export type ChatMessageMetadata = {
  createdAt: string;
  model?: string;
  status?: ChatMessageStatus;
};
export type ChatMessage = UIMessage<ChatMessageMetadata>;

export type ChatConversationMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: "qoder" | "openai";
  messageCount: number;
};
export type ChatConversation = ChatConversationMeta & { messages: ChatMessage[] };

export type ChatModelInfo = { value: string; displayName: string; isDefault?: boolean; isReasoning?: boolean; isVl?: boolean; priceFactor?: number };
export type ChatModelGroup = { provider: "qoder" | "openai"; displayName: string; models: ChatModelInfo[] };

export type StartChatStreamInput = { streamId: string; chatId: string; model: string; message: ChatMessage };
export type AbortChatStreamInput = { streamId: string; chatId: string };
export type ChatStreamEvent = { streamId: string; chatId: string; chunk?: UIMessageChunk; error?: string; done?: boolean };
