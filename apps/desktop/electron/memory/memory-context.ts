/**
 * Memory 任务上下文：模型选择 / 整理。
 *
 * - resolveTaskChatModel：按任务 runtime 选择 chat 驱动 + 模型；
 * - consolidateTaskMemory / consolidateChatMemory：任务/对话结束后整理长期记忆。
 *
 * 注：任务启动前的记忆检索预注入（旧 `taskMemoryContext`）已下线,改由任务会话注册的
 * `search_memory` 工具按需检索（见 memory-search-tool.ts / qoder-task-agent.ts）。
 */
import type {
  AgentEvent,
  AgentSpan,
  MemorySearchHit,
  RepoWikiSearchHit,
  Task,
  TaskRepository
} from '@task-pipeline/core'
import type { ChatDriverId } from '../chat/chat-types.js'
import type { ChatConversation } from '../chat/chat-types.js'
import { extractMemories } from './memory-extractor.js'

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
    }): Promise<{ memories: MemorySearchHit[]; wikiDocs: RepoWikiSearchHit[]; keywords: string[] }>
    ensureUserId(): string
    consolidateMemories(
      memories: Array<{ content: string; scope: string; keywords?: string[]; title?: string }>,
      repositoryIds: string[],
      conversationId?: string,
      opts?: { validation?: 'implementation' }
    ): number
    verifyTaskMemories(taskId: string): number
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
  addTaskEvent: (event: Omit<AgentEvent, 'id' | 'createdAt'>) => void
  runtimeProvider: (task: Task) => string
  modelProvider: () => string
  resolveOpenAIModelValue: () => string
  syncSystemDefaultModel: () => { provider: string; model: string } | undefined
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
  // 先判 qoder：非 qoder 一律走 OpenAI 兼容 driver（DeepSeek / DashScope 等均走 openai 协议）
  const primary =
    provider === 'qoder'
      ? ({ driverId: 'qoder', model: d().store.getSetting('defaultModel') ?? 'claude-sonnet-4.5' } as const)
      : ({ driverId: 'openai', model: d().resolveOpenAIModelValue() } as const)
  // 存储值失效（profile 删除 / 模型下线）时回落系统默认，可能换 driver。
  if (d().isModelValueAvailable(primary.model)) return primary
  const fallback = d().syncSystemDefaultModel()
  if (!fallback) return primary
  if (fallback.provider === 'qoder') return { driverId: 'qoder', model: fallback.model.replace(/^qoder:/, '') }
  return { driverId: 'openai', model: fallback.model }
}

// ── 记忆整理 ─────────────────────────────────────────────────────────────────

/**
 * 任务执行 runtime（provider 为厂商名）→ chat 驱动映射：
 * - qoder → Qoder driver（model 去 `qoder:` 前缀，driver 内部也会容错）；
 * - 其它厂商（deepseek / openai / openai-compatible / dashscope-* 等）均为 OpenAI 协议 → openai driver，
 *   model 保留厂商前缀交给 driver 按 profile 解析；
 * - 无法映射（缺 provider / model）返回 null，调用方回落 resolveTaskChatModel。
 */
export function toChatRuntime(
  provider: string | undefined,
  model: string | undefined
): { driverId: ChatDriverId; model: string } | null {
  if (!provider || !model) return null
  if (provider === 'qoder') return { driverId: 'qoder', model: model.replace(/^qoder:/, '') }
  return { driverId: 'openai', model }
}

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
    // 注意：resolveRuntime 的 provider 是厂商名（qoder / deepseek / dashscope-token-plan / ...），
    // 不是 driver ID：只有 qoder 对应 Qoder driver，其余 OpenAI 协议厂商一律走 openai driver
    //（model value 保留 `<厂商>:` 前缀，driver 内部按 profile 解析）；此前直接透传，
    // 非 qoder 厂商 tryGet 落空会静默跳过整个记忆提取。
    const runtime = d().agentService.resolveRuntime(task, repos)
    const mapped = toChatRuntime(runtime.provider, runtime.model)
    const { driverId, model } = mapped ?? (await resolveTaskChatModel(task))
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
        `task:${taskId}`,
        // 实现收尾在测试之前：这批结论未经运行验证，先挂起不晋升，
        // 任务 completed 时由 verifyTaskMemoryOnComplete 翻转晋升。
        { validation: 'implementation' }
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
 * 对话整理增量游标：conversation.id → 上次提取时的消息数 + 最后一条已处理
 * 消息 id（识别同长度改写：回退/重新生成时尾部替换，仅比长度会漏报）。
 * 仅进程内维护：重启后回落到全量提取，由写入侧查重兜底；
 * 校验失败（回退/编辑/compaction 重建）时重置游标重新全量提取。
 */
const chatExtractCursors = new Map<string, { count: number; lastId: string | undefined }>()

/**
 * 把会话文本喂给 memory extraction,提取长期记忆。
 *
 * 协议:
 *  - conversation 来自 ChatService,messages 是 StoredMessageRecord(无 parts),
 *    所以这里直接用 driver.deserializeMessage 拼出 parts,提取 text。
 *  - driverId 由 conversation.driverId 决定(单会话切换 driver 时仍用最后选定的 driver 来 extract)。
 *  - 增量提取：只整理游标之后的新消息，避免每回合重复总结全部历史
 *    （配合尾部截断，长对话的最新内容不再被旧内容挤出窗口）。
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
    if (!driver) return
    const messages = input.conversation.messages
    const recorded = chatExtractCursors.get(input.conversation.id)
    let cursor = recorded?.count ?? 0
    // 游标前一条消息被改写/删除（id 不再匹配）说明历史变了：重置全量重提。
    if (recorded && (messages.length < cursor || messages[cursor - 1]?.id !== recorded.lastId)) cursor = 0
    const fresh = messages.slice(cursor)
    if (!fresh.length) return
    const text = fresh
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
    if (!text.trim()) {
      // 无正文（纯工具输出等）也算已处理，推进游标避免每回合重试。
      chatExtractCursors.set(input.conversation.id, {
        count: messages.length,
        lastId: messages[messages.length - 1]?.id
      })
      return
    }
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
    // 提取尝试完成即推进游标（含失败返 []）：回退重试交给下一回合增量，
    // 不重复烧 LLM 调用。
    chatExtractCursors.set(input.conversation.id, {
      count: messages.length,
      lastId: messages[messages.length - 1]?.id
    })
    if (!extracted.length) return
    d().memoryService.consolidateMemories(extracted, repositoryIds, input.conversation.id)
  } catch (error) {
    console.warn('[memory] chat consolidate failed:', error)
  }
}

/**
 * 任务完成钩子（task-lifecycle.updateState 调用）：把该任务实现阶段
 * 挂起的记忆结论翻转为已验证并参与反思晋升。失败不阻断状态流转。
 */
export function verifyTaskMemoryOnComplete(taskId: string): void {
  try {
    d().memoryService.verifyTaskMemories(taskId)
  } catch (error) {
    console.warn('[memory] task memory verify promotion failed:', error)
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
