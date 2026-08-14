import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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

/**
 * 原子写入（异步版）：先写临时文件再 rename,崩溃/断电不产生半写文件。
 */
async function atomicWrite(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await rename(temp, file)
}

async function parseFile<T>(file: string): Promise<T | undefined> {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/**
 * 聊天存储 — driver 透传版（异步 I/O + 内存缓存）。
 *
 * 设计：
 *  - 所有磁盘操作均为 async,不阻塞主进程事件循环;
 *  - index(会话列表 + 项目列表)在内存中缓存,首次访问时懒加载,写操作同步更新缓存;
 *  - 会话文件按 chatId 独立读写,多对话并行互不阻塞;
 *  - 写操作通过 per-file promise chain 串行化,防止并发写导致数据丢失;
 *  - `raw` 字段是 driver 自己的 JSON 形态,Qoder 存 SDK 事件、OpenAI 存 ModelMessage 列表等等;
 *  - driver 加载历史时,通过 `driver.deserializeMessage(record)` 把 `raw` 反序列化为 `parts`;
 *  - 旧 v2 文件 (目录 `chats-v2`) 不会再被读取,直接忽略。
 */
export class ChatStorage {
  /** 内存中的 index 缓存(会话 meta 列表 + 项目列表),避免每次 listMetas 都读磁盘。 */
  private indexCache: ChatIndex | undefined
  /** index 是否已从磁盘尝试加载过(区分"未加载"与"磁盘上确实没有")。 */
  private indexLoaded = false
  /** 目录是否已确保存在。 */
  private dirEnsured = false
  /** 确保目录的 promise(去重,避免并发调用重复 mkdir)。 */
  private dirEnsurePromise: Promise<void> | undefined

  /**
   * 写操作串行化队列:per-file promise chain。
   * 同一文件的写操作按入队顺序执行,不同文件互不阻塞(真正并行)。
   */
  private readonly writeQueues = new Map<string, Promise<void>>()

  constructor(private readonly dataDir: string) {}

  /**
   * 确保存储目录存在(异步,幂等,并发调用只执行一次 mkdir)。
   */
  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return
    if (!this.dirEnsurePromise) {
      this.dirEnsurePromise = mkdir(chatsDir(this.dataDir), { recursive: true }).then(() => {
        this.dirEnsured = true
      })
    }
    await this.dirEnsurePromise
  }

  /**
   * 加载 index(懒加载,只读一次磁盘)。
   */
  private async loadIndex(): Promise<ChatIndex | undefined> {
    if (this.indexLoaded) return this.indexCache
    await this.ensureDir()
    const index = await parseFile<ChatIndex>(indexPath(this.dataDir))
    if (index?.version === STORAGE_VERSION) {
      this.indexCache = index
    }
    this.indexLoaded = true
    return this.indexCache
  }

  /**
   * 把 index 写入磁盘并同步更新内存缓存。
   * 通过 writeQueues 串行化,防止并发写覆盖。
   */
  private enqueueIndexWrite(index: ChatIndex): Promise<void> {
    this.indexCache = index
    this.indexLoaded = true
    const prev = this.writeQueues.get('index') ?? Promise.resolve()
    const next = prev.then(
      () => atomicWrite(indexPath(this.dataDir), index),
      () => atomicWrite(indexPath(this.dataDir), index)
    )
    this.writeQueues.set('index', next)
    return next
  }

  /**
   * 把会话文件写入磁盘。
   * 通过 writeQueues 按 chatId 串行化,不同 chatId 真正并行。
   */
  private enqueueConversationWrite(id: string, file: ChatFile): Promise<void> {
    const path = conversationPath(this.dataDir, id)
    const prev = this.writeQueues.get(path) ?? Promise.resolve()
    const next = prev.then(
      () => atomicWrite(path, file),
      () => atomicWrite(path, file)
    )
    this.writeQueues.set(path, next)
    return next
  }

  /**
   * 获取缓存中的会话 meta 列表(不读磁盘,缓存未加载时先懒加载)。
   */
  private getCachedMetas(): ChatConversationMeta[] {
    if (!this.indexCache || !Array.isArray(this.indexCache.conversations)) return []
    return [...this.indexCache.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * 获取缓存中的项目列表(不读磁盘)。
   */
  private getCachedProjects(): ChatProject[] {
    if (!this.indexCache || !Array.isArray(this.indexCache.projects)) return []
    return [...this.indexCache.projects].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }

  async listMetas(): Promise<ChatConversationMeta[]> {
    await this.loadIndex()
    return this.getCachedMetas()
  }

  /**
   * 列出所有项目(工作目录),按最近活动时间倒序。
   * 项目与会话解耦:目录下所有会话被删除后项目仍保留,UI 显示「没有对话」。
   */
  async listProjects(): Promise<ChatProject[]> {
    await this.loadIndex()
    return this.getCachedProjects()
  }

  async getConversation(id: string): Promise<ChatConversation | undefined> {
    await this.ensureDir()
    const file = await parseFile<ChatFile>(conversationPath(this.dataDir, id))
    if (file?.version !== STORAGE_VERSION || file.conversation?.id !== id || !Array.isArray(file.conversation.messages))
      return undefined
    return file.conversation
  }

  async saveConversation(conversation: ChatConversation): Promise<void> {
    await this.ensureDir()
    const normalized: ChatConversation = { ...conversation, messageCount: conversation.messages.length }
    const file: ChatFile = { version: STORAGE_VERSION, conversation: normalized }
    // 会话文件写入(按 chatId 串行化,不同对话真正并行)。
    await this.enqueueConversationWrite(normalized.id, file)
    // 绑定了工作目录 = 项目对话,顺手记录/刷新项目实体(删除会话时不删项目,见 deleteConversation)。
    if (normalized.workingDirectory) await this.upsertProject(normalized.workingDirectory, normalized.updatedAt)
    await this.upsertMeta((conv) => {
      const { messages: _messages, ...meta } = conv
      return meta
    }, normalized)
  }

  /**
   * 追加单条消息(给"刚发完流,持久化"用)。会读出现有会话 + 替换 messages。
   */
  async appendMessage(
    id: string,
    message: StoredMessageRecord,
    patch: Partial<ChatConversationMeta> = {}
  ): Promise<ChatConversation | undefined> {
    const current = await this.getConversation(id)
    if (!current) return undefined
    const next: ChatConversation = {
      ...current,
      ...patch,
      messages: [...current.messages, message],
      messageCount: current.messages.length + 1,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    }
    await this.saveConversation(next)
    return next
  }

  /**
   * 整体替换会话里的 messages(给"先持久化 user message + 之后持久化 assistant message"用)。
   */
  async replaceMessages(
    id: string,
    messages: StoredMessageRecord[],
    patch: Partial<ChatConversationMeta> = {}
  ): Promise<ChatConversation | undefined> {
    const current = await this.getConversation(id)
    if (!current) return undefined
    const next: ChatConversation = {
      ...current,
      ...patch,
      messages,
      messageCount: messages.length,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    }
    await this.saveConversation(next)
    return next
  }

  /**
   * 更新会话 meta 的若干字段(项目对话绑定/解绑工作目录用),不动 messages。
   */
  async updateMeta(id: string, patch: Partial<ChatConversationMeta>): Promise<ChatConversation | undefined> {
    const current = await this.getConversation(id)
    if (!current) return undefined
    const next: ChatConversation = {
      ...current,
      ...patch,
      messageCount: current.messages.length,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    }
    await this.saveConversation(next)
    return next
  }

  async deleteConversation(id: string): Promise<void> {
    await this.ensureDir()
    const file = conversationPath(this.dataDir, id)
    try {
      await unlink(file)
    } catch {
      /* 文件不存在也无所谓 */
    }
    await this.loadIndex()
    const filtered = this.getCachedMetas().filter((item) => item.id !== id)
    await this.writeIndex(filtered)
  }

  /** 记录/刷新项目实体(目录已存在则只更新 lastActiveAt)。 */
  private async upsertProject(directory: string, lastActiveAt: string): Promise<void> {
    await this.loadIndex()
    const projects = this.getCachedProjects()
    const existing = projects.find((item) => item.directory === directory)
    if (existing) existing.lastActiveAt = lastActiveAt
    else projects.push({ directory, lastActiveAt })
    await this.writeProjects(projects)
  }

  private async writeProjects(projects: ChatProject[]): Promise<void> {
    await this.loadIndex()
    const index: ChatIndex = {
      version: STORAGE_VERSION,
      conversations:
        this.indexCache?.version === STORAGE_VERSION && Array.isArray(this.indexCache.conversations)
          ? this.indexCache.conversations
          : [],
      projects
    }
    await this.enqueueIndexWrite(index)
  }

  private async upsertMeta(
    select: (conversation: ChatConversation) => ChatConversationMeta,
    conversation: ChatConversation
  ): Promise<void> {
    await this.loadIndex()
    const meta = select(conversation)
    const list = this.getCachedMetas()
    const index = list.findIndex((item) => item.id === meta.id)
    if (index >= 0) list[index] = meta
    else list.push(meta)
    await this.writeIndex(list)
  }

  private async writeIndex(conversations: ChatConversationMeta[]): Promise<void> {
    await this.loadIndex()
    const index: ChatIndex = {
      version: STORAGE_VERSION,
      conversations,
      projects: this.trimProjects(conversations)
    }
    await this.enqueueIndexWrite(index)
  }

  /**
   * 项目裁剪:仍有关联会话的项目无条件保留;无会话的"空项目"按 lastActiveAt
   * 倒序只保留最近 MAX_EMPTY_PROJECTS 个,避免随手测试的目录无限堆积。
   */
  private trimProjects(conversations: ChatConversationMeta[]): ChatProject[] {
    const activeDirs = new Set(conversations.map((item) => item.workingDirectory).filter((dir): dir is string => !!dir))
    const kept = new Set<string>()
    let empties = 0
    for (const project of this.getCachedProjects().sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))) {
      if (activeDirs.has(project.directory) || empties < MAX_EMPTY_PROJECTS) {
        kept.add(project.directory)
        if (!activeDirs.has(project.directory)) empties += 1
      }
    }
    return this.getCachedProjects().filter((item) => kept.has(item.directory))
  }
}
