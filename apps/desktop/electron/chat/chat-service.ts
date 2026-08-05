import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { TaskStore } from "@coding-agent/core";
import type { UIMessageChunk } from "ai";
import { ChatStorage } from "./chat-storage.js";
import { listChatModels, resolveChatModel } from "./chat-models.js";
import { streamChat } from "./chat-llm.js";
import type { AbortChatStreamInput, ChatConversation, ChatMessage, ChatMessageMetadata, ChatModelGroup, ChatStreamEvent, StartChatStreamInput } from "./chat-types.js";
import type { TaskCreationBackend, TaskCreatedResult } from "./task-backends/index.js";

type GetQoderStatus = () => Promise<{ enabled: boolean; connected: boolean; running: boolean; models: Array<{ value: string; displayName: string; isDefault?: boolean; isReasoning?: boolean; isVl?: boolean; priceFactor?: number }> }>;
type TokenProvider = () => string | undefined;
type ActiveStream = { streamId: string; abort: AbortController };
type TaskBackendFactory = () => TaskCreationBackend | undefined;

function textOf(message: ChatMessage): string { return message.parts.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join(""); }
function titleOf(text: string): string { return text.slice(0, 32).replace(/\s+/g, " ").trim() || "新对话"; }

/**
 * 渲染"已创建任务"提示。
 *
 * 后端无关：根据 backend id 切到对应的展示文案，未来接入 GitHub / Linear 时只需在此处加分支。
 */
function describeCreatedTask(result: TaskCreatedResult): string {
  switch (result.backend) {
    case "jira":
      return `已创建 Jira 任务 ${result.externalKey}。是否需要立即执行？`;
    case "github":
      return `已创建 GitHub Issue ${result.externalKey}。是否需要立即执行？`;
    case "linear":
      return `已创建 Linear Issue ${result.externalKey}。是否需要立即执行？`;
  }
}

export class ChatService {
  private readonly storage: ChatStorage;
  private readonly activeStreams = new Map<string, ActiveStream>();

  constructor(private readonly store: TaskStore, dataDir: string, private readonly getQoderStatus: GetQoderStatus, private readonly getQoderToken: TokenProvider, private readonly getOpenAIKey: TokenProvider, private readonly getMainWindow: () => BrowserWindow | undefined, private readonly resolveTaskBackend?: TaskBackendFactory) {
    this.storage = new ChatStorage(dataDir);
  }

  listChats() { return this.storage.listMetas(); }
  getChat(id: string) { return this.storage.getConversation(id); }
  listModels(): Promise<ChatModelGroup[]> { return listChatModels(this.store, this.getQoderStatus); }

  createChat(model?: string): ChatConversation {
    const existing = this.storage.listMetas().find((item) => item.messageCount === 0);
    if (existing) {
      const conversation = this.storage.getConversation(existing.id);
      if (conversation) return conversation;
    }
    const now = new Date().toISOString();
    const conversation: ChatConversation = { id: randomUUID(), title: "新对话", createdAt: now, updatedAt: now, messageCount: 0, model, provider: model?.startsWith("openai:") ? "openai" : model ? "qoder" : undefined, messages: [] };
    this.storage.saveConversation(conversation);
    return conversation;
  }

  deleteChat(id: string): void {
    this.activeStreams.get(id)?.abort.abort();
    this.storage.deleteConversation(id);
  }

  abortChat(input: AbortChatStreamInput): void {
    const active = this.activeStreams.get(input.chatId);
    if (active?.streamId === input.streamId) active.abort.abort();
  }

