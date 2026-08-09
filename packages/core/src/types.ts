export const BOARD_COLUMNS = ['todo', 'in_progress', 'in_review', 'done'] as const
export type BoardColumn = (typeof BOARD_COLUMNS)[number]

export const TASK_STATES = [
  'draft',
  'confirmed',
  'preparing',
  'planning',
  'awaiting_plan_approval',
  'implementing',
  'paused',
  'awaiting_input',
  'generating_tests',
  'validating',
  'validation_failed',
  'awaiting_review',
  'reviewing',
  'review_blocked',
  'awaiting_commit',
  'delivering',
  'await_merge',
  'completed',
  'failed',
  'cancelled'
] as const
export type TaskState = (typeof TASK_STATES)[number]
export type TaskStartMode = 'direct' | 'plan'
export type TaskFailureStage = 'preparing' | 'planning' | 'implementing' | 'validating'
export type TaskSource = 'local' | 'jira' | 'github' | 'linear'

export type Task = {
  id: string
  taskKey?: string
  source: TaskSource
  sourceUrl?: string
  title: string
  description: string
  keywords: string[]
  acceptanceCriteria: string[]
  state: TaskState
  summary?: string
  startMode?: TaskStartMode
  planContent?: string
  planRevision?: number
  failureStage?: TaskFailureStage
  reviewStatus: 'pending' | 'running' | 'passed' | 'blocked' | 'waived'
  commitMessage?: string
  piSessionPath?: string
  qoderModel?: string
  /** Qoder Agent SDK 最近一次执行会话的 session_id，用于失败后续接时按 ID 恢复对话上下文。 */
  qoderSessionId?: string
  sessionUsage?: SessionUsage
  /**
   * 任务级覆盖：实现完成后是否自动跑 Code Review。
   * `undefined` 表示沿用系统设置；显式布尔值在任务执行期间独立生效。
   */
  openCodeReviewEnabled?: boolean
  /** 任务级覆盖：Review 通过后是否自动提交 Merge Request。 */
  autoCreateMergeRequests?: boolean
  /** 任务级覆盖：实现完成后是否先生成最小测试集，再进入校验/Review。 */
  createTestCasesEnabled?: boolean
  /**
   * 任务级 Agent 覆盖：指定 Agent id 时强制使用该 Agent（不再按仓库白名单解析）；
   * `AGENT_TASK_DISABLED` 表示本任务禁用 Agent 注入，跟随系统模型设置。
   * `undefined` 表示沿用仓库白名单解析（默认）。
   */
  agentProfileId?: string
  /**
   * 逐仓库 Agent 覆盖：key 为仓库 repositoryId，value 为 Agent id。
   * 优先级高于 task 级 agentProfileId，但低于仓库绑定 Agent。
   */
  repoAgentIds?: Record<string, string>
  /** 最近一次测试用例生成的摘要，用于 Timeline 展示。 */
  testsGenerated?: { files: string[]; commitSha?: string; finishedAt: string }
  /** Phase 4：Review 自动修订已执行的轮数（达到 reviewAutoFixMaxRounds 后停止）。 */
  reviewFixCount?: number
  createdAt: string
  updatedAt: string
}

export type SessionUsage = {
  provider: 'qoder' | 'openai'
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  costUsd?: number
  durationMs?: number
  turns?: number
}

export type TaskRepository = {
  id: string
  taskId: string
  repositoryId: string
  name: string
  localPath: string
  baseBranch: string
  setupCommand?: string
  lintCommand?: string
  testCommand?: string
  buildCommand?: string
  featureBranch?: string
  worktreePath?: string
  changeSummary?: string
  commitSha?: string
  mergeRequestUrl?: string
  mergeRequestIid?: number
  mergeRequestState?: 'opened' | 'merged' | 'closed'
  mergeRequestCheckedAt?: string
  deliveryStatus:
    | 'pending'
    | 'unchanged'
    | 'changed'
    | 'committed'
    | 'pushed'
    | 'mr_created'
    | 'workspace_removed'
    | 'failed'
}

export type TaskCard = Task & {
  boardColumn: BoardColumn
  repositories: (Pick<TaskRepository, 'id' | 'name' | 'changeSummary' | 'mergeRequestUrl' | 'deliveryStatus'> & {
    changedFileCount?: number
  })[]
}

export type AgentEvent = {
  id: string
  taskId: string
  kind: 'message' | 'tool' | 'permission' | 'command' | 'diff' | 'review' | 'error' | 'status'
  title: string
  detail?: string
  payload?: unknown
  createdAt: string
  /**
   * 归属子任务 ID（Qoder 子 Agent）。
   *
   * - 与 `TraceEntry.parentTaskId` 语义一致: undefined 表示主流程,有值表示嵌套在子任务内。
   * - 由 `recordQoderMessage` 透传 SDKMessage.parent_tool_use_id 反查 task_started 的结果。
   * - 其它源(本地状态变更 / 内存注入 / 用户操作)不携带该字段。
   *
   * 命名说明: `taskId` 已是 AgentEvent 归属任务的 ID,这里另起 `parentTaskId`(本字段)
   * 表达"这条 AgentEvent 在哪个子任务里",与 TraceEntry.parentTaskId 同义。
   */
  parentTaskId?: string
  /** 仅 task_started / task_progress / task_notification 三类系统消息持有,标识子任务本体。 */
  subtaskId?: string
  /** Qoder SDKMessage.subtype 透传。 */
  sdkSubtype?: string
}

