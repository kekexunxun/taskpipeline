import type { ChatMessage } from "./chat-types.js";
import type { ResolvedChatModel } from "./chat-models.js";
import type { JiraTaskCreationAgent } from "./task-creation-agent.js";
export type TextStreamEvent = {
    type: "delta";
    delta: string;
} | {
    type: "task-created";
    task: NonNullable<JiraTaskCreationAgent["createdTask"]>;
} | {
    type: "done";
};
export declare function streamChat(options: {
    model: ResolvedChatModel;
    qoderToken?: string;
    messages: ChatMessage[];
    signal: AbortSignal;
    taskAgent?: JiraTaskCreationAgent;
}): AsyncGenerator<TextStreamEvent>;
