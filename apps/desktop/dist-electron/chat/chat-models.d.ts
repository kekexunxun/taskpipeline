import type { ChatModelGroup } from "./chat-types.js";
import type { TaskStore } from "@coding-agent/core";
type QoderStatus = {
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
};
export declare function listChatModels(store: TaskStore, getQoderStatus: () => Promise<QoderStatus>): Promise<ChatModelGroup[]>;
export declare function parseModelValue(value: string): {
    provider: "qoder" | "openai";
    key: string;
    openai?: {
        baseUrl: string;
        model: string;
        apiKey?: string;
    };
};
export {};
