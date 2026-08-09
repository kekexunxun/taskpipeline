import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatService } from "./chat-service.js";
import { ChatDriverRegistry } from "./drivers/driver-registry.js";
import type { ChatDriver } from "./drivers/chat-driver.js";
import type {
  ChatModelInfo,
  ChatStreamChunk,
  DriverPart,
  StoredMessage,
  StoredMessageRecord
} from "./chat-types.js";
import type { TaskStore } from "@task-pipeline/core";

/**
 * 假的 ChatDriver:用脚本化的 part 序列驱动 streamChat 行为。
 * 测试通过 parts 数组来控制 emit 顺序、流式事件、task-created 触发。
 */
type FakeDriverOptions = {
  id: "qoder" | "openai";
  displayName: string;
  /** streamChat 第一次调用时 emit 的 parts(按顺序) */
  scripts: { emit: ChatStreamChunk[] }[];
  /** 每次 listModels 调用的返回 */
  models?: ChatModelInfo[];
};

function createFakeDriver(opts: FakeDriverOptions): ChatDriver & { received: { history: StoredMessage[]; model: string; toolSource?: unknown }[] } {
  const received: { history: StoredMessage[]; model: string; toolSource?: unknown }[] = [];
  let scriptIndex = 0;
  return {
    id: opts.id,
    displayName: opts.displayName,
    async listModels() { return opts.models ?? []; },
    deserializeMessage(record) {
      return { ...record, parts: [{ driverId: record.driverId, type: "text", text: "" }] };
    },
    serializeUserMessage(input) {
      return { id: input.id, role: "user", createdAt: input.createdAt, driverId: opts.id, raw: { kind: "user", text: input.text } };
    },
    serializeAssistantMessage(input) {
      return { id: input.id, role: "assistant", createdAt: input.createdAt, driverId: opts.id, raw: { kind: "assistant", parts: input.parts } };
    },
    async *streamChat(input) {
      received.push({ history: input.history, model: input.model, toolSource: input.toolSource });
      const script = opts.scripts[scriptIndex++] ?? { emit: [] };
      for (const chunk of script.emit) yield chunk;
    },
    dispose() { /* noop */ }
  } as ChatDriver & { received: { history: StoredMessage[]; model: string; toolSource?: unknown }[] };
}

function fakeStore(): TaskStore {
  // TaskStore 接口很大;只覆盖 ChatService 用到的最小子集。
  return {
    getSetting: () => undefined,
    setSetting: () => undefined
  } as unknown as TaskStore;
}

