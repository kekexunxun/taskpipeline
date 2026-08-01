import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatStorage } from "./chat-storage.js";
import type { ChatConversation } from "./chat-types.js";

const roots: string[] = [];
function temporaryRoot() { const root = join(tmpdir(), `coding-agent-chat-${crypto.randomUUID()}`); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function conversation(id = "chat-1"): ChatConversation { const now = new Date().toISOString(); return { id, title: "测试", createdAt: now, updatedAt: now, messageCount: 1, model: "openai:default", provider: "openai", messages: [{ id: "message-1", role: "user", metadata: { createdAt: now, status: "done" }, parts: [{ type: "text", text: "hello" }] }] }; }

describe("ChatStorage v2", () => {
  it("writes conversation and index atomically in chats-v2", () => {
    const root = temporaryRoot(); const storage = new ChatStorage(root); storage.saveConversation(conversation());
    expect(storage.listMetas()).toHaveLength(1); expect(storage.getConversation("chat-1")?.messages[0]?.parts[0]).toMatchObject({ type: "text", text: "hello" });
    expect(existsSync(join(root, "chats-v2", "index.json"))).toBe(true);
    expect(readFileSync(join(root, "chats-v2", "index.json"), "utf8")).toContain('"version": 2');
  });

  it("ignores legacy chats and malformed v2 files", () => {
    const root = temporaryRoot(); mkdirSync(join(root, "chats"), { recursive: true }); writeFileSync(join(root, "chats", "_index.jsonl"), JSON.stringify({ id: "legacy" }));
    const storage = new ChatStorage(root); expect(storage.listMetas()).toEqual([]);
    mkdirSync(join(root, "chats-v2"), { recursive: true }); writeFileSync(join(root, "chats-v2", "index.json"), "not-json");
    expect(storage.listMetas()).toEqual([]);
  });

  it("replaces messages and deletes only the selected conversation", () => {
    const root = temporaryRoot(); const storage = new ChatStorage(root); storage.saveConversation(conversation("one")); storage.saveConversation(conversation("two"));
    storage.replaceMessages("one", [], { title: "empty" }); expect(storage.getConversation("one")).toMatchObject({ title: "empty", messageCount: 0 });
    storage.deleteConversation("one"); expect(storage.getConversation("one")).toBeUndefined(); expect(storage.getConversation("two")).toBeDefined();
  });
});
