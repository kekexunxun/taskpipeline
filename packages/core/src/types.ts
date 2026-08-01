export const BOARD_COLUMNS = ["todo", "in_progress", "in_review", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const TASK_STATES = [
  "draft", "confirmed", "preparing", "planning", "awaiting_plan_approval",
  "implementing", "validating", "validation_failed", "awaiting_review",
  "reviewing", "review_blocked", "awaiting_commit", "delivering",
  "await_merge", "completed", "failed", "cancelled"
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type TaskStartMode = "direct" | "plan";
export type TaskFailureStage = "preparing" | "planning" | "implementing" | "validating";

export type Task = {
  id: string;
  jiraKey?: string;
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
  deliveryStatus: "pending" | "changed" | "committed" | "pushed" | "mr_created" | "failed";
};

export type TaskCard = Task & {
  boardColumn: BoardColumn;
  repositories: Pick<TaskRepository, "id" | "name" | "changeSummary" | "mergeRequestUrl" | "deliveryStatus">[];
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
  fields?: Partial<Record<"key" | "title" | "description" | "keywords" | "acceptanceCriteria" | "status", string>>;
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
  return "in_progress";
}
