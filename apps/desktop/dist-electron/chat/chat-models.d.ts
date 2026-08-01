import type { TaskStore } from "@coding-agent/core";
import type { ChatModelGroup } from "./chat-types.js";
type QoderStatus = {
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
};
export type ResolvedChatModel = {
    provider: "qoder";
    key: string;
} | {
    provider: "openai";
    key: string;
    baseUrl: string;
    apiKey?: string;
};
export declare function listChatModels(store: TaskStore, getQoderStatus: () => Promise<QoderStatus>): Promise<ChatModelGroup[]>;
export declare function resolveChatModel(value: string, store: TaskStore, getOpenAIKey: () => string | undefined): ResolvedChatModel;
export {};
