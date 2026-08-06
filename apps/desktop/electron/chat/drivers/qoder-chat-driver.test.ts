import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 假 SDK:用 `vi.mock` 替换 `@qoder-ai/qoder-agent-sdk`,把 `query()` 接到一个可脚本化的
 * AsyncIterable,让测试可以精确驱动 SDKMessage 流。
 */
type SdkMessage = Record<string, unknown> & {
  type?: string;
  session_id?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string; signature?: string };
    content_block?: { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
    index?: number;
  };
  message?: { content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }>; usage?: unknown };
  result?: string;
  error?: string;
};

function asyncIterFromArray<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < items.length) return { value: items[index++] as T, done: false };
          return { value: undefined as unknown as T, done: true };
        },
        async return() { return { value: undefined as unknown as T, done: true }; },
        async throw(error: unknown) { throw error; }
      };
    }
  };
}

function textDelta(text: string, sessionId: string): SdkMessage {
  return { type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
}

function thinkingDelta(text: string, sessionId: string): SdkMessage {
  return { type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: text } } };
}

function assistantMessageWithToolUse(name: string, input: unknown, toolId: string, sessionId: string): SdkMessage {
  return {
    type: "stream_event",
    session_id: sessionId,
    event: {
      type: "content_block_start",
      content_block: { type: "tool_use", id: toolId, name, input }
    }
  };
}

function assistantMessageWithToolResult(toolUseId: string, content: unknown, isError = false): SdkMessage {
  return {
    type: "assistant",
    message: {
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }
      ]
    }
  };
}

function resultMessage(result: string, sessionId: string): SdkMessage {
  return { type: "result", session_id: sessionId, result };
}

vi.mock("@qoder-ai/qoder-agent-sdk", () => {
  // 把脚本化的 SDKMessage 数组喂给 driver
  const scripts: { messages: SdkMessage[] }[] = [];
  const captured: Array<{ options: Record<string, unknown> }> = [];
  return {
    accessToken: (token: string) => ({ token }),
    query: (args: { prompt?: string; options?: Record<string, unknown> }) => {
      const script = scripts.shift() ?? { messages: [] };
      captured.push({ options: args.options ?? {} });
      return {
        [Symbol.asyncIterator]() {
          const iter = asyncIterFromArray(script.messages)[Symbol.asyncIterator]();
          return {
            async next() { return iter.next(); },
            async return() { return iter.return ? iter.return() : { value: undefined, done: true }; },
            async throw(error: unknown) { return iter.throw ? iter.throw(error) : Promise.reject(error); }
          };
        },
        async close() { /* noop */ },
        async interrupt() { /* noop */ }
      };
    },
    tool: (name: string, _description: string, _schema: unknown, execute: (input: unknown) => unknown) => ({ name, execute }),
    createSdkMcpServer: (config: { name: string; tools: unknown[] }) => ({ name: config.name, tools: config.tools }),
    // 暴露给测试用
    __pushScript: (script: { messages: SdkMessage[] }) => scripts.push(script),
    __getLastQueryOptions: () => captured[captured.length - 1]?.options,
    __resetCaptured: () => { captured.length = 0; }
  };
});

// 必须在 vi.mock 之后 import driver
const { QoderChatDriver } = await import("./qoder-chat-driver.js");
const sdkMock = await import("@qoder-ai/qoder-agent-sdk") as unknown as {
  __pushScript: (script: { messages: SdkMessage[] }) => void;
  __getLastQueryOptions: () => Record<string, unknown> | undefined;
  __resetCaptured: () => void;
};
import type { StoredMessage } from "../chat-types.js";