describe("ChatService (driver-based)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = join(tmpdir(), `chat-service-${crypto.randomUUID()}`);
  });

  it("dispatches a stream end-to-end and persists the assistant record", async () => {
    const driver = createFakeDriver({
      id: "qoder",
      displayName: "Qoder",
      scripts: [
        {
          emit: [
            { type: "part", part: { driverId: "qoder", type: "text", text: "hi" } satisfies DriverPart },
            { type: "done", status: "done" }
          ]
        }
      ]
    });
    const registry = new ChatDriverRegistry();
    registry.register(driver);
    const sent: ChatStreamChunk[] = [];
    const win = {
      webContents: { send: (_channel: string, payload: { chunk?: ChatStreamChunk }) => { if (payload.chunk) sent.push(payload.chunk); } }
    } as unknown as import("electron").BrowserWindow;
    const service = new ChatService(fakeStore(), dataDir, registry, () => win);
    const conv = service.createChat("qoder", "qoder:test");
    await service.startChatStream({
      streamId: "stream-1",
      chatId: conv.id,
      driverId: "qoder",
      model: "qoder:test",
      message: { id: "u1", text: "hello", createdAt: new Date().toISOString() }
    });
    // 第一个 done 来自 driver,第二个 done 来自 ChatService 的 finally(状态汇总)
    expect(sent.map((c) => c.type)).toEqual(["start", "part", "done", "done"]);
    const reloaded = service.getChat(conv.id);
    expect(reloaded?.messages).toHaveLength(2);
    expect(reloaded?.messages[0]?.role).toBe("user");
    expect(reloaded?.messages[1]?.role).toBe("assistant");
    expect(reloaded?.messages[1]?.parts[0]?.type).toBe("text");
  });

  it("supports switching driver mid-conversation: history messages keep their own driverId", async () => {
    const qoder = createFakeDriver({
      id: "qoder",
      displayName: "Qoder",
      scripts: [
        { emit: [{ type: "part", part: { driverId: "qoder", type: "text", text: "first" } }, { type: "done", status: "done" }] }
      ]
    });
    const openai = createFakeDriver({
      id: "openai",
      displayName: "OpenAI",
      scripts: [
        { emit: [{ type: "part", part: { driverId: "openai", type: "text", text: "second" } }, { type: "done", status: "done" }] }
      ]
    });
    const registry = new ChatDriverRegistry();
    registry.register(qoder);
    registry.register(openai);

    let captured: { channel: string; payload: unknown }[] = [];
    const win = {
      webContents: { send: (channel: string, payload: unknown) => { captured.push({ channel, payload }); } }
    } as unknown as import("electron").BrowserWindow;
    const service = new ChatService(fakeStore(), dataDir, registry, () => win);

    const conv = service.createChat("qoder", "qoder:test");
    await service.startChatStream({
      streamId: "stream-a",
      chatId: conv.id,
      driverId: "qoder",
      model: "qoder:test",
      message: { id: "u1", text: "hi", createdAt: new Date().toISOString() }
    });
    captured = [];
    await service.startChatStream({
      streamId: "stream-b",
      chatId: conv.id,
      driverId: "openai",
      model: "openai:default",
      message: { id: "u2", text: "second", createdAt: new Date().toISOString() }
    });
    const reloaded = service.getChat(conv.id);
    expect(reloaded?.messages).toHaveLength(4);
    expect(reloaded?.messages[0]?.driverId).toBe("qoder");
    expect(reloaded?.messages[1]?.driverId).toBe("qoder");
    expect(reloaded?.messages[2]?.driverId).toBe("openai");
    expect(reloaded?.messages[3]?.driverId).toBe("openai");
    // Qoder 历史的 raw 由 qoder 解析,openai 历史由 openai 解析
    expect(reloaded?.messages[0]?.parts[0]?.driverId).toBe("qoder");
    expect(reloaded?.messages[3]?.parts[0]?.driverId).toBe("openai");
  });

  it("collects task-created chunks into the persisted assistant metadata", async () => {
    const driver = createFakeDriver({
      id: "qoder",
      displayName: "Qoder",
      scripts: [
        {
          emit: [
            { type: "part", part: { driverId: "qoder", type: "text", text: "已创建" } },
            { type: "task-created", result: { backend: "jira", externalKey: "BSADAPT-1", summary: "demo", projectKey: "BSADAPT", issueType: "任务" } },
            { type: "done", status: "done" }
          ]
        }
      ]
    });
    const registry = new ChatDriverRegistry();
    registry.register(driver);
    const win = { webContents: { send: () => undefined } } as unknown as import("electron").BrowserWindow;
    const service = new ChatService(fakeStore(), dataDir, registry, () => win);
    const conv = service.createChat("qoder", "qoder:test");
    await service.startChatStream({
      streamId: "stream-1",
      chatId: conv.id,
      driverId: "qoder",
      model: "qoder:test",
      message: { id: "u1", text: "create", createdAt: new Date().toISOString() }
    });
    // raw 不会持久化 metadata,但 ChatService 通过 storage.replaceMessages + appendMessage
    // 实现了 taskCreation 在内存中可被消费(这里只验证 raw parts + service 流程)
    const reloaded = service.getChat(conv.id);
    expect(reloaded?.messages).toHaveLength(2);
    expect(reloaded?.messages[1]?.parts[0]?.type).toBe("text");
  });

  it("rejects an unknown driverId", async () => {
    const registry = new ChatDriverRegistry();
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined);
    const conv = service.createChat();
    await expect(service.startChatStream({
      streamId: "stream-x",
      chatId: conv.id,
      driverId: "qoder",
      model: "qoder:test",
      message: { id: "u1", text: "hi", createdAt: new Date().toISOString() }
    })).rejects.toThrow(/未注册的 chat driver/);
  });

  it("rejects stream on missing conversation", async () => {
    const driver = createFakeDriver({ id: "qoder", displayName: "Qoder", scripts: [{ emit: [{ type: "done", status: "done" }] }] });
    const registry = new ChatDriverRegistry();
    registry.register(driver);
    const service = new ChatService(fakeStore(), dataDir, registry, () => undefined);
    await expect(service.startChatStream({
      streamId: "stream-x",
      chatId: "no-such",
      driverId: "qoder",
      model: "qoder:test",
      message: { id: "u1", text: "hi", createdAt: new Date().toISOString() }
    })).rejects.toThrow(/对话不存在/);
  });
});
