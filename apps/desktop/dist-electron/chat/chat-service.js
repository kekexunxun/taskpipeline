import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ChatStorage } from "./chat-storage.js";
import { listChatModels, parseModelValue } from "./chat-models.js";
import { streamChat } from "./chat-llm.js";
export class ChatService extends EventEmitter {
    store;
    dataDir;
    getQoderStatus;
    getQoderToken;
    getMainWindow;
    storage;
    activeStreams = new Map();
    constructor(store, dataDir, getQoderStatus, getQoderToken, getMainWindow) {
        super();
        this.store = store;
        this.dataDir = dataDir;
        this.getQoderStatus = getQoderStatus;
        this.getQoderToken = getQoderToken;
        this.getMainWindow = getMainWindow;
        this.storage = new ChatStorage(dataDir);
    }
    listChats() {
        return this.storage.listMetas();
    }
    getChat(id) {
        const meta = this.storage.listMetas().find((m) => m.id === id);
        if (!meta)
            return undefined;
        return { ...meta, messages: this.storage.readMessages(id) };
    }
    createChat(model) {
        const id = randomUUID();
        const now = new Date().toISOString();
        const meta = { id, title: "新对话", createdAt: now, updatedAt: now, messageCount: 0, model };
        if (model) {
            const parsed = parseModelValue(model);
            meta.provider = parsed.provider;
        }
        this.storage.upsertMeta(meta);
        return { ...meta, messages: [] };
    }
    deleteChat(id) {
        this.activeStreams.get(id)?.abort();
        this.activeStreams.delete(id);
        this.storage.deleteConversation(id);
    }
    appendUserMessage(id, text) {
        const msg = { id: randomUUID(), role: "user", content: text, createdAt: new Date().toISOString(), status: "done" };
        this.storage.appendMessage(id, msg);
        const meta = this.storage.listMetas().find((m) => m.id === id);
        if (meta) {
            const messages = this.storage.readMessages(id);
            const updated = {
                ...meta,
                title: meta.title === "新对话" && messages.filter((m) => m.role === "user").length === 1 ? text.slice(0, 32).replace(/\s+/g, " ").trim() || "新对话" : meta.title,
                messageCount: messages.length,
                updatedAt: new Date().toISOString()
            };
            this.storage.upsertMeta(updated);
        }
        return msg;
    }
    listModels() {
        return listChatModels(this.store, this.getQoderStatus);
    }
    abortChat(id) {
        this.activeStreams.get(id)?.abort();
        this.activeStreams.delete(id);
    }
    async sendChatMessage(chatId, messageId, model) {
        if (this.activeStreams.has(chatId))
            this.activeStreams.get(chatId).abort();
        const abort = new AbortController();
        this.activeStreams.set(chatId, abort);
        const messages = this.storage.readMessages(chatId);
        const parsed = parseModelValue(model);
        const qoderToken = parsed.provider === "qoder" ? this.getQoderToken() : undefined;
        const assistantId = randomUUID();
        const assistantMessage = { id: assistantId, role: "assistant", content: "", createdAt: new Date().toISOString(), model: parsed.key, status: "streaming" };
        this.storage.appendMessage(chatId, assistantMessage);
        this.dispatch(chatId, { type: "chat_message_start", chatId, messageId: assistantId, role: "assistant" });
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
                    this.dispatch(chatId, { type: "chat_message_delta", chatId, messageId: assistantId, delta: event.delta });
                }
                else if (event.type === "done") {
                    buffer = event.content || buffer;
                }
                else if (event.type === "error") {
                    this.dispatch(chatId, { type: "chat_message_error", chatId, messageId: assistantId, error: event.error });
                    this.updateAssistantMessage(chatId, assistantId, { content: event.error, status: "error" });
                    this.activeStreams.delete(chatId);
                    return;
                }
            }
            this.updateAssistantMessage(chatId, assistantId, { content: buffer, status: "done" });
            this.dispatch(chatId, { type: "chat_message_done", chatId, messageId: assistantId, content: buffer, model: parsed.key });
            if (meta) {
                this.storage.upsertMeta({ ...meta, updatedAt: new Date().toISOString(), messageCount: this.storage.readMessages(chatId).length });
            }
        }
        catch (reason) {
            this.dispatch(chatId, { type: "chat_message_error", chatId, messageId: assistantId, error: reason instanceof Error ? reason.message : String(reason) });
        }
        finally {
            this.activeStreams.delete(chatId);
        }
    }
    updateAssistantMessage(chatId, assistantId, patch) {
        const file = `${this.dataDir}/chats/chat-${chatId}.jsonl`;
        if (!existsSync(file))
            return;
        const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
        const updated = lines.map((line) => {
            try {
                const parsed = JSON.parse(line);
                if (parsed.id === assistantId)
                    return JSON.stringify({ ...parsed, ...patch });
                return line;
            }
            catch {
                return line;
            }
        });
        writeFileSync(file, updated.join("\n") + "\n");
    }
    dispatch(chatId, event) {
        this.getMainWindow()?.webContents.send("chat:event", event);
        super.emit(chatId, event);
    }
}
//# sourceMappingURL=chat-service.js.map