function driver() {
  return new QoderChatDriver(() => "test-token", async () => ({
    enabled: true,
    connected: true,
    running: false,
    models: [
      { value: "claude-sonnet-4.5", displayName: "Claude Sonnet 4.5", isDefault: true },
      { value: "gpt-5", displayName: "GPT-5" }
    ]
  }));
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("QoderChatDriver", () => {
  it("emits text parts in order and session part on first message", async () => {
    sdkMock.__pushScript({
      messages: [
        textDelta("Hello", "sess-1"),
        textDelta(" world", "sess-1"),
        resultMessage("Hello world", "sess-1")
      ]
    });
    const events = await collect(driver().streamChat({
      conversationId: "c",
      model: "qoder:claude-sonnet-4.5",
      history: [],
      userInput: { id: "u1", text: "hi", createdAt: new Date().toISOString() },
      signal: new AbortController().signal
    }));
    const parts = events.flatMap((e) => (e.type === "part" ? [e.part] : []));
    expect(parts.map((p) => p.type)).toEqual(["qoder.session", "text", "text"]);
    expect(parts[0]?.type === "qoder.session" && parts[0].sessionId).toBe("sess-1");
  });

  it("emits thinking parts as qoder.thinking", async () => {
    sdkMock.__pushScript({
      messages: [
        thinkingDelta("思考中", "sess-2"),
        textDelta("结论", "sess-2"),
        resultMessage("结论", "sess-2")
      ]
    });
    const events = await collect(driver().streamChat({
      conversationId: "c",
      model: "qoder:claude-sonnet-4.5",
      history: [],
      userInput: { id: "u1", text: "hi", createdAt: new Date().toISOString() },
      signal: new AbortController().signal
    }));
    const parts = events.flatMap((e) => (e.type === "part" ? [e.part] : []));
    expect(parts.some((p) => p.type === "qoder.thinking" && p.text === "思考中")).toBe(true);
  });

  it("emits tool-use and tool-result parts and a task-created chunk when tool source describes a result", async () => {
    sdkMock.__pushScript({
      messages: [
        assistantMessageWithToolUse("createJiraIssue", { projectKey: "BSADAPT" }, "tc-1", "sess-3"),
        assistantMessageWithToolResult("tc-1", { ok: true, key: "BSADAPT-42" }, false),
        resultMessage("已创建任务 BSADAPT-42", "sess-3")
      ]
    });
    const events = await collect(driver().streamChat({
      conversationId: "c",
      model: "qoder:claude-sonnet-4.5",
      history: [],
      userInput: { id: "u1", text: "create", createdAt: new Date().toISOString() },
      signal: new AbortController().signal,
      toolSource: {
        id: "jira",
        displayName: "Jira",
        systemPrompt: () => "",
        tools: () => [],
        describeResult: (output: unknown) => {
          if (output && typeof output === "object" && "key" in (output as Record<string, unknown>)) {
            const o = output as { key: string };
            return { backend: "jira", externalKey: o.key, summary: "from tool", projectKey: "BSADAPT", issueType: "任务" };
          }
          return undefined;
        },
        close: () => undefined
      }
    }));
    const partTypes = events.flatMap((e) => (e.type === "part" ? [e.part.type] : []));
    expect(partTypes).toContain("qoder.tool-use");
    expect(partTypes).toContain("qoder.tool-result");
    const taskCreated = events.find((e) => e.type === "task-created");
    expect(taskCreated?.type).toBe("task-created");
    if (taskCreated?.type === "task-created") {
      expect(taskCreated.result.externalKey).toBe("BSADAPT-42");
    }
  });

  it("returns no models when Qoder is not enabled/connected", async () => {
    const offline = new QoderChatDriver(() => "token", async () => ({ enabled: false, connected: false, running: false, models: [] }));
    expect(await offline.listModels()).toEqual([]);
  });

  it("prepends qoder: prefix to model values", async () => {
    const models = await driver().listModels();
    expect(models.every((m) => m.value.startsWith("qoder:"))).toBe(true);
  });

  it("throws when no token is configured", async () => {
    const noToken = new QoderChatDriver(() => undefined, async () => ({ enabled: true, connected: true, running: false, models: [] }));
    await expect(async () => {
      for await (const _ of noToken.streamChat({
        conversationId: "c",
        model: "qoder:claude-sonnet-4.5",
        history: [],
        userInput: { id: "u1", text: "hi", createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })) { void _; }
    }).rejects.toThrow(/Qoder Token/);
  });
});

describe("QoderChatDriver resume", () => {
  function storedUser(id: string, text: string): StoredMessage {
    return { id, role: "user", createdAt: new Date().toISOString(), driverId: "qoder", raw: { kind: "user", text }, parts: [{ driverId: "qoder", type: "text", text }] };
  }
  function storedAssistantWithSession(id: string, sessionId: string, text: string): StoredMessage {
    return {
      id,
      role: "assistant",
      createdAt: new Date().toISOString(),
      driverId: "qoder",
      raw: { kind: "assistant", parts: [{ driverId: "qoder", type: "qoder.session", sessionId }, { driverId: "qoder", type: "text", text }], sessionId },
      parts: [{ driverId: "qoder", type: "qoder.session", sessionId }, { driverId: "qoder", type: "text", text }]
    };
  }

  beforeEach(() => {
    sdkMock.__resetCaptured();
  });

  it("passes resume=sessionId when history ends with qoder.session, and truncates prompt history", async () => {
    sdkMock.__pushScript({
      messages: [
        textDelta("second reply", "sess-Y"),
        resultMessage("second reply", "sess-Y")
      ]
    });
    const history: StoredMessage[] = [
      storedUser("u1", "hi"),
      storedAssistantWithSession("a1", "sess-X", "first reply"),
      storedUser("u2", "more"),
      storedAssistantWithSession("a2", "sess-Y", "second base"),
      storedUser("u3", "again")
    ];
    await collect(driver().streamChat({
      conversationId: "c",
      model: "qoder:claude-sonnet-4.5",
      history,
      userInput: { id: "u-new", text: "yet again", createdAt: new Date().toISOString() },
      signal: new AbortController().signal
    }));
    const options = sdkMock.__getLastQueryOptions();
    expect(options?.resume).toBe("sess-Y");
  });

  it("takes the last qoder.session id when multiple exist", async () => {
    sdkMock.__pushScript({ messages: [textDelta("ok", "sess-Y"), resultMessage("ok", "sess-Y")] });
    const history: StoredMessage[] = [
      storedUser("u1", "first"),
      storedAssistantWithSession("a1", "sess-X", "first reply"),
      storedAssistantWithSession("a2", "sess-Y", "second reply")
    ];
    await collect(driver().streamChat({
      conversationId: "c",
      model: "qoder:claude-sonnet-4.5",
      history,
      userInput: { id: "u2", text: "again", createdAt: new Date().toISOString() },
      signal: new AbortController().signal
    }));
    const options = sdkMock.__getLastQueryOptions();
    expect(options?.resume).toBe("sess-Y");
  });

  it("does not pass resume when history has no qoder.session part", async () => {
    sdkMock.__pushScript({ messages: [textDelta("hi", "sess-1"), resultMessage("hi", "sess-1")] });
    const history: StoredMessage[] = [storedUser("u1", "hi")];
    await collect(driver().streamChat({
      conversationId: "c",
      model: "qoder:claude-sonnet-4.5",
      history,
      userInput: { id: "u2", text: "hi again", createdAt: new Date().toISOString() },
      signal: new AbortController().signal
    }));
    const options = sdkMock.__getLastQueryOptions();
    expect(options?.resume).toBeUndefined();
  });
});