  async startChatStream(input: StartChatStreamInput): Promise<void> {
    const conversation = this.storage.getConversation(input.chatId);
    if (!conversation) throw new Error("对话不存在");
    const prior = this.activeStreams.get(input.chatId);
    if (prior) prior.abort.abort();
    const abort = new AbortController();
    this.activeStreams.set(input.chatId, { streamId: input.streamId, abort });

    const now = new Date().toISOString();
    const userMessage: ChatMessage = { ...input.message, metadata: { ...(input.message.metadata ?? {}), createdAt: input.message.metadata?.createdAt ?? now, status: "done" } };
    const existing = conversation.messages.filter((message) => message.id !== userMessage.id);
    const messages = [...existing, userMessage];
    const assistantId = randomUUID();
    const textPartId = `text-${assistantId}`;
    let content = "";
    let status: ChatMessageMetadata["status"] = "done";
    let modelKey = input.model;
    let userPersisted = false;
    const taskBackend = input.mode === "task-create" ? this.resolveTaskBackend?.() : undefined;
    let taskCreation: ChatMessageMetadata["taskCreation"];
    try {
      const title = conversation.messages.some((message) => message.role === "user") ? conversation.title : titleOf(textOf(userMessage));
      this.storage.replaceMessages(input.chatId, messages, { title, model: input.model, provider: input.model.startsWith("openai:") ? "openai" : "qoder", updatedAt: now });
      userPersisted = true;
      const model = resolveChatModel(input.model, this.store, this.getOpenAIKey);
      modelKey = model.key;
      const startMetadata: ChatMessageMetadata = { createdAt: now, model: modelKey, agentMode: input.mode ?? "chat" };
      this.dispatch(input, { type: "start", messageId: assistantId, messageMetadata: startMetadata });
      this.dispatch(input, { type: "text-start", id: textPartId });
      for await (const event of streamChat({ model, qoderToken: model.provider === "qoder" ? this.getQoderToken() : undefined, messages, signal: abort.signal, taskBackend, onCreated: (result) => {
        taskCreation = {
          backend: result.backend,
          externalKey: result.externalKey,
          summary: result.summary,
          projectKey: result.projectKey ?? "",
          issueType: result.issueType ?? ""
        };
        if (!content.trim()) {
          const fallback = describeCreatedTask(result);
          content = fallback;
          this.dispatch(input, { type: "text-delta", id: textPartId, delta: fallback });
        }
      } })) {
        if (event.type === "delta") { content += event.delta; this.dispatch(input, { type: "text-delta", id: textPartId, delta: event.delta }); }
        else if (event.type === "task-created") {
          // 兼容老路径：工具执行已经在 onCreated 里走完，这里不再重复处理。
          // 留个空分支，避免 if-else 类型收窄报错。
          taskCreation = {
            backend: event.task.backend,
            externalKey: event.task.externalKey,
            summary: event.task.summary,
            projectKey: event.task.projectKey ?? "",
            issueType: event.task.issueType ?? ""
          };
        }
      }
      if (abort.signal.aborted) status = "aborted";
      if (!content && status === "done") throw new Error("模型返回了空响应");
    } catch (reason) {
      if (abort.signal.aborted) status = "aborted";
      else {
        status = "error";
        const message = reason instanceof Error ? reason.message : String(reason);
        this.dispatch(input, { type: "error", errorText: message });
      }
    } finally {
      const metadata: ChatMessageMetadata = { createdAt: now, model: modelKey, status, agentMode: input.mode ?? "chat", ...(taskCreation ? { taskCreation } : {}) };
      try {
        if (userPersisted) {
          const assistant: ChatMessage = { id: assistantId, role: "assistant", metadata, parts: [{ type: "text", text: content, state: "done" }] };
          const latest = this.storage.getConversation(input.chatId);
          if (latest) {
            const merged = latest.messages.filter((message) => message.id !== assistantId);
            const userIndex = merged.findIndex((message) => message.id === userMessage.id);
            merged.splice(userIndex >= 0 ? userIndex + 1 : merged.length, 0, assistant);
            this.storage.replaceMessages(input.chatId, merged, { model: input.model, updatedAt: new Date().toISOString() });
          }
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        this.dispatch(input, { type: "error", errorText: `保存聊天失败：${message}` });
      } finally {
        taskBackend?.close();
        if (status === "aborted") this.dispatch(input, { type: "abort", reason: "用户已停止生成" });
        else {
          this.dispatch(input, { type: "text-end", id: textPartId });
          this.dispatch(input, { type: "finish", finishReason: status === "error" ? "error" : "stop", messageMetadata: metadata });
        }
        this.finish(input);
        if (this.activeStreams.get(input.chatId)?.streamId === input.streamId) this.activeStreams.delete(input.chatId);
      }
    }
  }

  private dispatch(input: Pick<StartChatStreamInput, "streamId" | "chatId">, chunk: UIMessageChunk): void {
    this.getMainWindow()?.webContents.send("chat:stream-event", { streamId: input.streamId, chatId: input.chatId, chunk } satisfies ChatStreamEvent);
  }

  private finish(input: Pick<StartChatStreamInput, "streamId" | "chatId">): void {
    this.getMainWindow()?.webContents.send("chat:stream-event", { streamId: input.streamId, chatId: input.chatId, done: true } satisfies ChatStreamEvent);
  }
}
