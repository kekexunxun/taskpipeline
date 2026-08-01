import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { TaskStore } from "@coding-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "./chat-llm.js";
import { ChatService } from "./chat-service.js";
import type { ChatMessage, ChatStreamEvent } from "./chat-types.js";

vi.mock("./chat-llm.js", () => ({ streamChat: vi.fn() }));

const streamChatMock = vi.mocked(streamChat);
const directories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "desktop-chat-service-"));
  directories.push(directory);
  const send = vi.fn();
  const store = { getSetting: vi.fn(() => undefined) } as unknown as TaskStore;
  const service = new ChatService(
    store,
    directory,
    async () => ({ enabled: true, connected: true, running: false, models: [] }),
    () => "qoder-token",
    () => undefined,
    () => ({ webContents: { send } }) as unknown as BrowserWindow
  );
  const conversation = service.createChat("qoder:test-model");
  const message: ChatMessage = { id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] };
  const input = { streamId: "stream-1", chatId: conversation.id, model: "qoder:test-model", message };
  const events = () => send.mock.calls.filter(([channel]) => channel === "chat:stream-event").map(([, event]) => event as ChatStreamEvent);
  return { service, conversation, input, events };
}

beforeEach(() => streamChatMock.mockReset());
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe("ChatService", () => {
  it("reuses the newest empty conversation instead of creating another", () => {
    const { service, conversation } = setup();
    expect(service.createChat("qoder:another-model").id).toBe(conversation.id);
  });

  it("creates a new conversation after the current one has messages", async () => {
    streamChatMock.mockImplementation(async function* () { yield { type: "delta", delta: "world" }; });
    const { service, conversation, input } = setup();
    await service.startChatStream(input);
    expect(service.createChat("qoder:another-model").id).not.toBe(conversation.id);
  });

  it("persists a completed assistant response", async () => {
    streamChatMock.mockImplementation(async function* () { yield { type: "delta", delta: "world" }; yield { type: "done" }; });
    const { service, conversation, input, events } = setup();
    await service.startChatStream(input);
    const saved = service.getChat(conversation.id)!;
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[1]).toMatchObject({ role: "assistant", metadata: { status: "done", model: "test-model" }, parts: [{ type: "text", text: "world" }] });
    expect(events().at(-1)).toMatchObject({ streamId: "stream-1", chatId: conversation.id, done: true });
  });

  it.each([
    ["empty response", async function* () { yield { type: "done" as const }; }, "模型返回了空响应"],
    ["provider error", async function* () { throw new Error("provider unavailable"); }, "provider unavailable"]
  ])("persists an error for %s", async (_label, implementation, expectedError) => {
    streamChatMock.mockImplementation(implementation);
    const { service, conversation, input, events } = setup();
    await service.startChatStream(input);
    expect(service.getChat(conversation.id)!.messages[1]).toMatchObject({ metadata: { status: "error" }, parts: [{ type: "text", text: "" }] });
    expect(events().some((event) => event.chunk?.type === "error" && event.chunk.errorText === expectedError)).toBe(true);
  });

  it("cleans up and persists an error when model resolution fails", async () => {
    const { service, conversation, input, events } = setup();
    await service.startChatStream({ ...input, model: "unknown:model" });
    expect(streamChatMock).not.toHaveBeenCalled();
    expect(service.getChat(conversation.id)!.messages[1]?.metadata?.status).toBe("error");
    expect(events().at(-1)?.done).toBe(true);
  });

  it("keeps partial text and marks it aborted when stopped", async () => {
    let release: () => void = () => undefined;
    streamChatMock.mockImplementation(async function* () {
      yield { type: "delta", delta: "partial" };
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const { service, conversation, input, events } = setup();
    const running = service.startChatStream(input);
    await vi.waitFor(() => expect(events().some((event) => event.chunk?.type === "text-delta")).toBe(true));
    service.abortChat({ streamId: input.streamId, chatId: input.chatId });
    release();
    await running;
    expect(service.getChat(conversation.id)!.messages[1]).toMatchObject({ metadata: { status: "aborted" }, parts: [{ type: "text", text: "partial" }] });
    expect(events().some((event) => event.chunk?.type === "abort")).toBe(true);
  });
});
