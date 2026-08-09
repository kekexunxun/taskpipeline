import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatStorage } from "./chat-storage.js";
import type { ChatConversation, StoredMessageRecord } from "./chat-types.js";

const roots: string[] = [];
function temporaryRoot() {
  const root = join(tmpdir(), `task-pipeline-chat-${crypto.randomUUID()}`);
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function conversation(id = "chat-1"): ChatConversation {
  const now = new Date().toISOString();
  return {
    id,
    title: "测试",
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    model: "openai:default",
    driverId: "openai",
    messages: [
      {
        id: "message-1",
        role: "user",
        createdAt: now,
        driverId: "openai",
        raw: { kind: "user", text: "hello" }
      } satisfies StoredMessageRecord
    ]
  };
}

describe("ChatStorage v3", () => {
  it("writes conversation and index atomically in chats-v3", () => {
    const root = temporaryRoot();
    const storage = new ChatStorage(root);
    storage.saveConversation(conversation());
    const list = storage.listMetas();
    expect(list).toHaveLength(1);
    const stored = storage.getConversation("chat-1");
    expect(stored?.messages[0]).toMatchObject({ role: "user", driverId: "openai" });
    expect((stored?.messages[0]?.raw as { kind?: string; text?: string })?.text).toBe("hello");
    expect(existsSync(join(root, "chats-v3", "index.json"))).toBe(true);
    expect(readFileSync(join(root, "chats-v3", "index.json"), "utf8")).toContain('"version": 3');
  });

  it("ignores legacy v2 chats and malformed v3 files", () => {
    const root = temporaryRoot();
    // 旧 v2 目录与文件 — 必须被忽略
    mkdirSync(join(root, "chats-v2"), { recursive: true });
    writeFileSync(join(root, "chats-v2", "index.json"), JSON.stringify({ version: 2, conversations: [{ id: "legacy" }] }));
    const storage = new ChatStorage(root);
    expect(storage.listMetas()).toEqual([]);
    // v3 损坏文件 — 跳过
    mkdirSync(join(root, "chats-v3"), { recursive: true });
    writeFileSync(join(root, "chats-v3", "index.json"), "not-json");
    expect(storage.listMetas()).toEqual([]);
  });

  it("replaces messages and deletes only the selected conversation", () => {
    const root = temporaryRoot();
    const storage = new ChatStorage(root);
    storage.saveConversation(conversation("one"));
    storage.saveConversation(conversation("two"));
    storage.replaceMessages("one", [], { title: "empty" });
    expect(storage.getConversation("one")).toMatchObject({ title: "empty", messageCount: 0 });
    storage.deleteConversation("one");
    expect(storage.getConversation("one")).toBeUndefined();
    expect(storage.getConversation("two")).toBeDefined();
  });

  it("appends a message to an existing conversation", () => {
    const root = temporaryRoot();
    const storage = new ChatStorage(root);
    storage.saveConversation(conversation("c"));
    const appended = storage.appendMessage("c", {
      id: "message-2",
      role: "assistant",
      createdAt: new Date().toISOString(),
      driverId: "openai",
      raw: { kind: "assistant", parts: [{ driverId: "openai", type: "text", text: "hi back" }] }
    });
    expect(appended?.messages).toHaveLength(2);
    expect(appended?.messages[1]?.role).toBe("assistant");
    expect((appended?.messages[1]?.raw as { parts?: unknown[] })?.parts).toHaveLength(1);
  });

  it("round-trips driver raw without interpreting parts", () => {
    // 验证存储层完全不动 raw —— driver 自己解
    const root = temporaryRoot();
    const storage = new ChatStorage(root);
    const now = new Date().toISOString();
    const qoderRaw = {
      kind: "assistant",
      parts: [
        { driverId: "qoder", type: "qoder.thinking", text: "thinking..." },
        { driverId: "qoder", type: "qoder.tool-use", toolCallId: "tc-1", name: "createJiraIssue", input: { projectKey: "BSADAPT", summary: "x" } },
        { driverId: "qoder", type: "qoder.tool-result", toolCallId: "tc-1", output: { ok: true } }
      ],
      sessionId: "session-xyz"
    };
    storage.saveConversation({
      id: "qoder-1",
      title: "Qoder",
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      model: "qoder:claude-sonnet-4.5",
      driverId: "qoder",
      messages: [{ id: "m1", role: "assistant", createdAt: now, driverId: "qoder", raw: qoderRaw }]
    });
    const loaded = storage.getConversation("qoder-1");
    expect(loaded?.messages[0]?.raw).toEqual(qoderRaw); // 完全透传
  });
});
