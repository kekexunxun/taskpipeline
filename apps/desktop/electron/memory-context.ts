/**
 * Memory 任务上下文：检索 / 注入 / 整理。
 *
 * - resolveTaskChatModel：按任务 runtime 选择 chat 驱动 + 模型；
 * - taskMemoryContext：为任务 prompt 检索记忆上下文；
 * - consolidateTaskMemory / consolidateChatMemory：任务/对话结束后整理长期记忆。
 */
import type {
  AgentSpan,
  MemoryScope,
  MemorySearchHit,
  RepoWikiSearchHit,
  Task,
  TaskRepository
} from '@task-pipeline/core'
import type { ChatDriverId } from './chat/chat-types.js'
import type { ChatConversation } from './chat/chat-types.js'
import type { KeywordRewriter } from './memory/memory-service.js'
import { renderMemoryContext } from './memory/memory-service.js'
import { extractMemories } from './memory/memory-extractor.js'
import { extractKeywords } from './memory/memory-keyword-extractor.js'

// ── 依赖注入（main.ts 初始化时传入） ─────────────────────────────────────────

interface MemoryContextDeps {
  store: {
    getTask(id: string): Task | undefined
    listTaskRepositories(taskId: string): TaskRepository[]
    listEvents(taskId: string): Array<{ kind: string; title: string; detail?: string }>
    getSetting(key: string): string | undefined
    listRepositoryProfiles(): Array<{ id: string; localPath: string }>
  }
  memoryService: {
    search(input: {
      userId: string
      repositoryIds?: string[]
      conversationId?: string
      query: string
      keywordRewriter?: KeywordRewriter
    }): Promise<{ memories: MemorySearchHit[]; wikiDocs: RepoWikiSearchHit[]; keywords: string[] }>
    ensureUserId(): string
    consolidateMemories(
      memories: Array<{ content: string; scope: string; keywords?: string[]; title?: string }>,
      repositoryIds: string[],
      conversationId?: string
    ): number
  }
  chatDriverRegistry: {
    tryGet(
      driverId: string
    ): { deserializeMessage(record: unknown): { parts: Array<{ type: string; text?: string }> } } | undefined
  }
  agentService: {
    resolveRuntime(task: Task, repos: TaskRepository[]): { provider?: string; model?: string }
  }
  tracePipeline: {
    isActive(taskId: string): boolean
    beginTrace(input: Record<string, unknown>): void
    ensureRootSpan(taskId: string, span: Record<string, unknown>): void
    startSpan(taskId: string, span: Record<string, unknown>): AgentSpan
    endSpan(taskId: string, span: AgentSpan): void
    endTrace(taskId: string): void
  }
  addTaskEvent: (event: { taskId: string; kind: string; title: string; detail?: string }) => void
  runtimeProvider: (task: Task) => 'qoder' | 'openai'
  modelProvider: () => 'qoder' | 'openai'
  resolveOpenAIModelValue: () => string
  syncSystemDefaultModel: () => { provider: 'qoder' | 'openai'; model: string } | undefined
  isModelValueAvailable: (model: string) => boolean
  resolveLiteModel: (driverId: ChatDriverId) => Promise<string>
  startTaskStageSpan: (task: Task | undefined, taskId: string, name: string, phase: string) => AgentSpan | undefined
}

let deps: MemoryContextDeps | null = null

export function initMemoryContext(d: MemoryContextDeps): void {
  deps = d
}

function d(): MemoryContextDeps {
  if (!deps) throw new Error('memory-context not initialized')
  return deps
}

// ── 模型选择 ─────────────────────────────────────────────────────────────────

/**
 * 选择任务上下文检索 / 关键词提取用的 chat 模型。
 * - 有 task 时跟随任务 runtime provider（任务显式 qoderModel > Agent preferredProvider > 系统全局），
 *   否则关键词提取会跟全局 modelProfile 走错驱动（用户配了 OpenAI profile 时任务明明是 Qoder 却走 openai）；
 * - 无 task（对话记忆检索等）时跟随系统 modelProfile。
 * - model 是 OpenAI 协议下的具体模型 value（`openai:<model>`，Qoder 模式下不使用,driver 内部自己拿默认）
 */
