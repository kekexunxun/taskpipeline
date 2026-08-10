import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { TaskStore } from "@task-pipeline/core";
import { ChatStorage } from "./chat-storage.js";
import type { ChatDriverRegistry } from "./drivers/driver-registry.js";
import type { ChatDriver } from "./drivers/chat-driver.js";
import type { ToolSource } from "./drivers/tool-source.js";
import type {
  AbortChatStreamInput,
  ChatConversation,
  ChatMessageMetadata,
  ChatModelGroup,
  ChatStreamEvent,
  ChatStreamChunk,
  ChatDriverId,
  DriverPart,
  StartChatStreamInput,
  StoredMessage,
  StoredMessageRecord
} from "./chat-types.js";
import type { TaskCreationBackend, TaskCreatedResult } from "./task-backends/index.js";

type ActiveStream = { streamId: string; abort: AbortController };
type TaskBackendFactory = () => TaskCreationBackend | undefined;
type MemoryContextProvider = (input: { conversationId: string; query: string }) => Promise<string | undefined>;
type ConversationConsolidator = (input: { conversation: ChatConversation; signal: AbortSignal; driverId: ChatDriverId; model: string }) => Promise<void>;

/**
 * ChatService — 编排层。
 *
 * 不再 import 任何 ai-sdk / UIMessage / driver 实现细节。
 * 职责只剩:
 *  1. 从 `ChatDriverRegistry` 取 driver;
 *  2. 把 `StartChatStreamInput` 翻译成 `StreamChatInput` 调 `driver.streamChat`;
 *  3. 把 driver 推上来的 `ChatStreamChunk` 透传给前端 (附 `driverId` 字段);
 *  4. 流结束后用 `driver.serializeAssistantMessage` 把累积的 parts 落盘;
 *  5. 单会话切换 driver:历史 messages 按各自 driverId 反序列化渲染,新消息用新 driverId 生成。
 */
export class ChatService {
  private readonly storage: ChatStorage;
  private readonly activeStreams = new Map<string, ActiveStream>();

  constructor(
    private readonly store: TaskStore,
    dataDir: string,
    private readonly driverRegistry: ChatDriverRegistry,
    private readonly getMainWindow: () => BrowserWindow | undefined,
    private readonly resolveTaskBackend?: TaskBackendFactory,
    private readonly memoryContext?: MemoryContextProvider,
    private readonly consolidateConversation?: ConversationConsolidator
  ) {
    this.storage = new ChatStorage(dataDir);
  }

  listChats() { return this.storage.listMetas(); }

  /**
   * 加载会话并把每条 message 按 `driverId` 反序列化为 `StoredMessage`(带 parts)。
   * `ChatConversation.messages` 本身是 record 列表(无 parts),这里补齐 parts 给 UI 用。
   */
  getChat(id: string): { conversation: ChatConversation; messages: StoredMessage[] } | undefined {
    const conversation = this.storage.getConversation(id);
    if (!conversation) return undefined;
    const messages = conversation.messages.map((record) => this.deserializeRecord(record));
    return { conversation, messages };
  }

  /**
   * 列出所有 driver 提供的模型,按 driverId 分组。
   */
  async listModels(): Promise<ChatModelGroup[]> {
    const groups: ChatModelGroup[] = [];
    for (const driver of this.driverRegistry.list()) {
      try {
        const models = await driver.listModels();
        if (models.length) groups.push({ driverId: driver.id, displayName: driver.displayName, models });
      } catch { /* driver 列表失败不影响其他 driver */ }
    }
    return groups;
  }

