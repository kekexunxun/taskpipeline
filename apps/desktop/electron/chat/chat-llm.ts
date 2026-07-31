import { accessToken, query } from "@qoder-ai/qoder-agent-sdk";
import type { ChatMessage } from "./chat-storage.js";

export type StreamEvent =
  | { type: "delta"; delta: string }
  | { type: "done"; content: string; model?: string }
  | { type: "error"; error: string };

export interface StreamChatOptions {
  provider: "qoder" | "openai";
  modelKey: string;
  qoderToken?: string;
  openaiProfile?: { baseUrl: string; model: string; apiKey?: string };
  messages: ChatMessage[];
  signal: AbortSignal;
}

export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
  if (opts.provider === "qoder") {
    yield* streamQoder(opts);
  } else {
    yield* streamOpenAICompat(opts);
  }
}

async function* streamQoder(opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const { modelKey, messages, signal, qoderToken } = opts;
  if (!qoderToken) {
    yield { type: "error", error: "请先在设置中配置 Qoder Token" };
    return;
  }
  const prompt = messages.map((m) => `${m.role === "user" ? "Human" : m.role === "assistant" ? "Assistant" : "System"}: ${m.content}`).join("\n\n") + "\n\nAssistant:";
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort());
  const q = query({
    prompt,
    options: {
      auth: accessToken(qoderToken),
      cwd: process.cwd(),
      abortController,
      persistSession: false,
      permissionMode: "default",
      controlRequestTimeoutMs: 5_000,
      ...(modelKey ? { model: modelKey } : {})
    }
  });
  let buffer = "";
  let aborted = false;
  let captured = false;
  let streamError: string | undefined;
  try {
    for await (const message of q) {
      if (signal.aborted) { aborted = true; break; }
      // Qoder SDK 走 Anthropic 协议：流式文本主要在 stream_event 消息的 content_block_delta.text_delta 里。
      // assistant 完整消息和 result 消息保留作为兜底。
      const msg = message as unknown as {
        type?: string;
        event?: {
          type?: string;
          delta?: { type?: string; text?: string; partial_json?: string };
          content_block?: { type?: string; text?: string };
          error?: { message?: string } | string;
        };
        message?: { content?: Array<{ type: string; text?: string }> };
        result?: string;
        error?: string;
      };
      switch (msg.type) {
        case "stream_event": {
          const ev = msg.event;
          if (!ev) break;
          if (ev.type === "content_block_delta") {
            const d = ev.delta;
            if (d?.type === "text_delta" && d.text) {
              buffer += d.text;
              yield { type: "delta", delta: d.text };
            }
          } else if (ev.type === "content_block_start") {
            const cb = ev.content_block;
            if (cb?.type === "text" && cb.text) {
              buffer += cb.text;
              yield { type: "delta", delta: cb.text };
            }
          } else if (ev.type === "message_stop") {
            captured = true;
          } else if (ev.type === "error") {
            const e = ev.error;
            streamError = typeof e === "string" ? e : e?.message ?? "Qoder SDK 流式错误";
          }
          break;
        }
        case "assistant": {
          // 完整 assistant 消息兜底：当 stream_event 缺失时仍能取到文本
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c?.type === "text" && c.text && !buffer.includes(c.text)) {
                buffer += c.text;
                yield { type: "delta", delta: c.text };
              }
            }
          }
          break;
        }
        case "result": {
          const result = msg.result;
          if (typeof result === "string" && result && !buffer.includes(result)) {
            const extra = buffer.length === 0 ? result : result.startsWith(buffer) ? result.slice(buffer.length) : result;
            if (extra) { buffer += extra; yield { type: "delta", delta: extra }; }
          }
          captured = true;
          break;
        }
        case "error": {
          streamError = msg.error ?? "Qoder SDK 错误";
          break;
        }
        default:
          // system / user echo / 其它内部消息忽略
          break;
      }
    }
  } catch (reason) {
    // Qoder SDK 在流式结束或 abort 后偶尔会抛 "result is not defined" 之类的清理错误；
    // 如果我们已经拿到了文本，则视为正常完成。
    if (!captured && !aborted && buffer.length === 0) {
      const text = reason instanceof Error ? reason.message : String(reason);
      yield { type: "error", error: text };
      return;
    }
  } finally {
    try { await q.close(); } catch { /* ignore */ }
  }
  if (aborted) { yield { type: "error", error: "已中断" }; return; }
  if (streamError && buffer.length === 0) { yield { type: "error", error: streamError }; return; }
  yield { type: "done", content: buffer, model: modelKey };
}

async function* streamOpenAICompat(opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const { openaiProfile, messages, signal } = opts;
  if (!openaiProfile) {
    yield { type: "error", error: "未配置 OpenAI-Compatible profile" };
    return;
  }
  const url = `${openaiProfile.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: openaiProfile.model,
    stream: true,
    messages: messages.map((m) => ({ role: m.role, content: m.content }))
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(openaiProfile.apiKey ? { authorization: `Bearer ${openaiProfile.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok || !res.body) {
      yield { type: "error", error: `OpenAI 调用失败 ${res.status}` };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let pending = "";
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) { buffer += delta; yield { type: "delta", delta }; }
        } catch { /* skip malformed */ }
      }
    }
    if (signal.aborted) yield { type: "error", error: "已中断" };
    else yield { type: "done", content: buffer, model: openaiProfile.model };
  } catch (reason) {
    yield { type: "error", error: reason instanceof Error ? reason.message : String(reason) };
  }
}
