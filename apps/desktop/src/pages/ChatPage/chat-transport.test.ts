import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type ChatStreamEvent } from "@/api";
import { ElectronChatTransport } from "./chat-transport";

const original = { start: api.startChatStream, abort: api.abortChat, listen: api.onChatStreamEvent };
afterEach(() => { api.startChatStream = original.start; api.abortChat = original.abort; api.onChatStreamEvent = original.listen; vi.restoreAllMocks(); });

describe("ElectronChatTransport", () => {
  it("subscribes before starting, filters foreign events, and closes on done", async () => {
    const order: string[] = []; let listener: ((event: ChatStreamEvent) => void) | undefined;
    api.onChatStreamEvent = (callback) => { order.push("subscribe"); listener = callback; return () => order.push("unsubscribe"); };
    api.startChatStream = vi.fn(async (input) => { order.push("start"); listener?.({ streamId: "foreign", chatId: input.chatId, chunk: { type: "text-delta", id: "text", delta: "bad" } }); listener?.({ streamId: input.streamId, chatId: input.chatId, chunk: { type: "text-delta", id: "text", delta: "ok" } }); listener?.({ streamId: input.streamId, chatId: input.chatId, done: true }); });
    const stream = await new ElectronChatTransport().sendMessages({ trigger: "submit-message", chatId: "chat-a", messageId: undefined, messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }], body: { model: "qoder:test" }, abortSignal: undefined });
    const reader = stream.getReader(); expect(await reader.read()).toMatchObject({ value: { type: "text-delta", delta: "ok" } }); expect((await reader.read()).done).toBe(true); expect(order).toEqual(["subscribe", "start", "unsubscribe"]);
  });

  it("aborts the matching stream when the signal is cancelled", async () => {
    let listener: ((event: ChatStreamEvent) => void) | undefined; api.onChatStreamEvent = (callback) => { listener = callback; return () => undefined; }; api.startChatStream = vi.fn(async () => undefined); api.abortChat = vi.fn(async () => undefined);
    const abort = new AbortController(); const stream = await new ElectronChatTransport().sendMessages({ trigger: "submit-message", chatId: "chat-a", messageId: undefined, messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }], body: { model: "qoder:test" }, abortSignal: abort.signal });
    abort.abort(); expect((await stream.getReader().read()).done).toBe(true); expect(api.abortChat).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat-a" })); expect(listener).toBeDefined();
  });

  it("unsubscribes immediately when the consumer cancels the stream", async () => {
    const unsubscribe = vi.fn();
    api.onChatStreamEvent = () => unsubscribe;
    api.startChatStream = vi.fn(async () => undefined);
    api.abortChat = vi.fn(async () => undefined);
    const stream = await new ElectronChatTransport().sendMessages({ trigger: "submit-message", chatId: "chat-a", messageId: undefined, messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }], body: { model: "qoder:test" }, abortSignal: undefined });
    await stream.cancel();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(api.abortChat).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat-a" }));
  });
});