  createChat(driverId?: ChatDriverId, model?: string, workingDirectory?: string): ChatConversation {
    // 统一复用规则:普通对话(无目录)复用无目录空对话,项目对话复用同目录空对话 ——
    // 避免反复点「+」无限新增空会话。匹配条件是 workingDirectory 全等。
    const existing = this.storage.listMetas().find((item) => item.messageCount === 0 && item.workingDirectory === workingDirectory);
    if (existing) {
      const conversation = this.storage.getConversation(existing.id);
      if (conversation) return conversation;
    }
    const now = new Date().toISOString();
    const conversation: ChatConversation = {
      id: randomUUID(),
      title: "新对话",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      model,
      driverId,
      workingDirectory,
      messages: []
    };
    this.storage.saveConversation(conversation);
    return conversation;
  }

  deleteChat(id: string): void {
    this.activeStreams.get(id)?.abort.abort();
    // 关闭该对话对应的常驻 Qoder 会话(qodercli 进程),避免随应用生命周期悬挂。
    const conversation = this.storage.getConversation(id);
    if (conversation?.driverId) {
      this.driverRegistry.tryGet(conversation.driverId)?.closeSession?.(id);
    }
    this.storage.deleteConversation(id);
  }

  /**
   * 绑定/解绑对话的工作目录(项目对话)。
   * 传 undefined 即解绑,回到普通对话;正在流式时返回 undefined。
   */
  setChatWorkingDirectory(id: string, workingDirectory?: string): ChatConversation | undefined {
    if (this.activeStreams.has(id)) return undefined;
    return this.storage.updateMeta(id, { workingDirectory });
  }

  abortChat(input: AbortChatStreamInput): void {
    const active = this.activeStreams.get(input.chatId);
    if (active?.streamId === input.streamId) active.abort.abort();
  }