export async function resolveTaskChatModel(task?: Task): Promise<{ driverId: ChatDriverId; model: string }> {
  const provider = task ? d().runtimeProvider(task) : d().modelProvider()
  const primary =
    provider === 'openai'
      ? ({ driverId: 'openai', model: d().resolveOpenAIModelValue() } as const)
      : ({ driverId: 'qoder', model: d().store.getSetting('defaultModel') ?? 'claude-sonnet-4.5' } as const)
  // 存储值失效（profile 删除 / 模型下线）时回落系统默认，可能换 driver。
  if (d().isModelValueAvailable(primary.model)) return primary
  const fallback = d().syncSystemDefaultModel()
  if (!fallback) return primary
  if (fallback.provider === 'qoder') return { driverId: 'qoder', model: fallback.model.replace(/^qoder:/, '') }
  return { driverId: 'openai', model: fallback.model }
}

// ── 关键词提取 ───────────────────────────────────────────────────────────────

/**
 * 带 trace 归属的关键词提取：辅助 LLM 调用显式 join 所属回合/任务 trace
 * （一次用户提问 = 一个 Trace），避免关键词提取产生独立 trace 记录。
 * 传 task 时模型驱动跟随任务 runtime provider（Qoder 任务走 qoder-lite，不跟全局 OpenAI profile）。
 */
export async function keywordRewriterWithTrace(query: string, traceId?: string, task?: Task): Promise<string[]> {
  const { driverId } = await resolveTaskChatModel(task)
  const driver = d().chatDriverRegistry.tryGet(driverId)
  if (!driver) return []
  const model = await d().resolveLiteModel(driverId)
  return extractKeywords({ driver: driver as never, driverId, model, text: query, traceId })
}

// ── 任务记忆检索 ─────────────────────────────────────────────────────────────

export async function taskMemoryContext(task: Task, repos: TaskRepository[]): Promise<string | undefined> {
  try {
    // 关键词提取走 LLM 同步起调用(Qoder 跳 lite,OpenAI 跟随),需要把这一步单独记
    // 到 trace 里:模型、返回的关键词数组、耗时。生产环境调 OpenAI 关键词提取本身
    // 一次几百毫秒 ~ 几秒,不记会让用户看到"检索"却不知道背后是 LLM 调用,trace 会误导。
    // 驱动跟随任务 runtime provider（Qoder 任务即使全局配了 OpenAI profile 也走 qoder-lite）。
    const { driverId } = await resolveTaskChatModel(task)
    const keywordModel = await d().resolveLiteModel(driverId)
    const tracedRewriter: KeywordRewriter = async (query) => {
      const start = Date.now()
      try {
        const kw = await keywordRewriterWithTrace(query, task.id, task)
        const ms = Date.now() - start
        d().addTaskEvent({
          taskId: task.id,
          kind: 'status',
          title: 'LLM 提取检索关键词',
          detail: `模型：${keywordModel}\n驱动：${driverId}\n关键词：${kw.length ? kw.join('、') : '（空，已回退到 fallbackKeywords）'}\n耗时：${ms} ms`
        })
        return kw
      } catch (error) {
        const ms = Date.now() - start
        d().addTaskEvent({
          taskId: task.id,
          kind: 'error',
          title: 'LLM 提取检索关键词失败',
          detail: `模型：${keywordModel}\n驱动：${driverId}\n耗时：${ms} ms\n${error instanceof Error ? error.message : String(error)}`
        })
        throw error
      }
    }
    const searchResult = await d().memoryService.search({
      userId: d().memoryService.ensureUserId(),
      repositoryIds: repos.map((repo) => repo.repositoryId),
      conversationId: `task:${task.id}`,
      query: `${task.title}\n${task.description}`,
      keywordRewriter: tracedRewriter
    })
    const { memories, wikiDocs, keywords } = searchResult
    d().addTaskEvent({
      taskId: task.id,
      kind: 'status',
      title: '检索记忆上下文',
      // 顶部拼接驱动 + 模型,跟「LLM 提取检索关键词」一致 —— 记忆检索只走 FTS5,
      // 但 FTS5 喂什么词是 LLM 决定的,用户要能看到这条线索。
      detail: formatMemorySearchDetail(memories, wikiDocs, keywords, { driverId, model: keywordModel })
    })
    const memoryContext = renderMemoryContext(memories, wikiDocs)
    // 独立发一条「注入记忆上下文」:与「注入 Agent 上下文」对称,验证检索出的内容真的
    // 进了 prompt。原实现只在「检索」上 addTaskEvent,不告诉调用方拼了什么,trace 上
    // 看不到实际注入的文本(只能去 hooks / driver 里推)。
    if (memoryContext) {
      d().addTaskEvent({
        taskId: task.id,
        kind: 'status',
        title: '注入记忆上下文',
        detail:
          memoryContext.length > 2000
            ? `${memoryContext.slice(0, 2000)}\n…（已截断，原文 ${memoryContext.length} 字）`
            : memoryContext
      })
    }
    return memoryContext
  } catch (error) {
    console.warn('[memory] task context failed:', error)
    return undefined
  }
}

