import type { ChatMessage } from "./chat-types.js";
import type { ResolvedChatModel } from "./chat-models.js";
import type { TaskCreationBackend, TaskCreatedResult } from "./task-backends/index.js";
export type TextStreamEvent = {
    type: "delta";
    delta: string;
} | {
    type: "task-created";
    task: TaskCreatedResult;
} | {
    type: "done";
};
export declare function streamChat(options: {
    model: ResolvedChatModel;
    qoderToken?: string;
    messages: ChatMessage[];
    signal: AbortSignal;
    taskBackend?: TaskCreationBackend;
    onCreated?: (result: TaskCreatedResult) => void;
}): AsyncGenerator<TextStreamEvent>;
