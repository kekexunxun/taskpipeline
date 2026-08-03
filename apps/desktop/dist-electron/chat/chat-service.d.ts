import type { BrowserWindow } from "electron";
import type { TaskStore } from "@coding-agent/core";
import type { AbortChatStreamInput, ChatConversation, ChatModelGroup, StartChatStreamInput } from "./chat-types.js";
import type { JiraTaskCreationAgent } from "./task-creation-agent.js";
type GetQoderStatus = () => Promise<{
    enabled: boolean;
    connected: boolean;
    running: boolean;
    models: Array<{
        value: string;
        displayName: string;
        isDefault?: boolean;
        isReasoning?: boolean;
        isVl?: boolean;
        priceFactor?: number;
    }>;
}>;
type TokenProvider = () => string | undefined;
export declare class ChatService {
    private readonly store;
    private readonly getQoderStatus;
    private readonly getQoderToken;
    private readonly getOpenAIKey;
    private readonly getMainWindow;
    private readonly createTaskAgent?;
    private readonly storage;
    private readonly activeStreams;
    constructor(store: TaskStore, dataDir: string, getQoderStatus: GetQoderStatus, getQoderToken: TokenProvider, getOpenAIKey: TokenProvider, getMainWindow: () => BrowserWindow | undefined, createTaskAgent?: (() => JiraTaskCreationAgent) | undefined);
    listChats(): import("./chat-types.js").ChatConversationMeta[];
    getChat(id: string): ChatConversation | undefined;
    listModels(): Promise<ChatModelGroup[]>;
    createChat(model?: string): ChatConversation;
    deleteChat(id: string): void;
    abortChat(input: AbortChatStreamInput): void;
    startChatStream(input: StartChatStreamInput): Promise<void>;
    private dispatch;
    private finish;
}
export {};