export type Approval = {
  id: string
  taskId: string
  kind: 'plan' | 'review' | 'commit' | 'push' | 'merge_request' | 'jira_writeback' | 'permission'
  status: 'pending' | 'approved' | 'rejected'
  context: string
  createdAt: string
  resolvedAt?: string
}

export type RepositoryProfile = {
  id: string
  name: string
  localPath: string
  remoteUrl?: string
  defaultBranch: string
  gitlabProjectId?: string
  setupCommand?: string
  testCommand?: string
  lintCommand?: string
  buildCommand?: string
}

export type McpProfile = {
  id: string
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  tokenEnv?: string
  tokenHeader?: string
  tools: {
    search?: string
    get?: string
    transition?: string
    comment?: string
  }
  jira?: JiraMapping
}

export type JiraMapping = {
  itemsPath?: string
  searchQueryParameter?: string
  searchArguments?: Record<string, unknown>
  fields?: Partial<
    Record<'key' | 'title' | 'description' | 'keywords' | 'acceptanceCriteria' | 'status' | 'sourceUrl', string>
  >
  statusMap?: Record<string, TaskState>
}

export type ModelProfile = {
  id: string
  name: string
  provider: string
  model: string
  baseUrl?: string
  apiKeyEnv?: string
  qoderEnabled?: boolean
}

// === Agent 体系(可配置多 Agent + 仓库白名单绑定 + 模型路由) ====================

/** 模型提供者标识；未配置表示跟随系统（inherit）。 */
export type AgentProvider = 'qoder' | 'openai' | string

/**
 * Agent 定义：每个 Agent 携带领域系统提示词、工程约定与模型偏好。
 *
 * - 仓库绑定在 Agent 侧（`repositoryIds` 白名单）：任务多仓库时每个仓库独立解析自己的 Agent；
 * - 未绑定任何仓库的 Agent 不会自动命中，未命中仓库回退内置「通用」Agent（空内容=原行为）；
 * - `preferredProvider` 与 `preferredModel` 成对出现，决定任务执行路径与模型（任务显式 > Agent > 系统）。
 */
export type AgentProfile = {
  id: string
  name: string
  description?: string
  /** 角色/领域系统提示词，注入所有阶段 prompt 的 Agent 段。 */
  systemPrompt: string
  /** 工程约定，追加在 systemPrompt 之后。 */
  engineeringGuidelines?: string
  /** 模型提供者 + 模型名，成对出现；未配置时跟随系统 modelProfile。 */
  preferredProvider?: AgentProvider
  preferredModel?: string
  /** 白名单绑定：适用仓库 id 列表。 */
  repositoryIds: string[]
  /** repowiki 文档路径白名单：命中这些路径的文档全文注入（不截断）。 */
  wikiIncludePaths?: string[]
  enabled: boolean
  /** 内置模板标记，UI 提供"基于模板新建"入口。 */
  builtin?: boolean
  createdAt: string
  updatedAt: string
}

/** 内置「通用」Agent 的固定 id：任何仓库未命中自定义 Agent 时回退到它。 */
export const GENERAL_AGENT_ID = 'builtin-general'

/** 任务级 Agent 覆盖的特殊值：本任务禁用 Agent 注入（不注入指引、模型跟随系统）。 */
export const AGENT_TASK_DISABLED = '__disabled__'

/** 内置角色 Agent 固定 id：Code Review Agent */
export const AGENT_REVIEWER_ID = 'builtin-reviewer'
/** 内置角色 Agent 固定 id：测试用例生成 Agent */
export const AGENT_TEST_WRITER_ID = 'builtin-test-writer'
/** 内置角色 Agent 固定 id：MR 描述生成 Agent */
export const AGENT_MR_WRITER_ID = 'builtin-mr-writer'

export function boardColumnFor(state: TaskState): BoardColumn {
  if (['completed', 'cancelled'].includes(state)) return 'done'
  if (state === 'draft') return 'todo'
  if (
    ['awaiting_review', 'reviewing', 'review_blocked', 'awaiting_commit', 'delivering', 'await_merge'].includes(state)
  )
    return 'in_review'
  // generating_tests 与实现阶段同列，避免卡片在看板里来回跳动。
  return 'in_progress'
}

/**
 * 把任务级覆盖与系统级设置合并成一个布尔结果。
 *
 * - task 字段为 `true` / `false` 时直接返回（任务级优先）。
 * - task 字段为 `undefined` 时回退到 `resolver.get(key) === "true"`。
 * - resolver 未配置时回退到 `defaults`。
 *
 * 业务编排模块（TaskWorkflow / DeliveryService 等）应通过此 helper
 * 而非直接读设置，确保任务级覆盖真正生效。
 */
