/**
 * OpenAI Chat Driver — ChatDriver 的 @ai-sdk/openai-compatible 实现。
 *
 * 职责(全部封在本文件内):
 *  - listModels: 从系统设置中的 modelProfile (`{ baseUrl, model, displayName, apiKeyEnv }`) 读出可用模型;
 *  - streamChat: 调 `streamText`,把 `ModelMessage` 流拆成 DriverPart (text / openai.tool-call / openai.tool-result);
 *  - 工具注入:把 `ToolSource` 翻译成 ai-sdk `tool({...})`,由 ai-sdk 调度执行;
 *  - 任务已创建:每次工具执行后调 `ToolSource.describeResult(output)`,有结果就调
 *    `onTaskCreated` 回调 (并 emit openai.tool-result part);
 *  - 持久化:raw 字段存 ai-sdk 自己的"原样"消息列表(driver 内部累积,流结束一次性 dump)。
 *
 * 上层 (ChatService) 完全不感知 ai-sdk 协议。
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, tool as aiTool, type ModelMessage } from "ai";
import { z } from "zod";
import type { TaskStore } from "@coding-agent/core";
import type { ChatDriver, StreamChatInput } from "./chat-driver.js";
import type { ToolSource } from "./tool-source.js";
import type { ChatModelInfo, ChatStreamChunk, ChatTaskCreationResult, DriverPart, StoredMessage, StoredMessageRecord } from "../chat-types.js";

type OpenAITokenProvider = () => string | undefined;

type OpenAIProfile = {
  baseUrl?: string;
  model?: string;
  displayName?: string;
  apiKeyEnv?: string;
};

/**
 * OpenAI driver 自己的 raw 形态(给存储层用):
 *  - 用户消息: `{ kind: "user", text: string }`;
 *  - 助手消息: `{ kind: "assistant", parts: DriverPart[] }` —— parts 与 DriverPart 完全一致,driver 加载时直接透传;
 *  - 系统消息: `{ kind: "system", text: string }`。
 */
type OpenAIRawMessage =
  | { kind: "user"; text: string }
  | { kind: "assistant"; parts: DriverPart[] }
  | { kind: "system"; text: string };

function rawToParts(raw: unknown): DriverPart[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as OpenAIRawMessage;
  if (record.kind === "user" || record.kind === "system") return [{ driverId: "openai", type: "text", text: record.text }];
  if (record.kind === "assistant" && Array.isArray(record.parts)) return record.parts;
  return [];
}

function readProfile(store: TaskStore): OpenAIProfile | undefined {
  const raw = store.getSetting("modelProfile");
  if (!raw) return undefined;
  try { return JSON.parse(raw) as OpenAIProfile; } catch { return undefined; }
}

/**
 * 把 ToolSource 的声明翻译成 ai-sdk `tool({...})`。
 *  - `schema` 是单层 record,需要 `z.object(...)` 包装;
 *  - `execute` 直接调 ToolDeclaration.execute(driver 不知道业务含义);
 *  - `description` / `annotations` 直接透传。
 */
function buildAiTools(source: ToolSource): Record<string, ReturnType<typeof aiTool>> {
  const tools: Record<string, ReturnType<typeof aiTool>> = {};
  for (const decl of source.tools()) {
    // ai-sdk 的 `tool` 是强类型函数,需要把 schema 转成具体 zod object。
    // ToolDeclaration.schema 是单层 record (`z.object` 已经拆好字段),
    // 这里组合一次给 ai-sdk。schema 的实际形态在运行时由 driver 决定,
    // 静态类型统一为 unknown,driver 内部不再做 type-level 推断。
    const built = aiTool({
      description: decl.description,
      inputSchema: z.object(decl.schema as unknown as Record<string, z.ZodTypeAny>) as never,
      execute: async (input) => decl.execute(input as Record<string, unknown>)
    });
    tools[decl.name] = built as unknown as ReturnType<typeof aiTool>;
  }
  return tools;
}

/**
 * 把 driver 的 history (StoredMessage[]) 转成 ai-sdk `ModelMessage[]`。
 *  - driver 切换时,qoder 的 parts 会以纯文本形式降级(只取 text parts);
 *  - openai 自己的 tool-use / tool-result parts 转成 ai-sdk 的 ToolModelMessage。
 */
function historyToModelMessages(history: StoredMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of history) {
    if (message.role === "system") {
      const text = message.parts.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join("\n");
      if (text) out.push({ role: "system", content: text });
      continue;
    }
    if (message.role === "user") {
      const text = message.parts.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join("\n");
      if (text) out.push({ role: "user", content: text });
      continue;
    }
    // assistant
    const openaiParts = message.parts.filter((p) => p.driverId === "openai");
    const text = openaiParts.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join("");
    const toolCalls = openaiParts.filter((p): p is Extract<DriverPart, { type: "openai.tool-call" }> => p.type === "openai.tool-call");
    if (toolCalls.length) {
      out.push({
        role: "assistant",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...toolCalls.map((tc) => ({ type: "tool-call" as const, toolCallId: tc.toolCallId, toolName: tc.name, input: tc.input }))
        ]
      });
    } else if (text) {
      out.push({ role: "assistant", content: text });
    }
    // 跟在这个 assistant 后面的 openai tool-result parts,转成 tool 消息
    const toolResults = openaiParts.filter((p): p is Extract<DriverPart, { type: "openai.tool-result" }> => p.type === "openai.tool-result");
    const correspondingCalls = new Map<string, string>();
    for (const tc of openaiParts.filter((p): p is Extract<DriverPart, { type: "openai.tool-call" }> => p.type === "openai.tool-call")) {
      correspondingCalls.set(tc.toolCallId, tc.name);
    }
    if (toolResults.length) {
      const toolMessage: ModelMessage = {
        role: "tool",
        content: toolResults.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: correspondingCalls.get(tr.toolCallId) ?? "tool",
          output: { type: "json" as const, value: tr.output as never }
        }))
      };
      out.push(toolMessage);
    }
  }
  return out;
}

