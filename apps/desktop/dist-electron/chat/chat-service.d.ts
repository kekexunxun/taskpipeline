import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import type { TaskStore } from "@coding-agent/core";
import { type ChatMessage, type ChatConversationMeta } from "./chat-storage.js";
import type { ChatConversation, ChatModelGroup } from "./chat-types.js";
type GetQoderStatus = () => Promise<{
    enabled: boolean;
    connected: boolean;
    running: boolean;
    models: Array<{
        value: string;
        displayName: string;
        isDefault?: boolean;
        isReasoning?: boolean;
        priceFactor?: number;
    }>;
}>;
type QoderTokenProvider = () => string | undefined;
export declare class ChatService extends EventEmitter {
    private readonly store;
    private readonly dataDir;
    private readonly getQoderStatus;
    private readonly getQoderToken;
    private readonly getMainWindow;
    private storage;
    private activeStreams;
    constructor(store: TaskStore, dataDir: string, getQoderStatus: GetQoderStatus, getQoderToken: QoderTokenProvider, getMainWindow: () => BrowserWindow | undefined);
    listChats(): ChatConversationMeta[];
    getChat(id: string): ChatConversation | undefined;
    createChat(model?: string): ChatConversation;
    deleteChat(id: string): void;
    appendUserMessage(id: string, text: string): ChatMessage;
    listModels(): Promise<ChatModelGroup[]>;
    abortChat(id: string): void;
    sendChatMessage(chatId: string, messageId: string, model: string): Promise<void>;
    private updateAssistantMessage;
    private dispatch;
}
export {};
