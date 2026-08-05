export const BOARD_COLUMNS = ["todo", "in_progress", "in_review", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const TASK_STATES = [
  "draft", "confirmed", "preparing", "planning", "awaiting_plan_approval",
  "implementing", "awaiting_input", "generating_tests", "validating", "validation_failed", "awaiting_review",
  "reviewing", "review_blocked", "awaiting_commit", "delivering",
  "await_merge", "completed", "failed", "cancelled"
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type TaskStartMode = "direct" | "plan";
export type TaskFailureStage = "preparing" | "planning" | "implementing" | "validating";
export type TaskSource = "local" | "jira" | "github" | "linear";

export type Task = {
  id: string;
  taskKey?: string;
  source: TaskSource;
  sourceUrl?: string;
  title: string;
  description: string;
  keywords: string[];
  acceptanceCriteria: string[];
  state: TaskState;
  summary?: string;
  startMode?: TaskStartMode;
  planContent?: string;
  planRevision?: number;
  failureStage?: TaskFailureStage;
  reviewStatus: "pending" | "running" | "passed" | "blocked" | "waived";
  commitMessage?: string;
  piSessionPath?: string;
  qoderModel?: string;
  sessionUsage?: SessionUsage;
  /**
   * 任务级覆盖：实现完成后是否自动跑 Code Review。
   * `undefined` 表示沿用系统设置；显式布尔值在任务执行期间独立生效。
   */
  openCodeReviewEnabled?: boolean;
  /** 任务级覆盖：Review 通过后是否自动提交 Merge Request。 */
  autoCreateMergeRequests?: boolean;
  /** 任务级覆盖：实现完成后是否先生成最小测试集，再进入校验/Review。 */
  createTestCasesEnabled?: boolean;
  /** 最近一次测试用例生成的摘要，用于 Timeline 展示。 */
  testsGenerated?: { files: string[]; commitSha?: string; finishedAt: string };
  createdAt: string;
  updatedAt: string;
};

export type SessionUsage = {
  provider: "qoder" | "openai";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
  durationMs?: number;
  turns?: number;
};

export type TaskRepository = {
  id: string;
  taskId: string;
  repositoryId: string;
  name: string;
  localPath: string;
  baseBranch: string;
  setupCommand?: string;
  lintCommand?: string;
  testCommand?: string;
  buildCommand?: string;
  featureBranch?: string;
  worktreePath?: string;
  changeSummary?: string;
  commitSha?: string;
  mergeRequestUrl?: string;
  mergeRequestIid?: number;
  mergeRequestState?: "opened" | "merged" | "closed";
  mergeRequestCheckedAt?: string;
  deliveryStatus: "pending" | "unchanged" | "changed" | "committed" | "pushed" | "mr_created" | "workspace_removed" | "failed";
};

export type TaskCard = Task & {
  boardColumn: BoardColumn;
  repositories: (Pick<TaskRepository, "id" | "name" | "changeSummary" | "mergeRequestUrl" | "deliveryStatus"> & {
    changedFileCount?: number;
  })[];
};

export type AgentEvent = {
  id: string;
  taskId: string;
  kind: "message" | "tool" | "permission" | "command" | "diff" | "review" | "error" | "status";
  title: string;
  detail?: string;
  payload?: unknown;
  createdAt: string;
};

export type Approval = {
  id: string;
  taskId: string;
  kind: "plan" | "review" | "commit" | "push" | "merge_request" | "jira_writeback" | "permission";
  status: "pending" | "approved" | "rejected";
  context: string;
  createdAt: string;
  resolvedAt?: string;
};

export type RepositoryProfile = {
  id: string;
  name: string;
  localPath: string;
  remoteUrl?: string;
  defaultBranch: string;
  gitlabProjectId?: string;
  setupCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  buildCommand?: string;
};

export type McpProfile = {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  tokenEnv?: string;
  tokenHeader?: string;
  tools: {
    search?: string;
    get?: string;
    transition?: string;
    comment?: string;
  };
  jira?: JiraMapping;
};

export type JiraMapping = {
  itemsPath?: string;
  searchQueryParameter?: string;
  searchArguments?: Record<string, unknown>;
  fields?: Partial<Record<"key" | "title" | "description" | "keywords" | "acceptanceCriteria" | "status" | "sourceUrl", string>>;
  statusMap?: Record<string, TaskState>;
};

export type ModelProfile = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  qoderEnabled?: boolean;
};

export function boardColumnFor(state: TaskState): BoardColumn {
  if (["completed", "cancelled"].includes(state)) return "done";
  if (state === "draft") return "todo";
  if (["awaiting_review", "reviewing", "review_blocked", "awaiting_commit", "delivering", "await_merge"].includes(state)) return "in_review";
  // generating_tests 与实现阶段同列，避免卡片在看板里来回跳动。
  return "in_progress";
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
  task: Pick<Task, "openCodeReviewEnabled" | "autoCreateMergeRequests" | "createTestCasesEnabled"> | undefined,
  taskKey: "openCodeReviewEnabled" | "autoCreateMergeRequests" | "createTestCasesEnabled",
  resolver: { get(key: string): string | undefined },
  settingKey: string,
  defaults: boolean
): boolean {
  const taskValue = task?.[taskKey];
  if (typeof taskValue === "boolean") return taskValue;
  const setting = resolver.get(settingKey);
  if (setting === "true") return true;
  if (setting === "false") return false;
  return defaults;
}
