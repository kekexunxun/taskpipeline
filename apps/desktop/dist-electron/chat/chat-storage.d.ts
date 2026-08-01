import type { ChatConversation, ChatConversationMeta, ChatMessage } from "./chat-types.js";
export declare class ChatStorage {
    private readonly dataDir;
    constructor(dataDir: string);
    private ensureDir;
    listMetas(): ChatConversationMeta[];
    getConversation(id: string): ChatConversation | undefined;
    saveConversation(conversation: ChatConversation): void;
    replaceMessages(id: string, messages: ChatMessage[], patch?: Partial<ChatConversationMeta>): ChatConversation | undefined;
    deleteConversation(id: string): void;
    private upsertMeta;
    private writeIndex;
}
