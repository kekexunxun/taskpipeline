import { randomUUID } from "node:crypto";
import { MemoryStore, type Memory, type MemoryScope, type MemorySearchHit, type RepoWikiSearchHit, type TaskStore } from "@coding-agent/core";
import { collectRepoWikiDocs } from "../repowiki/indexer.js";
import type { ExtractedMemoryDraft } from "./memory-extractor.js";

const CONTEXT_LIMIT = 4000;
const DEFAULT_LIMIT = 5;

export function renderMemoryContext(memories: MemorySearchHit[], wikiDocs: RepoWikiSearchHit[]): string | undefined {
  const sections: string[] = [];
  if (memories.length) sections.push(`## 记忆上下文\n${memories.map((m) => `- [${m.scope}] ${m.title}: ${m.content.slice(0, 300)}`).join("\n")}`);
  if (wikiDocs.length) sections.push(`## 仓库 Wiki 文档(repowiki)\n${wikiDocs.map((doc) => `- ${doc.path}: ${doc.content.slice(0, 300)}`).join("\n")}`);
  if (!sections.length) return undefined;
  const text = `以下是与当前任务相关的长期记忆与仓库文档。应优先遵循其中的工程约定；若与用户最新指令冲突,以用户指令为准。\n\n${sections.join("\n\n")}`;
  return text.length > CONTEXT_LIMIT ? `${text.slice(0, CONTEXT_LIMIT)}\n…(记忆过长已截断)` : text;
}

export type MemoryContextOptions = {
  userId?: string;
  repositoryIds?: string[];
  conversationId?: string;
  query: string;
  limit?: number;
};

export class MemoryService {
  private readonly memory: MemoryStore;

  constructor(private readonly store: TaskStore) {
    this.memory = new MemoryStore(store.db);
  }

  ensureUserId(): string {
    const existing = this.store.getSetting("memoryUserId");
    if (existing) return existing;
    const id = randomUUID();
    this.store.setSetting("memoryUserId", id);
    return id;
  }

  listMemories(filter: { scope?: MemoryScope; scopes?: MemoryScope[]; repositoryId?: string; conversationId?: string } = {}): Memory[] {
    return this.memory.listMemories({ ...filter, userId: this.ensureUserId() });
  }

  upsertMemory(input: Omit<Memory, "id" | "createdAt" | "updatedAt"> & { id?: string }): Memory {
    if (input.id) {
      const current = this.memory.getMemory(input.id);
      if (current) return this.memory.updateMemory(input.id, input);
    }
    return this.memory.createMemory({ ...input, userId: input.userId ?? this.ensureUserId() });
  }

  updateMemory(id: string, patch: Partial<Omit<Memory, "id" | "createdAt" | "updatedAt">>): Memory { return this.memory.updateMemory(id, patch); }
  deleteMemory(id: string): void { this.memory.deleteMemory(id); }

  deleteRepoMemories(repositoryId: string): void {
    this.memory.deleteMemories({ repositoryId });
    this.memory.clearRepoWikiDocs(repositoryId);
  }

  deleteConversationMemories(conversationId: string): void {
    this.memory.deleteMemories({ conversationId });
  }

  listRepoWikiDocs(repositoryId: string) { return this.memory.listRepoWikiDocs(repositoryId); }
  searchRepoWikiDocs(repositoryId: string, query: string): RepoWikiSearchHit[] { return this.memory.searchRepoWikiDocs({ repositoryId, query, limit: 10 }); }

  async refreshRepoWiki(repositoryId: string, localPath: string): Promise<{ indexed: number; removed: number }> {
    const existing = this.memory.listRepoWikiDocs(repositoryId);
    const byPath = new Map(existing.map((doc) => [doc.path, doc]));
    const files = collectRepoWikiDocs(localPath);
    let removed = 0;
    for (const doc of existing) {
      if (!files.some((file) => file.path === doc.path)) { this.memory.deleteRepoWikiDoc(doc.id); removed += 1; }
    }
    let indexed = 0;
    for (const file of files) {
      const prev = byPath.get(file.path);
      if (prev && prev.hash === file.hash) continue;
      this.memory.upsertRepoWikiDoc({ repositoryId, ...(prev ? { id: prev.id } : {}), path: file.path, title: file.title, content: file.content, mtime: file.mtime, hash: file.hash });
      indexed += 1;
    }
    return { indexed, removed };
  }

  async search(options: MemoryContextOptions): Promise<{ memories: MemorySearchHit[]; wikiDocs: RepoWikiSearchHit[] }> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const query = options.query.trim();
    const memories = query ? this.memory.searchMemories({ query, scopes: ["user", "conversation"], userId: options.userId, conversationId: options.conversationId, limit }) : [];
    const repoMemories: MemorySearchHit[] = [];
    const wikiDocs: RepoWikiSearchHit[] = [];
    for (const repositoryId of options.repositoryIds ?? []) {
      if (query) repoMemories.push(...this.memory.searchMemories({ query, scopes: ["repo"], repositoryId, limit: 3 }));
      wikiDocs.push(...this.memory.searchRepoWikiDocs({ repositoryId, query, limit: 3 }));
    }
    memories.push(...repoMemories);
    return {
      memories: memories.sort((a, b) => b.score - a.score).slice(0, limit),
      wikiDocs: wikiDocs.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit >> 1))
    };
  }

  async buildSystemPrompt(options: MemoryContextOptions): Promise<string | undefined> {
    const { memories, wikiDocs } = await this.search(options);
    return renderMemoryContext(memories, wikiDocs);
  }

  consolidateMemories(drafts: ExtractedMemoryDraft[], repositoryIds: string[], conversationId: string): number {
    let saved = 0;
    for (const draft of drafts) {
      const tags = draft.tags ?? [];
      if (draft.scope === "repo") {
        const primary = repositoryIds[0];
        if (!primary) continue;
        const userId = this.ensureUserId();
        if (this.memory.listMemories({ scope: "repo", repositoryId: primary }).some((m) => m.title.toLowerCase() === draft.title.toLowerCase())) continue;
        this.memory.createMemory({ scope: "repo", repositoryId: primary, userId, title: draft.title, content: draft.content, tags, pinned: false, importance: 0.5, source: "auto" });
      } else if (draft.scope === "user") {
        const userId = this.ensureUserId();
        if (this.memory.listMemories({ scope: "user", userId }).some((m) => m.title.toLowerCase() === draft.title.toLowerCase())) continue;
        this.memory.createMemory({ scope: "user", userId, title: draft.title, content: draft.content, tags, pinned: false, importance: 0.5, source: "auto" });
      } else {
        if (this.memory.listMemories({ scope: "conversation", conversationId }).some((m) => m.title.toLowerCase() === draft.title.toLowerCase())) continue;
        this.memory.createMemory({ scope: "conversation", conversationId, title: draft.title, content: draft.content, tags, pinned: false, importance: 0.5, source: "auto" });
      }
      saved += 1;
    }
    return saved;
  }
}
