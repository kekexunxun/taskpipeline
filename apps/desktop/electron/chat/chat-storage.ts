import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatConversation, ChatConversationMeta, ChatMessage } from "./chat-types.js";

const STORAGE_VERSION = 2;
const INDEX_FILE = "index.json";

type ChatIndex = { version: 2; conversations: ChatConversationMeta[] };
type ChatFile = { version: 2; conversation: ChatConversation };

function chatsDir(root: string) { return join(root, "chats-v2"); }
function indexPath(root: string) { return join(chatsDir(root), INDEX_FILE); }
function conversationPath(root: string, id: string) { return join(chatsDir(root), `chat-${id}.json`); }

function atomicWrite(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}

function parseFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; }
}

export class ChatStorage {
  constructor(private readonly dataDir: string) {}

  private ensureDir(): void { mkdirSync(chatsDir(this.dataDir), { recursive: true }); }

  listMetas(): ChatConversationMeta[] {
    this.ensureDir();
    const index = parseFile<ChatIndex>(indexPath(this.dataDir));
    if (index?.version !== STORAGE_VERSION || !Array.isArray(index.conversations)) return [];
    return [...index.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getConversation(id: string): ChatConversation | undefined {
    this.ensureDir();
    const file = parseFile<ChatFile>(conversationPath(this.dataDir, id));
    if (file?.version !== STORAGE_VERSION || file.conversation?.id !== id || !Array.isArray(file.conversation.messages)) return undefined;
    return file.conversation;
  }

  saveConversation(conversation: ChatConversation): void {
    this.ensureDir();
    const normalized = { ...conversation, messageCount: conversation.messages.length };
    atomicWrite(conversationPath(this.dataDir, conversation.id), { version: STORAGE_VERSION, conversation: normalized } satisfies ChatFile);
    this.upsertMeta(({ messages: _messages, ...meta }) => meta, normalized);
  }

  replaceMessages(id: string, messages: ChatMessage[], patch: Partial<ChatConversationMeta> = {}): ChatConversation | undefined {
    const current = this.getConversation(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, messages, messageCount: messages.length, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    this.saveConversation(next);
    return next;
  }

  deleteConversation(id: string): void {
    this.ensureDir();
    const file = conversationPath(this.dataDir, id);
    if (existsSync(file)) unlinkSync(file);
    this.writeIndex(this.listMetas().filter((item) => item.id !== id));
  }

  private upsertMeta(select: (conversation: ChatConversation) => ChatConversationMeta, conversation: ChatConversation): void {
    const meta = select(conversation);
    const list = this.listMetas();
    const index = list.findIndex((item) => item.id === meta.id);
    if (index >= 0) list[index] = meta; else list.push(meta);
    this.writeIndex(list);
  }

  private writeIndex(conversations: ChatConversationMeta[]): void {
    atomicWrite(indexPath(this.dataDir), { version: STORAGE_VERSION, conversations } satisfies ChatIndex);
  }
}
