import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { BrowserWindow } from "electron";
import type { TaskStore } from "@coding-agent/core";
import { ChatStorage, type ChatMessage, type ChatConversationMeta } from "./chat-storage.js";
import { listChatModels, parseModelValue } from "./chat-models.js";
import { streamChat } from "./chat-llm.js";
import type { ChatConversation, ChatEvent, ChatModelGroup } from "./chat-types.js";

type GetQoderStatus = () => Promise<{ enabled: boolean; connected: boolean; running: boolean; models: Array<{ value: string; displayName: string; isDefault?: boolean; isReasoning?: boolean; priceFactor?: number }> }>;

type QoderTokenProvider = () => string | undefined;

export class ChatService extends EventEmitter {
  private storage: ChatStorage;
  private activeStreams = new Map<string, AbortController>();

  constructor(
    private readonly store: TaskStore,
    private readonly dataDir: string,
    private readonly getQoderStatus: GetQoderStatus,
    private readonly getQoderToken: QoderTokenProvider,
    private readonly getMainWindow: () => BrowserWindow | undefined
  ) {
    super();
    this.storage = new ChatStorage(dataDir);
  }

  listChats(): ChatConversationMeta[] {
    return this.storage.listMetas();
  }

  getChat(id: string): ChatConversation | undefined {
    const meta = this.storage.listMetas().find((m) => m.id === id);
    if (!meta) return undefined;
    return { ...meta, messages: this.storage.readMessages(id) };
  }

  createChat(model?: string): ChatConversation {
    const id = randomUUID();
    const now = new Date().toISOString();
    const meta: ChatConversationMeta = { id, title: "新对话", createdAt: now, updatedAt: now, messageCount: 0, model };
    if (model) {
      const parsed = parseModelValue(model);
      meta.provider = parsed.provider;
    }
    this.storage.upsertMeta(meta);
    return { ...meta, messages: [] };
  }

  deleteChat(id: string): void {
    this.activeStreams.get(id)?.abort();
    this.activeStreams.delete(id);
    this.storage.deleteConversation(id);
  }

  appendUserMessage(id: string, text: string): ChatMessage {
    const msg: ChatMessage = { id: randomUUID(), role: "user", content: text, createdAt: new Date().toISOString(), status: "done" };
    this.storage.appendMessage(id, msg);
    const meta = this.storage.listMetas().find((m) => m.id === id);
    if (meta) {
      const messages = this.storage.readMessages(id);
      const updated: ChatConversationMeta = {
        ...meta,
        title: meta.title === "新对话" && messages.filter((m) => m.role === "user").length === 1 ? text.slice(0, 32).replace(/\s+/g, " ").trim() || "新对话" : meta.title,
        messageCount: messages.length,
        updatedAt: new Date().toISOString()
      };
      this.storage.upsertMeta(updated);
    }
    return msg;
  }

  listModels(): Promise<ChatModelGroup[]> {
    return listChatModels(this.store, this.getQoderStatus);
  }

  abortChat(id: string): void {
    this.activeStreams.get(id)?.abort();
    this.activeStreams.delete(id);
  }

  async sendChatMessage(chatId: string, messageId: string, model: string): Promise<void> {
    if (this.activeStreams.has(chatId)) this.activeStreams.get(chatId)!.abort();
    const abort = new AbortController();
    this.activeStreams.set(chatId, abort);
    const messages = this.storage.readMessages(chatId);
    const parsed = parseModelValue(model);
    const qoderToken = parsed.provider === "qoder" ? this.getQoderToken() : undefined;
    const assistantId = randomUUID();
    const assistantMessage: ChatMessage = { id: assistantId, role: "assistant", content: "", createdAt: new Date().toISOString(), model: parsed.key, status: "streaming" };
    this.storage.appendMessage(chatId, assistantMessage);
    this.dispatch(chatId, { type: "chat_message_start", chatId, messageId: assistantId, role: "assistant" } as ChatEvent);
    const meta = this.storage.listMetas().find((m) => m.id === chatId);
    let buffer = "";
    try {
      for await (const event of streamChat({
        provider: parsed.provider,
        modelKey: parsed.key,
        qoderToken,
        openaiProfile: parsed.openai,
        messages,
        signal: abort.signal
      })) {
        if (event.type === "delta") {
          buffer += event.delta;
          this.dispatch(chatId, { type: "chat_message_delta", chatId, messageId: assistantId, delta: event.delta } as ChatEvent);
        } else if (event.type === "done") {
          buffer = event.content || buffer;
        } else if (event.type === "error") {
          this.dispatch(chatId, { type: "chat_message_error", chatId, messageId: assistantId, error: event.error } as ChatEvent);
          this.updateAssistantMessage(chatId, assistantId, { content: event.error, status: "error" });
          this.activeStreams.delete(chatId);
          return;
        }
      }
      this.updateAssistantMessage(chatId, assistantId, { content: buffer, status: "done" });
      this.dispatch(chatId, { type: "chat_message_done", chatId, messageId: assistantId, content: buffer, model: parsed.key } as ChatEvent);
      if (meta) {
        this.storage.upsertMeta({ ...meta, updatedAt: new Date().toISOString(), messageCount: this.storage.readMessages(chatId).length });
      }
    } catch (reason) {
      this.dispatch(chatId, { type: "chat_message_error", chatId, messageId: assistantId, error: reason instanceof Error ? reason.message : String(reason) } as ChatEvent);
    } finally {
      this.activeStreams.delete(chatId);
    }
  }

  private updateAssistantMessage(chatId: string, assistantId: string, patch: Partial<ChatMessage>): void {
    const file = `${this.dataDir}/chats/chat-${chatId}.jsonl`;
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const updated = lines.map((line) => {
      try {
        const parsed = JSON.parse(line) as ChatMessage;
        if (parsed.id === assistantId) return JSON.stringify({ ...parsed, ...patch });
        return line;
      } catch {
        return line;
      }
    });
    writeFileSync(file, updated.join("\n") + "\n");
  }

  private dispatch(chatId: string, event: ChatEvent): void {
    this.getMainWindow()?.webContents.send("chat:event", event);
    super.emit(chatId, event);
  }
}
