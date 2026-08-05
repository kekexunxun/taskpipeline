import type { ResolvedChatModel } from "../chat/chat-models.js";
export type ExtractedMemoryDraft = {
    scope: "user" | "repo" | "conversation";
    title: string;
    content: string;
    tags: string[];
};
export declare function extractMemories(input: {
    model: ResolvedChatModel;
    qoderToken?: string;
    text: string;
    context: "chat" | "task";
    allowedScopes: ExtractedMemoryDraft["scope"][];
    signal?: AbortSignal;
}): Promise<ExtractedMemoryDraft[]>;
export declare function parseExtractedMemories(text: string, allowedScopes: ExtractedMemoryDraft["scope"][]): ExtractedMemoryDraft[];
