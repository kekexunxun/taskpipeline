import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  model?: string;
  status?: "streaming" | "done" | "error";
};

export type ChatConversationMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: "qoder" | "openai";
  messageCount: number;
};

const INDEX_FILE = "_index.jsonl";

function chatDir(root: string): string { return join(root, "chats"); }
function ensureDir(root: string): void {
  const dir = chatDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function indexPath(root: string): string { return join(chatDir(root), INDEX_FILE); }
function messagesPath(root: string, id: string): string { return join(chatDir(root), `chat-${id}.jsonl`); }

function safeParse<T>(line: string): T | undefined {
  try { return JSON.parse(line) as T; } catch { return undefined; }
}

function appendLine(file: string, data: unknown): void {
  writeFileSync(file, `${JSON.stringify(data)}\n`, { flag: "a" });
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf8");
  if (!content.trim()) return [];
  return content.split("\n").filter(Boolean).map((line) => safeParse<T>(line)).filter((v): v is T => Boolean(v));
}

export class ChatStorage {
  constructor(private readonly dataDir: string) {}

  private withDir(): void { ensureDir(this.dataDir); }

  listMetas(): ChatConversationMeta[] {
    this.withDir();
    return readLines<ChatConversationMeta>(indexPath(this.dataDir)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  readMessages(id: string): ChatMessage[] {
    this.withDir();
    return readLines<ChatMessage>(messagesPath(this.dataDir, id));
  }

  appendMessage(id: string, message: ChatMessage): void {
    this.withDir();
    appendLine(messagesPath(this.dataDir, id), message);
  }

  upsertMeta(meta: ChatConversationMeta): void {
    this.withDir();
    const list = this.listMetas();
    const idx = list.findIndex((item) => item.id === meta.id);
    if (idx >= 0) list[idx] = meta; else list.push(meta);
    writeFileSync(indexPath(this.dataDir), list.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }

  deleteConversation(id: string): void {
    this.withDir();
    const file = messagesPath(this.dataDir, id);
    if (existsSync(file)) unlinkSync(file);
    const list = this.listMetas().filter((m) => m.id !== id);
    writeFileSync(indexPath(this.dataDir), list.map((m) => JSON.stringify(m)).join("\n") + (list.length ? "\n" : ""));
  }
}
