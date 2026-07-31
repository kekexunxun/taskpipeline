import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const INDEX_FILE = "_index.jsonl";
function chatDir(root) { return join(root, "chats"); }
function ensureDir(root) {
    const dir = chatDir(root);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
function indexPath(root) { return join(chatDir(root), INDEX_FILE); }
function messagesPath(root, id) { return join(chatDir(root), `chat-${id}.jsonl`); }
function safeParse(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    }
}
function appendLine(file, data) {
    writeFileSync(file, `${JSON.stringify(data)}\n`, { flag: "a" });
}
function readLines(file) {
    if (!existsSync(file))
        return [];
    const content = readFileSync(file, "utf8");
    if (!content.trim())
        return [];
    return content.split("\n").filter(Boolean).map((line) => safeParse(line)).filter((v) => Boolean(v));
}
export class ChatStorage {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    withDir() { ensureDir(this.dataDir); }
    listMetas() {
        this.withDir();
        return readLines(indexPath(this.dataDir)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    readMessages(id) {
        this.withDir();
        return readLines(messagesPath(this.dataDir, id));
    }
    appendMessage(id, message) {
        this.withDir();
        appendLine(messagesPath(this.dataDir, id), message);
    }
    upsertMeta(meta) {
        this.withDir();
        const list = this.listMetas();
        const idx = list.findIndex((item) => item.id === meta.id);
        if (idx >= 0)
            list[idx] = meta;
        else
            list.push(meta);
        writeFileSync(indexPath(this.dataDir), list.map((m) => JSON.stringify(m)).join("\n") + "\n");
    }
    deleteConversation(id) {
        this.withDir();
        const file = messagesPath(this.dataDir, id);
        if (existsSync(file))
            unlinkSync(file);
        const list = this.listMetas().filter((m) => m.id !== id);
        writeFileSync(indexPath(this.dataDir), list.map((m) => JSON.stringify(m)).join("\n") + (list.length ? "\n" : ""));
    }
}
//# sourceMappingURL=chat-storage.js.map