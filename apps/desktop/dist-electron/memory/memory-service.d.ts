import { type Memory, type MemoryScope, type MemorySearchHit, type RepoWikiSearchHit, type TaskStore } from "@coding-agent/core";
import type { ExtractedMemoryDraft } from "./memory-extractor.js";
export declare function renderMemoryContext(memories: MemorySearchHit[], wikiDocs: RepoWikiSearchHit[]): string | undefined;
export type MemoryContextOptions = {
    userId?: string;
    repositoryIds?: string[];
    conversationId?: string;
    query: string;
    limit?: number;
};
export declare class MemoryService {
    private readonly store;
    private readonly memory;
    constructor(store: TaskStore);
    ensureUserId(): string;
    listMemories(filter?: {
        scope?: MemoryScope;
        scopes?: MemoryScope[];
        repositoryId?: string;
        conversationId?: string;
    }): Memory[];
    upsertMemory(input: Omit<Memory, "id" | "createdAt" | "updatedAt"> & {
        id?: string;
    }): Memory;
    updateMemory(id: string, patch: Partial<Omit<Memory, "id" | "createdAt" | "updatedAt">>): Memory;
    deleteMemory(id: string): void;
    deleteRepoMemories(repositoryId: string): void;
    deleteConversationMemories(conversationId: string): void;
    listRepoWikiDocs(repositoryId: string): import("@coding-agent/core").RepoWikiDoc[];
    searchRepoWikiDocs(repositoryId: string, query: string): RepoWikiSearchHit[];
    refreshRepoWiki(repositoryId: string, localPath: string): Promise<{
        indexed: number;
        removed: number;
    }>;
    search(options: MemoryContextOptions): Promise<{
        memories: MemorySearchHit[];
        wikiDocs: RepoWikiSearchHit[];
    }>;
    buildSystemPrompt(options: MemoryContextOptions): Promise<string | undefined>;
    consolidateMemories(drafts: ExtractedMemoryDraft[], repositoryIds: string[], conversationId: string): number;
}
