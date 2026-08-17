import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatConversation, ChatConversationMeta, ChatGroup, StoredMessageRecord } from './chat-types.js'

/**
 * 存储版本。
 *
 * - v2: 旧 ai-sdk 统一结构 (`ChatMessage` 带 `parts: UIMessage.parts`);
 * - v3: driver 透传 (`StoredMessageRecord` 带 `driverId + raw`),完全解耦 ai-sdk;
 * - v4: 统一 groups — 原 projects + chat-workspaces.json 合并为 ChatGroup[],
 *       chatType 区分 'directory'(自动) 与 'workspace'(用户创建)。
 *
 * 重构后旧 v2/v3 文件不再被读 (项目未上线,数据可丢),目录名换成 `chats-v4` 避免混淆。
 */
const STORAGE_VERSION = 4
const INDEX_FILE = 'index.json'

/** 无会话关联的"空 directory 组"最多保留多少个(按 updatedAt 倒序淘汰,防无限增长)。workspace 组全部保留。 */
const MAX_EMPTY_GROUPS = 20

/** v3 index 形态(迁移用)。 */
type LegacyV3Index = {
  version: 3
  conversations: ChatConversationMeta[]
  projects?: Array<{ directory: string; lastActiveAt: string }>
}

type ChatIndex = { version: 4; conversations: ChatConversationMeta[]; groups?: ChatGroup[] }
type ChatFile = { version: 4; conversation: ChatConversation }