export function resolveTaskSetting(
  task: Pick<Task, 'openCodeReviewEnabled' | 'autoCreateMergeRequests' | 'createTestCasesEnabled'> | undefined,
  taskKey: 'openCodeReviewEnabled' | 'autoCreateMergeRequests' | 'createTestCasesEnabled',
  resolver: { get(key: string): string | undefined },
  settingKey: string,
  defaults: boolean
): boolean {
  const taskValue = task?.[taskKey]
  if (typeof taskValue === 'boolean') return taskValue
  const setting = resolver.get(settingKey)
  if (setting === 'true') return true
  if (setting === 'false') return false
  return defaults
}

// === Memory 系统(仓库级 / 用户级 / 对话级 + repowiki 文档) =====================

export type MemoryScope = 'user' | 'repo' | 'conversation'
export type MemorySource = 'manual' | 'auto' | 'imported'

export type Memory = {
  id: string
  scope: MemoryScope
  userId?: string
  repositoryId?: string
  conversationId?: string
  title: string
  content: string
  tags: string[]
  pinned: boolean
  /** 0~1，越高越重要，注入排序时优先。 */
  importance: number
  source: MemorySource
  createdAt: string
  updatedAt: string
}

export type RepoWikiDoc = {
  id: string
  repositoryId: string
  path: string
  title: string
  content: string
  mtime?: string
  hash: string
  updatedAt: string
}

export type MemorySearchHit = Memory & { score: number }
export type RepoWikiSearchHit = RepoWikiDoc & { score: number }

// === Trace 系统（对话 / 任务 / Pi 会话统一执行轨迹） ==========================

/** Trace 归属类型：任务 / 对话 / Pi 会话。 */
export type TraceKind = 'task' | 'chat' | 'pi_session' | 'other'

/** 归一化后的执行轨迹条目类型。 */
export type TraceEntryType =
  | 'session_start'
  | 'session_end'
  | 'message'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'status'
  | 'error'
  | 'review'
  | 'diff'

/** 归一化 trace 条目，各数据源（events 表 / chats-v3 / pi session / pi-trace events）统一映射为它。 */
export type TraceEntry = {
  /** 全局唯一：`${source}-${traceId}-${seq}`。 */
  id: string
  /** 归属：taskId / chatId / piSessionId。 */
  traceId: string
  kind: TraceKind
  type: TraceEntryType
  title: string
  detail?: string
  /** 原始数据（AgentEvent / SDK raw / events.jsonl 事件）。 */
  payload?: unknown
  createdAt: string
  source: 'events' | 'chat' | 'pi' | 'pi_trace' | 'qoder'
  /**
   * 归属子任务 ID（Qoder 子 Agent）。
   *
   * - 仅 Qoder 源使用；其它源恒为 undefined。
   * - 来自 SDKMessage.parent_tool_use_id 反查 task_started.tool_use_id 后得到的 task_id。
   * - 为 undefined 表示"主流程"；有值表示"嵌套在该子任务内"。
   *
   * 注意：JSONL 落盘形态不动（你确认的"落盘保持原样,只在解析时计算"），该字段在
   * parseQoderTraceFile 阶段被注入到内存 entry 上。
   */
  parentTaskId?: string
  /** 仅 task_started / task_progress / task_notification 三类系统消息持有，标识子任务本体。 */
  taskId?: string
  /** Qoder SDKMessage.subtype 透传（如 task_started / task_progress / hook_started 等），UI 据此路由。 */
  sdkSubtype?: string
}

/** Trace 列表项（列表页用，不携带完整条目）。 */
export type TraceSummary = {
  traceId: string
  kind: TraceKind
  title: string
  createdAt: string
  updatedAt: string
  entryCount: number
  state?: string
  /** 执行统计：Token / 成本 / 时长 / 模型等关键指标。 */
  stats?: {
    turns?: number
    tokens?: { input: number; output: number; total: number }
    costUsd?: number
    model?: string
    durationMs?: number
  }
  lastEntry?: Pick<TraceEntry, 'type' | 'title' | 'createdAt'>
  /** pi-trace 源存在 trace.html 时给出（前端"在浏览器打开"用）。 */
  traceHtmlPath?: string
  /** pi_session 源关联到的任务（D6：pi_session_path 匹配 / 时间窗兜底）。 */
  linkedTaskId?: string
}

/**
 * 跨数据源归一化后的 trace 业务事件（写入 trace_events / 用于 Trace 列表"其它"分类）。
 *
 * 与 `AgentEvent` 的区别：不需要挂载 taskId，归属完全靠 `source` 区分；
 * 详情由 `detail` + `payload` 透传给 Trace 页面。
 */
export type TraceEvent = {
  id: string
  /** 业务分类标签，前端 Trace 列表可按它过滤。固定为 "other"，保留扩展位。 */
  category: 'other'
  /** 业务子类型，例如 "agent_template_generation" —— UI 可用它判图标 / 摘要。 */
  subType: string
  title: string
  detail?: string
  payload?: unknown
  createdAt: string
}