// ── 格式化辅助 ───────────────────────────────────────────────────────────────

/**
 * 把 memoryService.search 返回结果格式化为可读的 trace detail。
 * - 按 scope 分组列出（用户 / 仓库 / 对话 / repowiki）；
 * - 每条带标题 + score + 200 字预览；
 * - 顶部拼接驱动 + 模型（与「LLM 提取检索关键词」对齐 + 备注命中总数 / 关键词）。
 */
function formatMemorySearchDetail(
  memories: MemorySearchHit[],
  wikiDocs: RepoWikiSearchHit[],
  keywords: string[],
  meta: { driverId: string; model: string }
): string {
  const scopeLabel: Record<MemoryScope, string> = { user: '用户', repo: '仓库', conversation: '对话' }
  const total = memories.length + wikiDocs.length
  const header = [`驱动：${meta.driverId}`, `模型：${meta.model}`, `命中：${total} 条`]
  if (total === 0) {
    return [
      ...header,
      `未命中任何记忆（用户级 / 仓库级 / 对话级 / repowiki）。`,
      `关键词：${keywords.length ? keywords.join('、') : '（空）'}`
    ].join('\n')
  }
  const lines: string[] = [...header, `关键词：${keywords.join('、')}`]
  const grouped = new Map<MemoryScope, MemorySearchHit[]>()
  for (const m of memories) {
    if (!grouped.has(m.scope)) grouped.set(m.scope, [])
    grouped.get(m.scope)!.push(m)
  }
  for (const scope of ['user', 'repo', 'conversation'] as MemoryScope[]) {
    const list = grouped.get(scope)
    if (!list?.length) continue
    lines.push(`\n[${scopeLabel[scope]}级] ${list.length} 条`)
    for (const hit of list) {
      const preview = hit.content.length > 200 ? `${hit.content.slice(0, 200)}…` : hit.content
      lines.push(`- ${hit.title}（score ${hit.score.toFixed(1)}）\n  ${preview.replace(/\n+/g, ' ')}`)
    }
  }
  if (wikiDocs.length) {
    lines.push(`\n[repowiki] ${wikiDocs.length} 篇`)
    for (const doc of wikiDocs) {
      const preview = doc.content.length > 200 ? `${doc.content.slice(0, 200)}…` : doc.content
      lines.push(`- ${doc.path}（score ${doc.score.toFixed(1)}）\n  ${preview.replace(/\n+/g, ' ')}`)
    }
  }
  return lines.join('\n')
}

// ── 记忆整理 ─────────────────────────────────────────────────────────────────