function chatsDir(root: string) {
  return join(root, 'chats-v4')
}
function legacyChatsDir(root: string) {
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
 *  - index(会话列表 + 分组列表)在内存中缓存,首次访问时懒加载,写操作同步更新缓存;
 *  - 会话文件按 chatId 独立读写,多对话并行互不阻塞;
 *  - 写操作通过 per-file promise chain 串行化,防止并发写导致数据丢失;
 *  - `raw` 字段是 driver 自己的 JSON 形态,Qoder 存 SDK 事件、OpenAI 存 ModelMessage 列表等等;
 *  - driver 加载历史时,通过 `driver.deserializeMessage(record)` 把 `raw` 反序列化为 `parts`;
 *  - 旧 v2/v3 文件不再读取,直接忽略。
 */
export class ChatStorage {
  /** 内存中的 index 缓存(会话 meta 列表 + 分组列表),避免每次 listMetas 都读磁盘。 */
  private indexCache: ChatIndex | undefined
  /** index 是否已从磁盘尝试加载过(区分"未加载"与"磁盘上确实没有")。 */
  private indexLoaded = false
  /** 目录是否已确保存在。 */
  private dirEnsured = false
  /** 确保目录的 promise(去重,避免并发调用重复 mkdir)。 */
  private dirEnsurePromise: Promise<void> | undefined

  /**
   * 对话级别的内存缓存:chatId → ChatConversation。
   *
   * 解决问题:`appendMessage` / `replaceMessages` / `updateMeta` 需要先读出现有对话再修改,
   * 如果从磁盘读(`getConversation`),在并发写(异步 writeQueue)场景下会读到旧数据,
   * 导致后一次写覆盖前一次写的结果(消息丢失)。
   *
   * 缓存策略:
   *  - `saveConversation` 写入时同步更新缓存;
   *  - `getConversation` 优先返回缓存(缓存命中时不读磁盘);
   *  - `deleteConversation` 清除缓存;
   *  - 缓存未命中时回退到磁盘读取(冷启动 / 首次访问)。
   */
  private readonly conversationCache = new Map<string, ChatConversation>()

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
   * 包含 v3 → v4 迁移:如果 v4 不存在但 v3 存在,读取 v3 数据并转换。
   */
  private async loadIndex(): Promise<ChatIndex | undefined> {
    if (this.indexLoaded) return this.indexCache
    await this.ensureDir()
    // 先尝试读 v4
    const index = await parseFile<ChatIndex>(indexPath(this.dataDir))
    if (index?.version === STORAGE_VERSION) {
      this.indexCache = index
      this.indexLoaded = true
      // 异步修复:磁盘上有文件但 index 里丢失的对话(崩溃/竞态导致 index 漏写)。
      void this.reconcileOrphanedConversations()
      return this.indexCache
    }
    // v4 不存在 → 尝试从 v3 迁移
    const migrated = await this.migrateFromV3()
    if (migrated) {
      this.indexCache = migrated
      this.indexLoaded = true
      // 写入 v4
      await this.enqueueIndexWrite(migrated)
      void this.reconcileOrphanedConversations()
      return this.indexCache
    }
    this.indexLoaded = true
    return this.indexCache
  }

  /**
   * v3 → v4 迁移:读取旧 index + chat-workspaces.json,转换为 v4 格式。
   * 同时把 v3 对话文件复制到 v4 目录(仅更新 version 字段,结构不变)。
   * 项目未上线,迁移失败直接返回 undefined(丢弃旧数据)。
   */
  private async migrateFromV3(): Promise<ChatIndex | undefined> {
    const legacyDir = legacyChatsDir(this.dataDir)
    const legacyIndex = await parseFile<LegacyV3Index>(join(legacyDir, INDEX_FILE))
    if (!legacyIndex || legacyIndex.version !== 3) return undefined

    const conversations = Array.isArray(legacyIndex.conversations) ? legacyIndex.conversations : []
    const groups: ChatGroup[] = []

    // 原 projects → directory groups
    if (Array.isArray(legacyIndex.projects)) {
      for (const project of legacyIndex.projects) {
        groups.push({
          id: randomUUID(),
          chatType: 'directory',
          directories: [project.directory],
          createdAt: project.lastActiveAt,
          updatedAt: project.lastActiveAt
        })
      }
    }

    // 原 chat-workspaces.json → workspace groups
    try {
      const wsText = await readFile(join(legacyDir, '..', 'chat-workspaces.json'), 'utf8')
      const workspaces: Array<{ id: string; name: string; directories: string[]; createdAt: string }> =
        JSON.parse(wsText)
      if (Array.isArray(workspaces)) {
        for (const ws of workspaces) {
          groups.push({
            id: ws.id ?? randomUUID(),
            chatType: 'workspace',
            name: ws.name,
            directories: ws.directories ?? [],
            createdAt: ws.createdAt ?? new Date().toISOString(),
            updatedAt: ws.createdAt ?? new Date().toISOString()
          })
        }
      }
    } catch {
      // chat-workspaces.json 不存在或解析失败,跳过
    }

    // 把 v3 对话文件复制到 v4 目录(仅更新 version 字段)
    // 异步执行,不阻塞 index 迁移返回
    void this.copyV3ChatFiles(conversations.map((c) => c.id))

    return { version: 4, conversations, groups }
  }

  /**
   * 批量把 v3 对话文件复制到 v4 目录。单个文件失败不影响其它文件。
   */
  private async copyV3ChatFiles(ids: string[]): Promise<void> {
    await this.ensureDir()
    const legacyDir = legacyChatsDir(this.dataDir)
    for (const id of ids) {
      try {
        const legacyFile = join(legacyDir, `chat-${id}.json`)
        const legacy = await parseFile<{ version: number; conversation: ChatConversation }>(legacyFile)
        if (!legacy?.conversation || legacy.conversation.id !== id) continue
        if (!Array.isArray(legacy.conversation.messages)) continue
        const v4File: ChatFile = { version: STORAGE_VERSION, conversation: legacy.conversation }
        await this.enqueueConversationWrite(id, v4File)
      } catch {
        // 单个文件复制失败不影响其它文件
      }
    }
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
   * 获取缓存中的分组列表(不读磁盘)。
   */
  private getCachedGroups(): ChatGroup[] {
    if (!this.indexCache || !Array.isArray(this.indexCache.groups)) return []
    return [...this.indexCache.groups].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async listMetas(): Promise<ChatConversationMeta[]> {
    await this.loadIndex()
    return this.getCachedMetas()
  }

  /**
   * 列出所有分组(目录 + 工作区),按最近活动时间倒序。
   * 分组与会话解耦:目录下所有会话被删除后分组仍保留,UI 显示「没有对话」。
   */
  async listGroups(): Promise<ChatGroup[]> {
    await this.loadIndex()
    return this.getCachedGroups()
  }

  async getConversation(id: string): Promise<ChatConversation | undefined> {
    // 优先返回内存缓存(避免并发写场景下从磁盘读到旧数据)。
    const cached = this.conversationCache.get(id)
    if (cached) return cached
    await this.ensureDir()
    const file = await parseFile<ChatFile>(conversationPath(this.dataDir, id))
    if (file?.version !== STORAGE_VERSION || file.conversation?.id !== id || !Array.isArray(file.conversation.messages))
      return undefined
    // 写入缓存,后续访问直接命中。
    this.conversationCache.set(id, file.conversation)
    return file.conversation
  }

  async saveConversation(conversation: ChatConversation): Promise<void> {
    await this.ensureDir()
    const normalized: ChatConversation = { ...conversation, messageCount: conversation.messages.length }
    const file: ChatFile = { version: STORAGE_VERSION, conversation: normalized }
    // 同步更新对话缓存(在磁盘写入之前),确保后续 getConversation 拿到最新版本。
    this.conversationCache.set(normalized.id, normalized)
    // 会话文件写入(按 chatId 串行化,不同对话真正并行)。
    await this.enqueueConversationWrite(normalized.id, file)
    // 绑定了工作目录 = 项目对话,更新对应 group
    if (normalized.workingDirectory) {
      await this.upsertGroupForDirectory(normalized.workingDirectory, normalized.updatedAt)
    }
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
    // 按 id 去重：防止与 startPartialPersist 的竞态导致同一条消息被写入两次
    // （partial persist 的 async 回调可能在 appendMessage 之前已读取了旧磁盘快照）。
    const deduped = current.messages.filter((m) => m.id !== message.id)
    const next: ChatConversation = {
      ...current,
      ...patch,
      messages: [...deduped, message],
      messageCount: deduped.length + 1,
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
    // 清除对话缓存。
    this.conversationCache.delete(id)
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

  // === Group 管理 ============================================================

  /**
   * 对话保存时自动创建/刷新 directory 类型 group。
   * 如果 workingDirectory 属于已有 workspace group 的 directories,则刷新该 workspace group。
   */
  private async upsertGroupForDirectory(directory: string, updatedAt: string): Promise<void> {
    await this.loadIndex()
    const groups = this.getCachedGroups()

    // 先检查是否属于已有 workspace group
    const wsGroup = groups.find((g) => g.chatType === 'workspace' && g.directories.includes(directory))
    if (wsGroup) {
      wsGroup.updatedAt = updatedAt
      await this.writeGroups(groups)
      return
    }

    // 否则创建/刷新 directory group
    const existing = groups.find(
      (g) => g.chatType === 'directory' && g.directories.length === 1 && g.directories[0] === directory
    )
    if (existing) {
      existing.updatedAt = updatedAt
    } else {
      groups.push({
        id: randomUUID(),
        chatType: 'directory',
        directories: [directory],
        createdAt: updatedAt,
        updatedAt
      })
    }
    await this.writeGroups(groups)
  }

  /**
   * 创建 workspace 类型 group(用户显式创建)。
   */
  async createGroup(name: string, directories: string[]): Promise<ChatGroup> {
    await this.loadIndex()
    const groups = this.getCachedGroups()
    const now = new Date().toISOString()
    const group: ChatGroup = {
      id: randomUUID(),
      chatType: 'workspace',
      name,
      directories,
      createdAt: now,
      updatedAt: now
    }
    groups.push(group)
    await this.writeGroups(groups)
    return group
  }

  /**
   * 删除 group(用户显式删除 workspace;directory group 一般不手动删除,靠 trim 淘汰)。
   */
  async deleteGroup(id: string): Promise<void> {
    await this.loadIndex()
    const groups = this.getCachedGroups().filter((g) => g.id !== id)
    await this.writeGroups(groups)
  }

  /** 写入 groups 到 index(保留现有 conversations)。 */
  private async writeGroups(groups: ChatGroup[]): Promise<void> {
    await this.loadIndex()
    const index: ChatIndex = {
      version: STORAGE_VERSION,
      conversations:
        this.indexCache?.version === STORAGE_VERSION && Array.isArray(this.indexCache.conversations)
          ? this.indexCache.conversations
          : [],
      groups
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
      groups: this.trimGroups(conversations)
    }
    await this.enqueueIndexWrite(index)
  }

  /**
   * 分组裁剪:仍有关联会话的分组无条件保留;无会话的"空 directory 组"按 updatedAt
   * 倒序只保留最近 MAX_EMPTY_GROUPS 个,避免随手测试的目录无限堆积。
   * workspace 组全部保留(用户显式创建)。
   */
  private trimGroups(conversations: ChatConversationMeta[]): ChatGroup[] {
    const activeDirs = new Set(conversations.map((item) => item.workingDirectory).filter((dir): dir is string => !!dir))
    const kept = new Set<string>()
    let empties = 0
    for (const group of this.getCachedGroups().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      // workspace 组无条件保留
      if (group.chatType === 'workspace') {
        kept.add(group.id)
        continue
      }
      // directory 组:检查是否仍有关联会话
      const dir = group.directories[0]
      if (dir && activeDirs.has(dir)) {
        kept.add(group.id)
      } else if (empties < MAX_EMPTY_GROUPS) {
        kept.add(group.id)
        empties += 1
      }
    }
    return this.getCachedGroups().filter((g) => kept.has(g.id))
  }

  /**
   * 修复孤立对话:扫描磁盘上的 chat-*.json 文件,找出不在 index 中的对话并恢复。
   *
   * 触发时机:`loadIndex` 完成后异步调用(不阻塞首次加载)。
   * 修复方式:读取孤立文件的 conversation,补入 index(同时写入对话缓存).
   */
  private async reconcileOrphanedConversations(): Promise<void> {
    await this.ensureDir()
    await this.loadIndex()
    const indexIds = new Set(this.getCachedMetas().map((m) => m.id))

    let entries: string[]
    try {
      entries = await readdir(chatsDir(this.dataDir))
    } catch {
      return
    }

    const orphanIds: string[] = []
    for (const entry of entries) {
      if (!entry.startsWith('chat-') || !entry.endsWith('.json')) continue
      const id = entry.slice(5, entry.length - 5) // 'chat-'.length = 5, '.json'.length = 5
      if (!indexIds.has(id)) orphanIds.push(id)
    }

    if (orphanIds.length === 0) return

    let recovered = 0
    for (const id of orphanIds) {
      try {
        const file = await parseFile<ChatFile>(conversationPath(this.dataDir, id))
        if (!file?.conversation || file.conversation.id !== id || !Array.isArray(file.conversation.messages)) continue
        // 写入缓存 + 补入 index。
        this.conversationCache.set(id, file.conversation)
        const meta = (({ messages: _messages, ...rest }) => rest)(file.conversation)
        await this.upsertMeta(() => meta, file.conversation)
        recovered++
      } catch {
        // 单个文件修复失败不影响其它文件。
      }
    }

    if (recovered > 0) {
      console.warn(`[chat-storage] reconciled ${recovered} orphaned conversation(s): ${orphanIds.join(', ')}`)
    }
  }
}
