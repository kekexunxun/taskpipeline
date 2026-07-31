export type ChatMessage = {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
    model?: string;
    status?: "streaming" | "done" | "error";
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
export declare class ChatStorage {
    private readonly dataDir;
    constructor(dataDir: string);
    private withDir;
    listMetas(): ChatConversationMeta[];
    readMessages(id: string): ChatMessage[];
    appendMessage(id: string, message: ChatMessage): void;
    upsertMeta(meta: ChatConversationMeta): void;
    deleteConversation(id: string): void;
}
