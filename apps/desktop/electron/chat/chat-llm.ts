import { accessToken, query } from "@qoder-ai/qoder-agent-sdk";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText } from "ai";
import type { ChatMessage } from "./chat-types.js";
import type { ResolvedChatModel } from "./chat-models.js";

export type TextStreamEvent = { type: "delta"; delta: string } | { type: "done" };

function messageText(message: ChatMessage): string {
  return message.parts.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("");
}

export async function* streamChat(options: { model: ResolvedChatModel; qoderToken?: string; messages: ChatMessage[]; signal: AbortSignal }): AsyncGenerator<TextStreamEvent> {
  if (options.model.provider === "qoder") yield* streamQoder({ model: options.model, qoderToken: options.qoderToken, messages: options.messages, signal: options.signal });
  else yield* streamOpenAICompatible({ model: options.model, messages: options.messages, signal: options.signal });
}

async function* streamOpenAICompatible({ model, messages, signal }: { model: Extract<ResolvedChatModel, { provider: "openai" }>; messages: ChatMessage[]; signal: AbortSignal }): AsyncGenerator<TextStreamEvent> {
  const provider = createOpenAICompatible({ name: "desktop-openai-compatible", baseURL: model.baseUrl.replace(/\/$/, ""), apiKey: model.apiKey });
  const result = streamText({ model: provider.chatModel(model.key), messages: await convertToModelMessages(messages), abortSignal: signal });
  for await (const delta of result.textStream) {
    if (signal.aborted) return;
    if (delta) yield { type: "delta", delta };
  }
  yield { type: "done" };
}

async function* streamQoder({ model, qoderToken, messages, signal }: { model: Extract<ResolvedChatModel, { provider: "qoder" }>; qoderToken?: string; messages: ChatMessage[]; signal: AbortSignal }): AsyncGenerator<TextStreamEvent> {
  if (!qoderToken) throw new Error("请先在设置中配置 Qoder Token");
  const prompt = `${messages.map((message) => `${message.role === "user" ? "Human" : message.role === "assistant" ? "Assistant" : "System"}: ${messageText(message)}`).join("\n\n")}\n\nAssistant:`;
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const session = query({ prompt, options: { auth: accessToken(qoderToken), cwd: process.cwd(), abortController, persistSession: false, permissionMode: "default", controlRequestTimeoutMs: 5_000, model: model.key } });
  let buffer = "";
  let captured = false;
  try {
    for await (const raw of session) {
      if (signal.aborted) return;
      const message = raw as unknown as { type?: string; event?: { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; text?: string }; error?: { message?: string } | string }; message?: { content?: Array<{ type: string; text?: string }> }; result?: string; error?: string };
      if (message.type === "stream_event") {
        const event = message.event;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) { buffer += event.delta.text; yield { type: "delta", delta: event.delta.text }; }
        else if (event?.type === "content_block_start" && event.content_block?.type === "text" && event.content_block.text) { buffer += event.content_block.text; yield { type: "delta", delta: event.content_block.text }; }
        else if (event?.type === "message_stop") captured = true;
        else if (event?.type === "error" && !buffer) throw new Error(typeof event.error === "string" ? event.error : event.error?.message ?? "Qoder SDK 流式错误");
      } else if (message.type === "assistant" && Array.isArray(message.message?.content)) {
        for (const part of message.message.content) if (part.type === "text" && part.text && !buffer.includes(part.text)) { buffer += part.text; yield { type: "delta", delta: part.text }; }
      } else if (message.type === "result") {
        if (message.result && !buffer.includes(message.result)) { const extra = message.result.startsWith(buffer) ? message.result.slice(buffer.length) : message.result; buffer += extra; if (extra) yield { type: "delta", delta: extra }; }
        captured = true;
      } else if (message.type === "error" && !buffer) throw new Error(message.error ?? "Qoder SDK 错误");
    }
  } catch (error) {
    if (!signal.aborted && !captured && !buffer) throw error;
  } finally {
    try { await session.close(); } catch { /* The SDK may already be closed. */ }
  }
  if (!signal.aborted) yield { type: "done" };
}