  async startChatStream(input: StartChatStreamInput): Promise<void> {
    const conversation = this.storage.getConversation(input.chatId);
    if (!conversation) throw new Error("对话不存在");
    const driver = this.driverRegistry.tryGet(input.driverId);
    if (!driver) throw new Error(`未注册的 chat driver: ${input.driverId}`);

    const prior = this.activeStreams.get(input.chatId);
    if (prior) prior.abort.abort();
    const abort = new AbortController();
    this.activeStreams.set(input.chatId, { streamId: input.streamId, abort });

    const now = input.message.createdAt;
    const userRecord = driver.serializeUserMessage({ id: input.message.id, text: input.message.text, createdAt: now });
    const existing = conversation.messages.filter((message) => message.id !== userRecord.id);
    const messages: StoredMessageRecord[] = [...existing, userRecord];
    const assistantId = randomUUID();
    const parts: DriverPart[] = [];
    let status: ChatMessageMetadata["status"] = "done";
    let taskCreation: ChatMessageMetadata["taskCreation"];
    let capturedSessionId: string | undefined;
    let userPersisted = false;
    const taskBackend = input.mode === "task-create" ? this.resolveTaskBackend?.() : undefined;
    const toolSource: ToolSource | undefined = taskBackend?.toToolSource();

    try {
      const isFirstUserMessage = !conversation.messages.some((m) => m.role === "user");
      const title = isFirstUserMessage ? titleOf(input.message.text) : conversation.title;
      this.storage.replaceMessages(input.chatId, messages, { title, model: input.model, driverId: input.driverId, updatedAt: now });
      userPersisted = true;

      const memoryContext = await this.memoryContext?.({ conversationId: input.chatId, query: input.message.text });
      const historyRecords = memoryContext
        ? [
            ...messages.slice(0, -1),
            { id: randomUUID(), role: "system", createdAt: now, driverId: input.driverId, raw: { kind: "system", text: memoryContext } } as StoredMessageRecord,
            userRecord
          ]
        : messages;
      const history = historyRecords.map((record) => this.deserializeRecord(record));

      this.dispatch(input, { type: "start", messageId: assistantId, messageMetadata: { createdAt: now, model: input.model, agentMode: input.mode ?? "chat" } });

      for await (const chunk of driver.streamChat({
        conversationId: input.chatId,
        model: input.model,
        history,
        userInput: { id: input.message.id, text: input.message.text, createdAt: now },
        signal: abort.signal,
        cwd: conversation.workingDirectory,
        ...(toolSource ? { toolSource } : {})
      })) {
        if (abort.signal.aborted) break;
        // 累积 parts
        if (chunk.type === "part") {
          parts.push(chunk.part);
          if (chunk.part.type === "qoder.session") capturedSessionId = chunk.part.sessionId;
        } else if (chunk.type === "task-created") {
          taskCreation = mapTaskCreation(chunk.result);
        }
        this.dispatch(input, chunk);
      }
      if (abort.signal.aborted) status = "aborted";
      if (status === "done" && parts.length === 0) throw new Error("模型返回了空响应");
    } catch (reason) {
      if (abort.signal.aborted) status = "aborted";
      else {
        status = "error";
        const message = reason instanceof Error ? reason.message : String(reason);
        this.dispatch(input, { type: "error", message });
      }
    } finally {
      const metadata: ChatMessageMetadata = {
        createdAt: now,
        model: input.model,
        status,
        agentMode: input.mode ?? "chat",
        ...(taskCreation ? { taskCreation } : {})
      };
      try {
        if (userPersisted) {
          const assistantRecord = driver.serializeAssistantMessage({ id: assistantId, parts, createdAt: now, ...(capturedSessionId ? { sessionId: capturedSessionId } : {}) });
          this.storage.appendMessage(input.chatId, assistantRecord, { model: input.model, driverId: input.driverId });
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        this.dispatch(input, { type: "error", message: `保存聊天失败:${message}` });
      } finally {
        toolSource?.close();
        taskBackend?.close();
        if (status === "aborted") this.dispatch(input, { type: "done", status: "aborted" });
        else this.dispatch(input, { type: "done", status });
        this.finish(input);
        if (this.activeStreams.get(input.chatId)?.streamId === input.streamId) this.activeStreams.delete(input.chatId);
        if (status === "done" && parts.length) {
          const conversation = this.storage.getConversation(input.chatId);
          if (conversation) {
            void this.consolidateConversation?.({ conversation, signal: abort.signal, driverId: input.driverId, model: input.model }).catch((reason) => console.warn("[memory] chat consolidate failed:", reason));
          }
        }
      }
    }
  }

  /**
   * 把 record 按 driverId 反序列化为带 parts 的 StoredMessage。
   * 单会话切换 driver 时,历史消息按各自 driverId 各自反序列化。
   */
  private deserializeRecord(record: StoredMessageRecord): StoredMessage {
    const driver = this.driverRegistry.tryGet(record.driverId);
    if (!driver) {
      // 未注册的 driver (例如旧 driverId) 兜底:parts = []
      return { ...record, parts: [] };
    }
    return driver.deserializeMessage(record);
  }

  private dispatch(input: Pick<StartChatStreamInput, "streamId" | "chatId" | "driverId">, chunk: ChatStreamChunk): void {
    this.getMainWindow()?.webContents.send("chat:stream-event", { streamId: input.streamId, chatId: input.chatId, driverId: input.driverId, chunk } satisfies ChatStreamEvent);
  }

  private finish(input: Pick<StartChatStreamInput, "streamId" | "chatId" | "driverId">): void {
    this.getMainWindow()?.webContents.send("chat:stream-event", { streamId: input.streamId, chatId: input.chatId, driverId: input.driverId, done: true } satisfies ChatStreamEvent);
  }

  /** 释放所有 driver 的资源(给 main.ts 退出时用)。 */
  dispose(): void {
    for (const driver of this.driverRegistry.list()) driver.dispose();
  }
}

function titleOf(text: string): string { return text.slice(0, 32).replace(/\s+/g, " ").trim() || "新对话"; }

function mapTaskCreation(result: TaskCreatedResult): ChatMessageMetadata["taskCreation"] {
  return {
    backend: result.backend,
    externalKey: result.externalKey,
    summary: result.summary,
    projectKey: result.projectKey ?? "",
    issueType: result.issueType ?? ""
  };
}

export type { ChatDriver } from "./drivers/chat-driver.js";
