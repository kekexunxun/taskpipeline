export type ChatMessageRole = "user" | "assistant" | "system";
export type ChatMessageStatus = "streaming" | "done" | "error";
export type ChatMessage = {
    id: string;
    role: ChatMessageRole;
    content: string;
    createdAt: string;
    model?: string;
    status?: ChatMessageStatus;
};
export type ChatConversationMeta = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    model?: string;
    provider?: "qoder" | "openai";
    messageCount: number;
};
export type ChatConversation = ChatConversationMeta & {
    messages: ChatMessage[];
};
export type ChatModelInfo = {
    value: string;
    displayName: string;
    isDefault?: boolean;
    isReasoning?: boolean;
    priceFactor?: number;
};
export type ChatModelGroup = {
    provider: "qoder" | "openai";
    displayName: string;
    models: ChatModelInfo[];
};
export type ChatEvent = {
    type: "chat_message_start";
    chatId: string;
    messageId: string;
    role: "assistant";
} | {
    type: "chat_message_delta";
    chatId: string;
    messageId: string;
    delta: string;
} | {
    type: "chat_message_done";
    chatId: string;
    messageId: string;
    content: string;
    model?: string;
} | {
    type: "chat_message_error";
    chatId: string;
    messageId: string;
    error: string;
};