/**
 * OpenAI Chat Driver。
 */
export class OpenAIChatDriver implements ChatDriver {
  readonly id = "openai" as const;
  readonly displayName = "OpenAI-Compatible";

  constructor(private readonly store: TaskStore, private readonly getApiKey: OpenAITokenProvider) {
    if (!store) throw new Error("OpenAIChatDriver requires a TaskStore");
    if (!getApiKey) throw new Error("OpenAIChatDriver requires an api key provider");
  }

  async listModels(): Promise<ChatModelInfo[]> {
    const profile = readProfile(this.store);
    if (!profile?.baseUrl || !profile.model) return [];
    const isDefault = true; // OpenAI model 是用户显式配置的,默认选中
    return [{
      value: "openai:default",
      displayName: profile.displayName || profile.model,
      isDefault
    }];
  }

  serializeUserMessage(input: { id: string; text: string; createdAt: string }): StoredMessageRecord {
    return {
      id: input.id,
      role: "user",
      createdAt: input.createdAt,
      driverId: "openai",
      raw: { kind: "user", text: input.text } satisfies OpenAIRawMessage
    };
  }

  serializeAssistantMessage(input: { id: string; parts: DriverPart[]; createdAt: string; sessionId?: string }): StoredMessageRecord {
    return {
      id: input.id,
      role: "assistant",
      createdAt: input.createdAt,
      driverId: "openai",
      raw: { kind: "assistant", parts: input.parts } satisfies OpenAIRawMessage
    };
  }

  deserializeMessage(record: StoredMessageRecord): StoredMessage {
    return { ...record, parts: rawToParts(record.raw) };
  }

  async *streamChat(input: StreamChatInput): AsyncGenerator<ChatStreamChunk> {
    const profile = readProfile(this.store);
    if (!profile?.baseUrl || !profile.model) throw new Error("OpenAI-Compatible profile 未配置");
    if (input.model !== "openai:default") throw new Error(`未知的 OpenAI 模型: ${input.model}`);

    const apiKey = (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined) ?? this.getApiKey();
    const provider = createOpenAICompatible({
      name: "desktop-openai-compatible",
      baseURL: profile.baseUrl.replace(/\/$/, ""),
      apiKey
    });

    const taskSource = input.toolSource;
    const tools = taskSource ? buildAiTools(taskSource) : undefined;
    const messages: ModelMessage[] = historyToModelMessages(input.history);
    messages.push({ role: "user", content: input.userInput.text });

    const parts: DriverPart[] = [];
    let buffer = "";
    let taskCreated: ChatTaskCreationResult | undefined;
    let finished = false;

    const result = streamText({
      model: provider.chatModel(profile.model),
      messages,
      abortSignal: input.signal,
      ...(taskSource
        ? { system: taskSource.systemPrompt(), tools, stopWhen: stepCountIs(10) }
        : {})
    });

    try {
      for await (const chunk of result.fullStream) {
        if (input.signal.aborted) return;
        // chunk.type 是 TextStreamPart 的 type 字段
        if (chunk.type === "text-delta" && "text" in chunk && chunk.text) {
          buffer += chunk.text;
          const part: DriverPart = { driverId: "openai", type: "text", text: chunk.text };
          parts.push(part);
          yield { type: "part", part };
        } else if (chunk.type === "tool-call") {
          const tc = chunk as unknown as { toolCallId: string; toolName: string; input: unknown };
          const part: DriverPart = { driverId: "openai", type: "openai.tool-call", toolCallId: tc.toolCallId, name: tc.toolName, input: tc.input };
          parts.push(part);
          yield { type: "part", part };
        } else if (chunk.type === "tool-result") {
          const tr = chunk as unknown as { toolCallId: string; output: unknown };
          const part: DriverPart = { driverId: "openai", type: "openai.tool-result", toolCallId: tr.toolCallId, output: tr.output };
          parts.push(part);
          yield { type: "part", part };
          if (taskSource) {
            const described = taskSource.describeResult(tr.output);
            if (described && !taskCreated) {
              taskCreated = described;
              yield { type: "task-created", result: described };
            }
          }
        }
      }
      finished = true;
    } catch (error) {
      if (!input.signal.aborted && !buffer && !finished) throw error;
    }

    if (!input.signal.aborted) {
      yield { type: "done", status: finished ? "done" : "done" };
    }
  }

  dispose(): void {
    // ai-sdk 不持有长期资源,无需释放。
  }
}
