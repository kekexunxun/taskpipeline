import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatConversation, ChatConversationMeta, ChatProject, StoredMessageRecord } from './chat-types.js'

/**
 * 存储版本。
 *
 * - v2: 旧 ai-sdk 统一结构 (`ChatMessage` 带 `parts: UIMessage.parts`);
 * - v3: driver 透传 (`StoredMessageRecord` 带 `driverId + raw`),完全解耦 ai-sdk。
 *
 * 重构后旧 v2 文件不再被读 (项目未上线,数据可丢),目录名也换成 `chats-v3` 避免混淆。
 */
const STORAGE_VERSION = 3
const INDEX_FILE = 'index.json'

/** 无会话关联的"空项目"最多保留多少个(按 lastActiveAt 倒序淘汰,防无限增长)。 */
const MAX_EMPTY_PROJECTS = 20

type ChatIndex = { version: 3; conversations: ChatConversationMeta[]; projects?: ChatProject[] }
type ChatFile = { version: 3; conversation: ChatConversation }

function chatsDir(root: string) {
  return join(root, 'chats-v3')
}
function indexPath(root: string) {
  return join(chatsDir(root), INDEX_FILE)
}
function conversationPath(root: string, id: string) {
  return join(chatsDir(root), `chat-${id}.json`)
}

function atomicWrite(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2))
  renameSync(temp, file)
}

function parseFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * 聊天存储 — driver 透传版。
 *
 * 设计：
 *  - 存储层完全不解析 `messages` 内部结构:每条消息就是 `{ id, role, createdAt, driverId, raw }` 二元组;
 *  - `raw` 字段是 driver 自己的 JSON 形态,Qoder 存 SDK 事件、OpenAI 存 ModelMessage 列表等等;
 *  - driver 加载历史时,通过 `driver.deserializeMessage(record)` 把 `raw` 反序列化为 `parts`;
 *  - 旧 v2 文件 (目录 `chats-v2`) 不会再被读取,直接忽略。
 */
export class ChatStorage {
  constructor(private readonly dataDir: string) {}

  private ensureDir(): void {
    mkdirSync(chatsDir(this.dataDir), { recursive: true })
  }

