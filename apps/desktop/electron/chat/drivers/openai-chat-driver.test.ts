import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@task-pipeline/core";

/**
 * 假 ai-sdk streamText:用 `vi.mock` 替换 `ai`,把 `streamText().fullStream` 接到一个可脚本化的
 * AsyncIterable,让测试可以精确驱动 streamText 的 chunk 序列。
 */
type StreamChunk = { type: string; [key: string]: unknown };

vi.mock("ai", () => {
  // 每个测试通过 __pushStreamScript 推入一段 chunk 脚本
  const scripts: { chunks: StreamChunk[] }[] = [];
  return {
    streamText: () => {
      const script = scripts.shift() ?? { chunks: [] };
      return {
        fullStream: (async function* () {
          for (const chunk of script.chunks) yield chunk;
        })()
      };
    },
    stepCountIs: (n: number) => ({ __stepCount: n }),
    tool: (config: unknown) => config,
    // 暴露给测试用
    __pushStreamScript: (s: { chunks: StreamChunk[] }) => scripts.push(s)
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => ({
    chatModel: () => ({ modelId: "fake-model" })
  })
}));

// 必须在 vi.mock 之后 import driver
const { OpenAIChatDriver } = await import("./openai-chat-driver.js");
const aiMock = (await import("ai")) as unknown as {
  __pushStreamScript: (s: { chunks: StreamChunk[] }) => void;
};

function fakeStore(profile?: { baseUrl: string; model: string; displayName?: string; apiKeyEnv?: string }): TaskStore {
  return {
    getSetting: (key: string) => {
      if (key === "modelProfile" && profile) return JSON.stringify(profile);
      return undefined;
    },
    setSetting: () => undefined
  } as unknown as TaskStore;
}

function driver(opts: { profile?: { baseUrl: string; model: string; displayName?: string; apiKeyEnv?: string }; apiKey?: string } = {}) {
  return new OpenAIChatDriver(
    fakeStore(opts.profile),
    () => opts.apiKey
  );
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("OpenAIChatDriver", () => {
  it("emits text parts in order from fullStream", async () => {
    aiMock.__pushStreamScript({ chunks: [
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" }
    ]});
    const events = await collect(driver({ profile: { baseUrl: "https://api.example.com", model: "gpt-5" } }).streamChat({
      conversationId: "c",
      model: "openai:default",
      history: [],
      userInput: { id: "u1", text: "hi", createdAt: new Date().toISOString() },
      signal: new AbortController().signal
    }));
    const parts = events.flatMap((e) => (e.type === "part" ? [e.part] : []));
    expect(parts.map((p) => p.type)).toEqual(["text", "text"]);
    expect(parts.map((p) => (p.type === "text" ? p.text : ""))).toEqual(["Hello", " world"]);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
  });

  it("emits openai.tool-call when streamText reports a tool-call chunk", async () => {
    aiMock.__pushStreamScript({ chunks: [
      { type: "tool-call", toolCallId: "tc-1", toolName: "createJiraIssue", input: { projectKey: "BSADAPT" } }
    ]});
    const events = await collect(driver({ profile: { baseUrl: "https://api.example.com", model: "gpt-5" } }).streamChat({
      conversationId: "c",
      model: "openai:default",
      history: [],
      userInput: { id: "u1", text: "create", createdAt: new Date().toISOString() },
      signal: new AbortController().signal
    }));
    const parts = events.flatMap((e) => (e.type === "part" ? [e.part] : []));
    const toolCallPart = parts.find((p) => p.type === "openai.tool-call");
    expect(toolCallPart).toBeDefined();
    if (toolCallPart?.type === "openai.tool-call") {
      expect(toolCallPart.name).toBe("createJiraIssue");
      expect(toolCallPart.toolCallId).toBe("tc-1");
    }
  });

  it("emits openai.tool-result and a task-created chunk when tool source describes the output", async () => {
    aiMock.__pushStreamScript({ chunks: [
      { type: "tool-call", toolCallId: "tc-1", toolName: "createJiraIssue", input: { projectKey: "BSADAPT" } },
      { type: "tool-result", toolCallId: "tc-1", output: { key: "BSADAPT-99" } }
    ]});
    const events = await collect(driver({
      profile: { baseUrl: "https://api.example.com", model: "gpt-5" }
    }).streamChat({
      conversationId: "c",
      model: "openai:default",
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
    const parts = events.flatMap((e) => (e.type === "part" ? [e.part] : []));
    expect(parts.some((p) => p.type === "openai.tool-call")).toBe(true);
    expect(parts.some((p) => p.type === "openai.tool-result")).toBe(true);
    const taskCreated = events.find((e) => e.type === "task-created");
    expect(taskCreated?.type).toBe("task-created");
    if (taskCreated?.type === "task-created") {
      expect(taskCreated.result.externalKey).toBe("BSADAPT-99");
    }
  });

  it("returns no model when profile is missing", async () => {
    const d = driver();
    expect(await d.listModels()).toEqual([]);
  });

  it("returns the configured model when profile is set", async () => {
    const models = await driver({ profile: { baseUrl: "https://api.example.com", model: "gpt-5", displayName: "GPT-5" } }).listModels();
    expect(models).toEqual([{ value: "openai:default", displayName: "GPT-5", isDefault: true }]);
  });

  it("throws when streamChat is called without a profile", async () => {
    await expect(async () => {
      for await (const _ of driver().streamChat({
        conversationId: "c",
        model: "openai:default",
        history: [],
        userInput: { id: "u1", text: "hi", createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })) { void _; }
    }).rejects.toThrow(/未配置/);
  });

  it("rejects an unknown model value", async () => {
    await expect(async () => {
      for await (const _ of driver({ profile: { baseUrl: "https://api.example.com", model: "gpt-5" } }).streamChat({
        conversationId: "c",
        model: "openai:other",
        history: [],
        userInput: { id: "u1", text: "hi", createdAt: new Date().toISOString() },
        signal: new AbortController().signal
      })) { void _; }
    }).rejects.toThrow(/未知的 OpenAI 模型/);
  });

  it("deserializeMessage returns text parts for user/system and pass-through parts for assistant", () => {
    const d = driver();
    const userMsg = d.deserializeMessage({
      id: "u1", role: "user", createdAt: "t", driverId: "openai",
      raw: { kind: "user", text: "hi" }
    });
    expect(userMsg.parts[0]?.type).toBe("text");
    if (userMsg.parts[0]?.type === "text") {
      expect(userMsg.parts[0].text).toBe("hi");
    }

    const assistantMsg = d.deserializeMessage({
      id: "a1", role: "assistant", createdAt: "t", driverId: "openai",
      raw: { kind: "assistant", parts: [
        { driverId: "openai", type: "text", text: "hi" }
      ] }
    });
    expect(assistantMsg.parts[0]?.type).toBe("text");
  });
});
