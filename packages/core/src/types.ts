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
export type TaskFailureStage = 'preparing' | 'planning' | 'implementing' | 'validating'
export type TaskSource = 'local' | 'jira' | 'github' | 'linear'

/**
 * 「Review 通过后」的任务级选择：`auto` 直接提交 MR，`manual` 停在 `awaiting_commit` 等人工点。
 *
 * 这是固定链路下唯一保留的任务级配置，取代原先的 `autoCreateMergeRequests` 布尔 +
 * 系统设置 `deliveryConfirm` 两套开关。未设置（`undefined`）表示跟随系统默认，
 * 它是有意义的第三态，回填迁移不能把它当成「漏写」补掉。
 */
export type TaskMrMode = 'auto' | 'manual'

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
  /** Review 通过后是否自动提交 MR；未设置时回退系统设置 `autoCreateMergeRequests`。 */
  mrAutoSubmit?: TaskMrMode
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
   * - 与 span meta 的 `taskId`（subtask.run）语义一致: undefined 表示主流程,有值表示嵌套在子任务内。
   * - 由 `recordQoderMessage` 透传 SDKMessage.parent_tool_use_id 反查 task_started 的结果。
   * - 其它源(本地状态变更 / 内存注入 / 用户操作)不携带该字段。
   *
   * 命名说明: `taskId` 已是 AgentEvent 归属任务的 ID,这里另起 `parentTaskId`(本字段)
   * 表达"这条 AgentEvent 在哪个子任务里"。
   */
  parentTaskId?: string
  /** 仅 task_started / task_progress / task_notification 三类系统消息持有,标识子任务本体。 */
  subtaskId?: string
  /** Qoder SDKMessage.subtype 透传。 */
  sdkSubtype?: string
}

/**
 * 澄清对话（`draft` 阶段）提交的任务定义建议：`Task` 里「人手填的那几项」的子集。
 *
 * 链路要读的描述、验收标准、仓库归属由用户采纳后才写入——模型只能提议，不能代签。
 * 落库形态是 `AgentEvent`（`kind:'status'` + 下面那份 payload），
 * 主进程与 renderer 共用这一份定义，避免建议体在两处各写一遍然后各自漂移。
 */
export type TaskDraftFields = {
  title?: string
  description?: string
  keywords?: string[]
  acceptanceCriteria?: string[]
  repositoryIds?: string[]
}

/** 建议里的可采纳字段名：逐条采纳时，界面只回传键名，不回传建议体。 */
export type TaskDraftFieldKey = keyof TaskDraftFields

/**
 * `AgentEvent.payload` 的三种取值：澄清问答的一句话、Agent 提出的建议、用户对它的处置。
 *
 * 一条建议是否已被处置由事件顺序决定（从后往前扫，先碰到 `resolved` 就没有待处理的建议），
 * 所以下面不存建议事件的 id：一个 `draft` 同时只需要亮一条。
 *
 * 问答方向也必须显式记：`title`（「你」/「澄清助手」）是给人看的文案，拿它做渲染分支
 * 等于把界面绑在一句中文上，改文案就静默丢气泡。
 */
export type TaskDraftEventPayload =
  | {
      type: 'draft-suggestion'
      fields: TaskDraftFields
      /**
       * 仓库 id → 名称的快照。渲染层没有全量仓库表（只有本任务已关联的那几个），
       * 而建议里的仓库通常还没关联上，不带上这份快照就只能显示裸 id。
       * 采纳时仍按 id 重新校验，名字只用于展示。
       */
      repositoryNames?: Record<string, string>
    }
  | { type: 'draft-suggestion-resolved'; action: 'applied' | 'discarded' }
  | { type: 'draft-message'; role: 'user' | 'assistant' }

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
  /**
   * 传输方式：
   * - 'stdio'：本地子进程（行为不变）
   * - 'sse'：老 SSE 传输（行为不变）
   * - 'streamable-http'：MCP 2025-03-26 协议（先 initialize 握手 + httpSend，行为不变）
   * - 'stateless-http'（MCP 2026-07-28）：无状态协议，去掉 initialize 握手，每个 HTTP 请求
   *   params._meta 必填 io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities}；
   *   tools/list 响应按 _meta.ttlMs 缓存。
   */
  transport: 'stdio' | 'sse' | 'streamable-http' | 'stateless-http'
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
 * 合并「Review 通过后」的任务级选择与系统默认。
 *
 * 优先级：`task.mrAutoSubmit` → 系统设置键 `autoCreateMergeRequests` → `'manual'`。
 * 旧的任务级布尔 `autoCreateMergeRequests` 已不再参与回落：它已由 `TaskStore` 打开时
 * 的一次性回填转成 `mrAutoSubmit`，字段本身也已从 `Task` 上删除。
 *
 * 默认取 `'manual'`：与改造前 `resolveTaskSetting(..., defaults: false)` 一致，不新增自动提交行为。
 */
export function resolveMrMode(
  task: Pick<Task, 'mrAutoSubmit'> | undefined,
  resolver: { get(key: string): string | undefined }
): TaskMrMode {
  if (task?.mrAutoSubmit === 'auto' || task?.mrAutoSubmit === 'manual') return task.mrAutoSubmit
  const setting = resolver.get('autoCreateMergeRequests')
  if (setting === 'true') return 'auto'
  if (setting === 'false') return 'manual'
  return 'manual'
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
  /** MemoryEngine 节点类型（新系统字段，旧数据可能无此字段） */
  nodeType?: string
  /** MemoryEngine 节点状态：active / candidate / stale / superseded / archived / compacted / expired */
  status?: string
  /** MemoryEngine 置信度 0~1 */
  confidence?: number
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