  listMetas(): ChatConversationMeta[] {
    this.ensureDir()
    const index = parseFile<ChatIndex>(indexPath(this.dataDir))
    if (index?.version !== STORAGE_VERSION || !Array.isArray(index.conversations)) return []
    return [...index.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * 列出所有项目(工作目录),按最近活动时间倒序。
   * 项目与会话解耦:目录下所有会话被删除后项目仍保留,UI 显示「没有对话」。
   */
  listProjects(): ChatProject[] {
    this.ensureDir()
    const index = parseFile<ChatIndex>(indexPath(this.dataDir))
    if (index?.version !== STORAGE_VERSION || !Array.isArray(index.projects)) return []
    return [...index.projects].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }

  getConversation(id: string): ChatConversation | undefined {
    this.ensureDir()
    const file = parseFile<ChatFile>(conversationPath(this.dataDir, id))
    if (file?.version !== STORAGE_VERSION || file.conversation?.id !== id || !Array.isArray(file.conversation.messages))
      return undefined
    return file.conversation
  }

  saveConversation(conversation: ChatConversation): void {
    this.ensureDir()
    const normalized: ChatConversation = { ...conversation, messageCount: conversation.messages.length }
    atomicWrite(conversationPath(this.dataDir, conversation.id), {
      version: STORAGE_VERSION,
      conversation: normalized
    } satisfies ChatFile)
    // 绑定了工作目录 = 项目对话,顺手记录/刷新项目实体(删除会话时不删项目,见 deleteConversation)。
    if (normalized.workingDirectory) this.upsertProject(normalized.workingDirectory, normalized.updatedAt)
    this.upsertMeta((conv) => {
      const { messages: _messages, ...meta } = conv
      return meta
    }, normalized)
  }

  /**
   * 追加单条消息(给"刚发完流,持久化"用)。会读出现有会话 + 替换 messages。
   */
  appendMessage(
    id: string,
    message: StoredMessageRecord,
    patch: Partial<ChatConversationMeta> = {}
  ): ChatConversation | undefined {
    const current = this.getConversation(id)
    if (!current) return undefined
    const next: ChatConversation = {
      ...current,
      ...patch,
      messages: [...current.messages, message],
      messageCount: current.messages.length + 1,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    }
    this.saveConversation(next)
    return next
  }

  /**
   * 整体替换会话里的 messages(给"先持久化 user message + 之后持久化 assistant message"用)。
   */
  replaceMessages(
    id: string,
    messages: StoredMessageRecord[],
    patch: Partial<ChatConversationMeta> = {}
  ): ChatConversation | undefined {
    const current = this.getConversation(id)
    if (!current) return undefined
    const next: ChatConversation = {
      ...current,
      ...patch,
      messages,
      messageCount: messages.length,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    }
    this.saveConversation(next)
    return next
  }

  /**
   * 更新会话 meta 的若干字段(项目对话绑定/解绑工作目录用),不动 messages。
   */
  updateMeta(id: string, patch: Partial<ChatConversationMeta>): ChatConversation | undefined {
    const current = this.getConversation(id)
    if (!current) return undefined
    const next: ChatConversation = {
      ...current,
      ...patch,
      messageCount: current.messages.length,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    }
    this.saveConversation(next)
    return next
  }

  deleteConversation(id: string): void {
    this.ensureDir()
    const file = conversationPath(this.dataDir, id)
    if (existsSync(file)) unlinkSync(file)
    this.writeIndex(this.listMetas().filter((item) => item.id !== id))
  }

  /** 记录/刷新项目实体(目录已存在则只更新 lastActiveAt)。 */
  private upsertProject(directory: string, lastActiveAt: string): void {
    const projects = this.listProjects()
    const existing = projects.find((item) => item.directory === directory)
    if (existing) existing.lastActiveAt = lastActiveAt
    else projects.push({ directory, lastActiveAt })
    this.writeProjects(projects)
  }

  private writeProjects(projects: ChatProject[]): void {
    const index = parseFile<ChatIndex>(indexPath(this.dataDir))
    atomicWrite(indexPath(this.dataDir), {
      version: STORAGE_VERSION,
      conversations:
        index?.version === STORAGE_VERSION && Array.isArray(index.conversations) ? index.conversations : [],
      projects
    } satisfies ChatIndex)
  }

  private upsertMeta(
    select: (conversation: ChatConversation) => ChatConversationMeta,
    conversation: ChatConversation
  ): void {
    const meta = select(conversation)
    const list = this.listMetas()
    const index = list.findIndex((item) => item.id === meta.id)
    if (index >= 0) list[index] = meta
    else list.push(meta)
    this.writeIndex(list)
  }

  private writeIndex(conversations: ChatConversationMeta[]): void {
    atomicWrite(indexPath(this.dataDir), {
      version: STORAGE_VERSION,
      conversations,
      projects: this.trimProjects(conversations)
    } satisfies ChatIndex)
  }

  /**
   * 项目裁剪:仍有关联会话的项目无条件保留;无会话的"空项目"按 lastActiveAt
   * 倒序只保留最近 MAX_EMPTY_PROJECTS 个,避免随手测试的目录无限堆积。
   */
  private trimProjects(conversations: ChatConversationMeta[]): ChatProject[] {
    const activeDirs = new Set(conversations.map((item) => item.workingDirectory).filter((dir): dir is string => !!dir))
    const kept = new Set<string>()
    let empties = 0
    for (const project of this.listProjects().sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))) {
      if (activeDirs.has(project.directory) || empties < MAX_EMPTY_PROJECTS) {
        kept.add(project.directory)
        if (!activeDirs.has(project.directory)) empties += 1
      }
    }
    return this.listProjects().filter((item) => kept.has(item.directory))
  }
}
