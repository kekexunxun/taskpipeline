import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const STORAGE_VERSION = 2;
const INDEX_FILE = "index.json";
function chatsDir(root) { return join(root, "chats-v2"); }
function indexPath(root) { return join(chatsDir(root), INDEX_FILE); }
function conversationPath(root, id) { return join(chatsDir(root), `chat-${id}.json`); }
function atomicWrite(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2));
    renameSync(temp, file);
}
function parseFile(file) {
    if (!existsSync(file))
        return undefined;
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return undefined;
    }
}
export class ChatStorage {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    ensureDir() { mkdirSync(chatsDir(this.dataDir), { recursive: true }); }
    listMetas() {
        this.ensureDir();
        const index = parseFile(indexPath(this.dataDir));
        if (index?.version !== STORAGE_VERSION || !Array.isArray(index.conversations))
            return [];
        return [...index.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    getConversation(id) {
        this.ensureDir();
        const file = parseFile(conversationPath(this.dataDir, id));
        if (file?.version !== STORAGE_VERSION || file.conversation?.id !== id || !Array.isArray(file.conversation.messages))
            return undefined;
        return file.conversation;
    }
    saveConversation(conversation) {
        this.ensureDir();
        const normalized = { ...conversation, messageCount: conversation.messages.length };
        atomicWrite(conversationPath(this.dataDir, conversation.id), { version: STORAGE_VERSION, conversation: normalized });
        this.upsertMeta(({ messages: _messages, ...meta }) => meta, normalized);
    }
    replaceMessages(id, messages, patch = {}) {
        const current = this.getConversation(id);
        if (!current)
            return undefined;
        const next = { ...current, ...patch, messages, messageCount: messages.length, updatedAt: patch.updatedAt ?? new Date().toISOString() };
        this.saveConversation(next);
        return next;
    }
    deleteConversation(id) {
        this.ensureDir();
        const file = conversationPath(this.dataDir, id);
        if (existsSync(file))
            unlinkSync(file);
        this.writeIndex(this.listMetas().filter((item) => item.id !== id));
    }
    upsertMeta(select, conversation) {
        const meta = select(conversation);
        const list = this.listMetas();
        const index = list.findIndex((item) => item.id === meta.id);
        if (index >= 0)
            list[index] = meta;
        else
            list.push(meta);
        this.writeIndex(list);
    }
    writeIndex(conversations) {
        atomicWrite(indexPath(this.dataDir), { version: STORAGE_VERSION, conversations });
    }
}
//# sourceMappingURL=chat-storage.js.map