export async function consolidateTaskMemory(taskId: string, responseTexts: string[]): Promise<void> {
  try {
    const task = d().store.getTask(taskId)
    if (!task) return
    const repos = d().store.listTaskRepositories(taskId)
    const events = d().store.listEvents(taskId)
    const transcript = [
      `任务：${task.title}\n${task.description}`,
      task.planContent ? `计划：\n${task.planContent}` : '',
      ...events.slice(-80).map((event) => `[${event.kind}] ${event.title}${event.detail ? `\n${event.detail}` : ''}`),
      ...responseTexts.slice(-5).map((text) => `AI 输出：\n${text}`)
    ].join('\n\n')
    // 复用任务执行模型（任务显式 > Agent 配置 > 系统默认），与任务同路径同模型整理记忆；
    // 缺运行时解析结果时回落任务级 chat 模型解析。
    const runtime = d().agentService.resolveRuntime(task, repos)
    const { driverId, model } =
      runtime.provider && runtime.model
        ? { driverId: runtime.provider as ChatDriverId, model: runtime.model }
        : await resolveTaskChatModel(task)
    const driver = d().chatDriverRegistry.tryGet(driverId)
    if (!driver) return
    // 记忆整理并入任务 Trace（不再产生独立 chat trace）：阶段容器（phase: memory）
    // + traceId join 任务执行树。trace 本不活跃（任务已终态）时 beginTrace 重开它，
    // 结束后由这里兜底 endTrace；活跃期 join 的收尾归 finalizeTaskTrace。
    const wasActive = d().tracePipeline.isActive(taskId)
    const stage = d().startTaskStageSpan(task, taskId, '记忆整理', 'memory')
    const joined = d().tracePipeline.isActive(taskId)
    try {
      const extracted = await extractMemories({
        driver: driver as never,
        driverId,
        model,
        text: transcript,
        context: 'task',
        allowedScopes: ['user', 'repo'],
        ...(joined ? { traceId: taskId } : {})
      })
      if (!extracted.length) return
      const saved = d().memoryService.consolidateMemories(
        extracted,
        repos.map((repo) => repo.repositoryId),
        `task:${taskId}`
      )
      if (saved > 0) {
        d().addTaskEvent({
          taskId,
          kind: 'status',
          title: '记忆整理完成',
          detail: `从任务执行记录中整理并保存 ${saved} 条记忆`
        })
      }
    } finally {
      if (stage) {
        try {
          d().tracePipeline.endSpan(taskId, stage)
        } catch {
          /* trace 收尾失败不影响整理结果 */
        }
      }
      if (!wasActive && joined) {
        try {
          d().tracePipeline.endTrace(taskId)
        } catch {
          /* endTrace 幂等，与 finalizeTaskTrace 双触发安全 */
        }
      }
    }
  } catch (error) {
    console.warn('[memory] task consolidate failed:', error)
  }
}

/**
 * 把会话文本喂给 memory extraction,提取长期记忆。
 *
 * 协议:
 *  - conversation 来自 ChatService,messages 是 StoredMessageRecord(无 parts),
 *    所以这里直接用 driver.deserializeMessage 拼出 parts,提取 text。
 *  - driverId 由 conversation.driverId 决定(单会话切换 driver 时仍用最后选定的 driver 来 extract)。
 */
export async function consolidateChatMemory(input: {
  conversation: ChatConversation
  signal: AbortSignal
  driverId: ChatDriverId
  model: string
  /** 所属对话回合 traceId：记忆整理 LLM 调用 join 同一执行树。 */
  traceId?: string
}): Promise<void> {
  try {
    const driver = d().chatDriverRegistry.tryGet(input.driverId)
    const text = input.conversation.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        const record = message
        const parts: Array<{ type: string; text?: string }> = driver
          ? (driver.deserializeMessage(record) as { parts: Array<{ type: string; text?: string }> }).parts
          : []
        const messageText = parts
          .filter((part) => part.type === 'text' && part.text)
          .map((part) => part.text!)
          .join('')
        return `${message.role === 'user' ? '用户' : '助手'}：${messageText}`
      })
      .join('\n\n')
    if (!text.trim()) return
    if (!driver) return
    // 项目对话（有 workingDirectory）：匹配 repository_profiles 的 localPath，
    // 允许 'repo' scope 并传入 repositoryIds，让工程约定类记忆正确归入仓库级而非用户级。
    const repositoryIds = resolveRepositoryIdsFromWorkingDirectory(input.conversation.workingDirectory)
    const allowedScopes: Array<'user' | 'repo' | 'conversation'> = repositoryIds.length
      ? ['repo', 'user', 'conversation']
      : ['user', 'conversation']
    const extracted = await extractMemories({
      driver: driver as never,
      driverId: input.driverId,
      model: input.model,
      text,
      context: 'chat',
      allowedScopes,
      signal: input.signal,
      // join 当前对话回合：记忆整理 LLM 调用与主对话同树。
      traceId: input.traceId
    })
    if (!extracted.length) return
    d().memoryService.consolidateMemories(extracted, repositoryIds, input.conversation.id)
  } catch (error) {
    console.warn('[memory] chat consolidate failed:', error)
  }
}

/**
 * 根据对话的 workingDirectory 匹配 repository_profiles 的 localPath，
 * 返回对应的 repositoryId 数组。路径匹配采用前缀匹配（支持 worktree / 子目录场景）。
 */
function resolveRepositoryIdsFromWorkingDirectory(workingDirectory: string | undefined): string[] {
  if (!workingDirectory) return []
  const profiles = d().store.listRepositoryProfiles()
  const matched = profiles.filter(
    (profile) => workingDirectory === profile.localPath || workingDirectory.startsWith(profile.localPath + '/')
  )
  return matched.map((profile) => profile.id)
}
