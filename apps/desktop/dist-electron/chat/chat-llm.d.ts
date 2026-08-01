import type { ChatMessage } from "./chat-types.js";
import type { ResolvedChatModel } from "./chat-models.js";
export type TextStreamEvent = {
    type: "delta";
    delta: string;
} | {
    type: "done";
};
export declare function streamChat(options: {
    model: ResolvedChatModel;
    qoderToken?: string;
    messages: ChatMessage[];
    signal: AbortSignal;
}): AsyncGenerator<TextStreamEvent>;
