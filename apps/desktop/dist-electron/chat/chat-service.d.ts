import type { BrowserWindow } from "electron";
import type { TaskStore } from "@coding-agent/core";
import { type ResolvedChatModel } from "./chat-models.js";
import type { AbortChatStreamInput, ChatConversation, ChatModelGroup, StartChatStreamInput } from "./chat-types.js";
import type { TaskCreationBackend } from "./task-backends/index.js";
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
type TaskBackendFactory = () => TaskCreationBackend | undefined;
type MemoryContextProvider = (input: {
    conversationId: string;
    query: string;
}) => Promise<string | undefined>;
type ConversationConsolidator = (input: {
    conversation: ChatConversation;
    model: ResolvedChatModel;
    signal: AbortSignal;
}) => Promise<void>;
export declare class ChatService {
    private readonly store;
    private readonly getQoderStatus;
    private readonly getQoderToken;
    private readonly getOpenAIKey;
    private readonly getMainWindow;
    private readonly resolveTaskBackend?;
    private readonly memoryContext?;
    private readonly consolidateConversation?;
    private readonly storage;
    private readonly activeStreams;
    constructor(store: TaskStore, dataDir: string, getQoderStatus: GetQoderStatus, getQoderToken: TokenProvider, getOpenAIKey: TokenProvider, getMainWindow: () => BrowserWindow | undefined, resolveTaskBackend?: TaskBackendFactory | undefined, memoryContext?: MemoryContextProvider | undefined, consolidateConversation?: ConversationConsolidator | undefined);
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
