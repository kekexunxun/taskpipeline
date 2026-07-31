import type { ChatMessage } from "./chat-storage.js";
export type StreamEvent = {
    type: "delta";
    delta: string;
} | {
    type: "done";
    content: string;
    model?: string;
} | {
    type: "error";
    error: string;
};
export interface StreamChatOptions {
    provider: "qoder" | "openai";
    modelKey: string;
    qoderToken?: string;
    openaiProfile?: {
        baseUrl: string;
        model: string;
        apiKey?: string;
    };
    messages: ChatMessage[];
    signal: AbortSignal;
}
export declare function streamChat(opts: StreamChatOptions): AsyncGenerator<StreamEvent>;
