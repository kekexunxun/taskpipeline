import type { AgentEvent, AgentProfile, Approval, Memory, MemoryScope, MemorySearchHit, RepositoryProfile, RepoWikiDoc, RepoWikiSearchHit, Task, TaskCard, TaskRepository, TaskStartMode, TraceEntry, TraceKind, TraceSummary } from "@coding-agent/core";

export type ChangedFile = { repositoryId: string; repositoryName: string; path: string; status: string };
export type TaskDetail = { task?: Task; repositories: TaskRepository[]; events: AgentEvent[]; approvals: Approval[]; changedFiles: ChangedFile[] };
export type QoderStatus = {
  enabled: boolean; connected: boolean; running: boolean;
  account?: { subscriptionType?: string };
  usage?: { userType?: string; totalUsagePercentage?: number; isHighestTier?: boolean; expiresAt?: number; isQuotaExceeded?: boolean; userQuota?: { total?: number; used?: number; remaining?: number; percentage?: number; unit?: string }; addOnQuota?: { total?: number; used?: number; remaining?: number; percentage?: number; unit?: string }; orgResourcePackage?: { used?: number; cap?: number; remaining?: number; available?: boolean; unit?: string } } | null;
  models: Array<{ value: string; displayName: string; description: string; isDefault?: boolean; isEnabled?: boolean; isReasoning?: boolean; isVl?: boolean; priceFactor?: number }>;
  error?: string;
};
export type JiraTaskCandidate = Pick<Task, "taskKey" | "source" | "sourceUrl" | "title" | "description" | "keywords" | "acceptanceCriteria"> & {
  taskKey: string;
  /** 本地系统中是否已存在同 Key 任务。 */
  existing?: boolean;
  /** 已存在且不在 TODO 列，导入会覆盖其内容，需要用户确认。 */
  conflict?: boolean;
};
export type RepositoryFolder = Omit<RepositoryProfile, "id">;
export type MergeRepoStatus = { repoId: string; repoName: string; mergeRequestIid: number; mergeRequestUrl?: string; state: "opened" | "merged" | "closed" | "error"; error?: string };
export type MergeStatusSummary = { taskId: string; taskTitle: string; repos: MergeRepoStatus[]; allMerged: boolean; taskCompleted: boolean };
export type CreateTaskInput = Pick<Task, "title" | "description"> & Partial<Pick<Task, "keywords" | "acceptanceCriteria" | "openCodeReviewEnabled" | "autoCreateMergeRequests" | "createTestCasesEnabled" | "agentProfileId" | "repoAgentIds">>;
export type RepositoryCommands = Partial<Pick<TaskRepository, "setupCommand" | "lintCommand" | "testCommand" | "buildCommand">>;
export type StartTaskOptions = { mode: TaskStartMode; repositoryCommands?: Record<string, RepositoryCommands>; useAllRepositories?: boolean; repoAgentIds?: Record<string, string> };
export type TaskRemovalMode = "workspace" | "all";
export type TaskBackendId = "jira" | "github" | "linear";
export type TaskBackendInfo = { id: TaskBackendId; displayName: string; configured: boolean; description?: string };

// === Chat API surface ===

/** Chat driver 标识,跨主进程 / IPC / 前端保持一致。 */
export type ChatDriverId = "qoder" | "openai";

/** Driver 推给上层的"消息片"统一外壳。 */
export type DriverPart =
  | { driverId: "qoder"; type: "qoder.session"; sessionId: string }
  | { driverId: "qoder"; type: "qoder.thinking"; text: string; signature?: string }
  | { driverId: "qoder"; type: "qoder.tool-use"; toolCallId: string; name: string; input: unknown }
  | { driverId: "qoder"; type: "qoder.tool-result"; toolCallId: string; output: unknown; isError?: boolean }
  | { driverId: "openai"; type: "openai.tool-call"; toolCallId: string; name: string; input: unknown }
  | { driverId: "openai"; type: "openai.tool-result"; toolCallId: string; output: unknown }
  | { driverId: ChatDriverId; type: "text"; text: string };

/** 持久化形态: driver 自己的 raw + 共用元数据。 */
export type StoredMessageRecord = {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  driverId: ChatDriverId;
  /** driver 自己的序列化形态,任意 JSON。 */
  raw: unknown;
};

/** 运行时消息: 在 `StoredMessageRecord` 基础上多一份 `parts` 供 UI 渲染。 */
export type StoredMessage = StoredMessageRecord & {
  parts: DriverPart[];
};

/** 前端别名 —— 历史 / UI 一律用 `ChatMessage`。 */
export type ChatMessage = StoredMessage & {
  /** UI 渲染用,主进程 chat service 在 start/task-created/done 事件里拼装,不持久化。 */
  metadata?: ChatMessageMetadata;
};

export type ChatMessageStatus = "done" | "error" | "aborted";
export type ChatAgentMode = "chat" | "task-create";
export type ChatTaskCreationResult = { backend: "jira" | "github" | "linear"; externalKey: string; summary: string; projectKey: string; issueType: string };
export type ChatMessageMetadata = { createdAt: string; model?: string; status?: ChatMessageStatus; agentMode?: ChatAgentMode; taskCreation?: ChatTaskCreationResult };

export type ChatConversationMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  driverId?: ChatDriverId;
  messageCount: number;
};

export type ChatConversation = ChatConversationMeta & { messages: StoredMessageRecord[] };

export type ChatModelInfo = {
  value: string;
  displayName: string;
  isDefault?: boolean;
  isReasoning?: boolean;
  isVl?: boolean;
  priceFactor?: number;
};

export type ChatModelGroup = {
  driverId: ChatDriverId;
  displayName: string;
  models: ChatModelInfo[];
};

export type StartChatStreamInput = {
  streamId: string;
  chatId: string;
  driverId: ChatDriverId;
  model: string;
  /** 用户当前输入(未持久化),ChatService 会按 driverId 调 `driver.serializeUserMessage` 包成 record。 */
  message: { id: string; text: string; createdAt: string };
  mode?: ChatAgentMode;
};
export type AbortChatStreamInput = { streamId: string; chatId: string };

/** driver 流式过程事件(主进程 → 前端,跨 driver 透传)。 */
export type ChatStreamChunk =
  | { type: "start"; messageId: string; messageMetadata?: ChatMessageMetadata }
  | { type: "part"; part: DriverPart }
  | { type: "model"; model: string }
  | { type: "task-created"; result: ChatTaskCreationResult }
  | { type: "error"; message: string }
  | { type: "done"; status: ChatMessageStatus };

export type ChatStreamEvent = { streamId: string; chatId: string; driverId: ChatDriverId; chunk?: ChatStreamChunk; error?: string; done?: boolean };

// === Memory API surface ===

export type MemoryInput = Omit<Memory, "id" | "createdAt" | "updatedAt"> & { id?: string };
export type MemoryListFilter = { scope?: MemoryScope; scopes?: MemoryScope[]; repositoryId?: string; conversationId?: string };
export type MemorySearchOptions = { repositoryIds?: string[]; conversationId?: string; limit?: number };
export type MemorySearchResult = { memories: MemorySearchHit[]; wikiDocs: RepoWikiSearchHit[] };
export type RepoWikiIndexResult = { indexed: number; removed: number };

/** 内置 Agent 模板（主进程 AGENT_TEMPLATES 的镜像形态，仅用于「基于模板新建」入口）。 */
export type AgentTemplate = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  engineeringGuidelines?: string;
};

export type AgentApi = {
  listTasks(): Promise<TaskCard[]>; getTask(id: string): Promise<TaskDetail>; createTask(input: CreateTaskInput): Promise<Task>; updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  deleteTask(id: string, mode?: TaskRemovalMode): Promise<void>; listRepositories(): Promise<RepositoryProfile[]>; saveRepository(profile: RepositoryProfile): Promise<void>; deleteRepository(id: string): Promise<void>; chooseRepositoryFolder(): Promise<RepositoryFolder | undefined>; attachRepository(taskId: string, repositoryId: string): Promise<TaskRepository>; detachRepository(taskId: string, repositoryId: string): Promise<void>; updateTaskRepositoryCommands(taskId: string, repositoryId: string, commands: RepositoryCommands): Promise<TaskRepository>; getSetting(key: string): Promise<string | undefined>; setSetting(key: string, value: string, secret?: boolean): Promise<void>;
  startTask(taskId: string, options?: StartTaskOptions): Promise<void>; reimplementTask(taskId: string): Promise<void>; resumeTask(taskId: string): Promise<void>; pauseTask(taskId: string): Promise<void>; resumePausedTask(taskId: string): Promise<void>; updateTaskPlan(taskId: string, planContent: string): Promise<void>; approveTaskPlan(taskId: string): Promise<void>; reviseTaskPlan(taskId: string, feedback: string): Promise<void>; retryTaskValidation(taskId: string): Promise<void>; sendTaskMessage(taskId: string, message: string): Promise<void>; abortTask(): Promise<void>; runReview(taskId: string): Promise<void>; resetReview(taskId: string): Promise<void>; resetDelivery(taskId: string): Promise<void>; submitMergeRequests(taskId: string): Promise<void>; refreshMergeStatus(): Promise<MergeStatusSummary[]>; manualComplete(taskId: string): Promise<void>;
  importJiraTask(keyOrUrl: string): Promise<Task>; syncJiraTasks(): Promise<JiraTaskCandidate[]>; importJiraTasks(candidates: JiraTaskCandidate[]): Promise<Task[]>; testAtlassian(kind: "jira" | "confluence"): Promise<{ ok: boolean; message: string }>;
  openTaskEditor(taskId: string, editor: "vscode" | "qoder"): Promise<void>;
  mergeBackToBase(taskId: string): Promise<void>;
  revealTaskWorkspace(taskId: string): Promise<void>;
  listTaskBackends(): Promise<TaskBackendInfo[]>;
  openExternal(url: string): Promise<void>;
  getQoderStatus(): Promise<QoderStatus>;
  respondTaskUi(response: unknown): Promise<void>; onTaskEvent(callback: (event: any) => void): () => void;
  // memory
  listMemories(filter?: MemoryListFilter): Promise<Memory[]>;
  upsertMemory(input: MemoryInput): Promise<Memory>;
  updateMemory(id: string, patch: Partial<Omit<Memory, "id" | "createdAt" | "updatedAt">>): Promise<Memory>;
  deleteMemory(id: string): Promise<void>;
  searchMemory(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult>;
  indexRepoWiki(repositoryId: string): Promise<RepoWikiIndexResult>;
  listRepoWikiDocs(repositoryId: string): Promise<RepoWikiDoc[]>;
  searchRepoWiki(repositoryId: string, query: string): Promise<RepoWikiSearchHit[]>;
  // agents
  listAgents(): Promise<AgentProfile[]>;
  saveAgent(profile: AgentProfile): Promise<AgentProfile[]>;
  deleteAgent(id: string): Promise<AgentProfile[]>;
  listAgentTemplates(): Promise<AgentTemplate[]>;
  exportAgents(): Promise<string | undefined>;
  importAgents(): Promise<AgentProfile[]>;
  // chat
  listChats(): Promise<ChatConversationMeta[]>;
  getChat(id: string): Promise<{ conversation: ChatConversation; messages: ChatMessage[] } | undefined>;
  createChat(input?: { driverId?: ChatDriverId; model?: string }): Promise<ChatConversation>;
  deleteChat(id: string): Promise<void>;
  listChatModels(): Promise<ChatModelGroup[]>;
  startChatStream(input: StartChatStreamInput): Promise<void>;
  abortChat(input: AbortChatStreamInput): Promise<void>;
  onChatStreamEvent(callback: (event: ChatStreamEvent) => void): () => void;
  // trace
  listTrace(): Promise<TraceSummary[]>;
  getTrace(kind: TraceKind, traceId: string): Promise<TraceEntry[]>;
};

declare global { interface Window { agentApi?: AgentApi } }

const demoTasks: TaskCard[] = [
  { id: "demo-1", taskKey: "PAY-1842", source: "jira", title: "修复结算页优惠券并发校验", description: "优惠券并发使用时偶发重复核销。补充幂等保护与回归测试。", keywords: ["payment", "concurrency"], acceptanceCriteria: ["并发请求只核销一次"], state: "awaiting_plan_approval", startMode: "plan", planRevision: 2, planContent: "## 目标\n\n为优惠券核销流程增加幂等保护，保证相同业务请求在并发情况下只执行一次。\n\n## 实施步骤\n\n1. 梳理结算服务到优惠券服务的调用链，确认业务幂等键的生成位置和传递方式。\n2. 在核销入口增加原子占位与结果复用逻辑，区分处理中、成功和失败三种状态。\n3. 将重复请求统一返回首次核销结果，避免重复写入订单优惠明细。\n4. 为超时与异常场景补充状态清理策略，确保可重试错误不会永久占用幂等键。\n5. 增加并发单元测试、集成测试和回归用例，覆盖成功、冲突、超时及重试。\n\n## 验证\n\n- 并发发起 20 次相同核销请求，只产生一条核销记录。\n- 不同订单或不同优惠券的请求互不阻塞。\n- 执行支付服务完整测试与构建。", reviewStatus: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "in_progress", summary: "实施计划已生成，等待确认", repositories: [{ id: "r1", name: "payment-service", deliveryStatus: "pending" }] },
  { id: "demo-2", taskKey: "OPS-938", source: "jira", title: "订单导出增加审计字段", description: "从 Jira 同步的待办任务。", keywords: ["export", "audit"], acceptanceCriteria: [], state: "draft", reviewStatus: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "todo", repositories: [{ id: "r2", name: "order-console", deliveryStatus: "pending" }] },
  { id: "demo-3", taskKey: "CORE-417", source: "jira", title: "升级事件重试策略", description: "MR 已提交，等待合并。", keywords: ["events"], acceptanceCriteria: [], state: "await_merge", reviewStatus: "passed", commitMessage: "fix: CORE-417 improve retry backoff", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "in_review", repositories: [{ id: "r3", name: "event-core", changeSummary: "3 files +74 -18", deliveryStatus: "mr_created", mergeRequestUrl: "#" }] },
  { id: "demo-4", taskKey: "WEB-206", source: "jira", title: "修复控制台权限展示", description: "MR 已合并。", keywords: ["console"], acceptanceCriteria: [], state: "completed", reviewStatus: "passed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "done", repositories: [{ id: "r4", name: "web-console", deliveryStatus: "mr_created", mergeRequestUrl: "#" }] },
  { id: "demo-5", taskKey: "INFRA-22", source: "jira", title: "示例：跳过 Review 的任务", description: "演示任务级 openCodeReviewEnabled=false：实现完成后直接进入 awaiting_commit。", keywords: ["infra", "demo"], acceptanceCriteria: [], state: "await_merge", reviewStatus: "waived", commitMessage: "chore: skip review for INFRA-22", openCodeReviewEnabled: false, autoCreateMergeRequests: true, createTestCasesEnabled: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "in_review", repositories: [{ id: "r5", name: "infra-scripts", deliveryStatus: "mr_created", mergeRequestUrl: "#" }] }
];

const demoRepositories: RepositoryProfile[] = [
  { id: "repo-payment", name: "payment-service", localPath: "/demo/payment-service", defaultBranch: "main", setupCommand: "npm install", lintCommand: "npm run lint", testCommand: "npm test", buildCommand: "npm run build" },
  { id: "repo-order", name: "order-console", localPath: "/demo/order-console", defaultBranch: "main", setupCommand: "npm install", lintCommand: "npm run lint", testCommand: "npm test", buildCommand: "npm run build" },
  { id: "repo-events", name: "event-core", localPath: "/demo/event-core", defaultBranch: "main" },
  { id: "repo-web", name: "web-console", localPath: "/demo/web-console", defaultBranch: "main" },
  { id: "repo-infra", name: "infra-scripts", localPath: "/demo/infra-scripts", defaultBranch: "main" }
];

const demoAgents: AgentProfile[] = [
  { id: "builtin-general", name: "通用", description: "内置兜底 Agent：未绑定自定义 Agent 的仓库使用通用能力执行，行为与未配置时一致。", systemPrompt: "", repositoryIds: [], enabled: true, builtin: true, createdAt: nowIso(), updatedAt: nowIso() },
  { id: "demo-java", name: "Java 服务端", description: "示例：Spring Boot 服务端项目约定（绑定 payment-service）。", systemPrompt: "- 统一使用 Result<T> 包装接口返回，禁止直接返回实体对象\n- 事务方法显式声明 @Transactional(rollbackFor = Exception.class)\n- 日志使用 slf4j，禁止 System.out / printStackTrace", repositoryIds: ["repo-payment"], enabled: true, createdAt: nowIso(), updatedAt: nowIso() }
];

const demoAgentTemplates: AgentTemplate[] = [
  { id: "java-backend", name: "Java 服务端", description: "Spring Boot / MyBatis 等公司 Java 服务端项目。", systemPrompt: "- 使用项目现有框架版本，禁止引入未使用的新依赖\n- 统一使用 Result<T> 包装接口返回\n- 分页查询复用 PageQuery 基类\n- 事务方法显式声明 @Transactional(rollbackFor = Exception.class)", engineeringGuidelines: "实现前先阅读目标模块已有 Service / Mapper 的写法，复用现有工具类。" },
  { id: "frontend-react", name: "前端 React + TS", description: "React / TypeScript 前端项目（含 Next.js / Vite）。", systemPrompt: "- TypeScript 严格模式，禁止 any\n- 组件使用函数组件 + hooks，禁止 class 组件\n- 状态管理使用项目现有方案\n- 新增 UI 必须补齐 loading / empty / error 三态", engineeringGuidelines: "改动前先查看现有页面/组件的实现模式，复用项目内已有的 UI 组件。" }
];

const demoTaskRepositories = new Map<string, TaskRepository[]>(demoTasks.map((task) => {
  // demo 数据中 task.repositories[0].name 已经是真实仓库名；为它造一个 RepositoryProfile 兼容。
  const cardRepo = task.repositories[0];
  if (!cardRepo) return [task.id, []];
  const profile: RepositoryProfile = demoRepositories.find((repo) => repo.name === cardRepo.name) ?? {
    id: `repo-${cardRepo.name}`, name: cardRepo.name, localPath: `/demo/${cardRepo.name}`, defaultBranch: "main"
  };
  return [task.id, [{
    id: cardRepo.id,
    taskId: task.id,
    repositoryId: profile.id,
    name: profile.name,
    localPath: profile.localPath,
    baseBranch: profile.defaultBranch,
    setupCommand: profile.setupCommand,
    lintCommand: profile.lintCommand,
    testCommand: profile.testCommand,
    buildCommand: profile.buildCommand,
    changeSummary: cardRepo.changeSummary,
    mergeRequestUrl: cardRepo.mergeRequestUrl,
    deliveryStatus: cardRepo.deliveryStatus
  }]];
}));

// 浏览器回退（vite 不带 Electron 启动时使用）的 mock 实现：任务走 demo 数据，
// Chat 走纯内存 store —— 仅供 UI 演示，不会写本地文件。
const memoryChats = new Map<string, ChatConversation>();
const memoryListeners = new Set<(event: ChatStreamEvent) => void>();
const memoryStreamTimers = new Map<string, number>();
const defaultModelGroups: ChatModelGroup[] = [
  {
    driverId: "qoder",
    displayName: "Qoder Agent SDK",
    models: [
      { value: "qoder:claude-sonnet-4.5", displayName: "Claude Sonnet 4.5", isDefault: true, isReasoning: false, isVl: true, priceFactor: 1 },
      { value: "qoder:gpt-5", displayName: "GPT-5", isDefault: false, isReasoning: true, isVl: true, priceFactor: 1.2 }
    ]
  }
];

function nowIso() { return new Date().toISOString(); }
function makeId() { return crypto.randomUUID(); }
function defaultTitle(text: string) { return text.slice(0, 32).replace(/\s+/g, " ").trim() || "新对话"; }
/** 从记录中提取 user 输入文本(供 mock / 标题生成等不需要 parts 的场景使用)。 */
function messageText(record: { raw: unknown; role: string; parts?: DriverPart[] }): string {
  const textParts = record.parts?.filter((p): p is Extract<DriverPart, { type: "text" }> => p.type === "text") ?? [];
  if (textParts.length) return textParts.map((p) => p.text).join("");
  // 兼容 mock 中可能尚未填充 parts 的 record
  if (record.raw && typeof record.raw === "object") {
    const raw = record.raw as { kind?: string; text?: string };
    if (typeof raw.text === "string") return raw.text;
  }
  return "";
}

export const api: AgentApi = window.agentApi ?? {
  async listTasks() { return demoTasks; },
  async getTask(id) { const task = demoTasks.find((item) => item.id === id); return { task, repositories: demoTaskRepositories.get(id) ?? [], approvals: [], changedFiles: [], events: task?.state === "implementing" ? [{ id: "e1", taskId: id, kind: "status", title: "任务已确认，AI 会话已启动", createdAt: new Date(Date.now() - 240000).toISOString() }, { id: "e2", taskId: id, kind: "tool", title: "读取支付服务上下文", detail: "分析幂等键生成与优惠券核销路径", createdAt: new Date(Date.now() - 170000).toISOString() }, { id: "e3", taskId: id, kind: "command", title: "单元测试通过", detail: "18 passed · 1.8s", createdAt: new Date(Date.now() - 60000).toISOString() }] : [] }; },
  async createTask(input) {
    const now = nowIso();
    const task: TaskCard = { id: makeId(), ...input, source: "local", keywords: input.keywords ?? [], acceptanceCriteria: input.acceptanceCriteria ?? [], state: "draft", reviewStatus: "pending", createdAt: now, updatedAt: now, boardColumn: "todo", repositories: [] };
    demoTasks.unshift(task);
    return task;
  },
  async updateTask(id, patch) {
    const index = demoTasks.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`Task not found: ${id}`);
    const next = { ...demoTasks[index]!, ...patch, updatedAt: nowIso() };
    demoTasks[index] = next;
    return next;
  },
  async deleteTask(id, mode = "all") { const index = demoTasks.findIndex((item) => item.id === id); if (index < 0) return; if (mode === "workspace") { demoTasks[index] = { ...demoTasks[index]!, state: ["draft", "failed", "completed", "await_merge", "cancelled"].includes(demoTasks[index]!.state) ? demoTasks[index]!.state : "cancelled", repositories: demoTasks[index]!.repositories.map((repo) => ({ ...repo, deliveryStatus: "workspace_removed" })) }; demoTaskRepositories.set(id, (demoTaskRepositories.get(id) ?? []).map((repo) => ({ ...repo, worktreePath: undefined, featureBranch: undefined, deliveryStatus: "workspace_removed" }))); return; } demoTasks.splice(index, 1); demoTaskRepositories.delete(id); }, async listRepositories() { return demoRepositories; }, async saveRepository() {}, async deleteRepository() {}, async chooseRepositoryFolder() { return undefined; }, async attachRepository(taskId, repositoryId) { const profile = demoRepositories.find((item) => item.id === repositoryId); if (!profile) throw new Error("Repository not found"); const repo: TaskRepository = { id: makeId(), taskId, repositoryId, name: profile.name, localPath: profile.localPath, baseBranch: profile.defaultBranch, setupCommand: profile.setupCommand, lintCommand: profile.lintCommand, testCommand: profile.testCommand, buildCommand: profile.buildCommand, deliveryStatus: "pending" }; demoTaskRepositories.set(taskId, [...(demoTaskRepositories.get(taskId) ?? []), repo]); return repo; }, async detachRepository(taskId, repositoryId) { demoTaskRepositories.set(taskId, (demoTaskRepositories.get(taskId) ?? []).filter((repo) => repo.repositoryId !== repositoryId)); }, async updateTaskRepositoryCommands(taskId, repositoryId, commands) { const list = demoTaskRepositories.get(taskId) ?? []; const index = list.findIndex((repo) => repo.repositoryId === repositoryId); if (index < 0) throw new Error("Task repository not found"); const next = { ...list[index]!, ...commands }; list[index] = next; demoTaskRepositories.set(taskId, [...list]); return next; }, async getSetting() { return undefined; }, async setSetting() {}, async startTask() {}, async reimplementTask() {}, async resumeTask() {}, async pauseTask() {}, async resumePausedTask() {}, async updateTaskPlan() {}, async approveTaskPlan() {}, async reviseTaskPlan() {}, async retryTaskValidation() {}, async sendTaskMessage() {}, async abortTask() {}, async runReview() {}, async resetReview() {}, async resetDelivery() {}, async submitMergeRequests() {}, async refreshMergeStatus() { return [] as MergeStatusSummary[]; }, async manualComplete() {}, async importJiraTask() { return demoTasks[1]!; }, async syncJiraTasks() { return []; }, async importJiraTasks() { return []; }, async testAtlassian() { return { ok: false, message: "Electron is required" }; }, async openTaskEditor() { throw new Error("Electron is required"); }, async mergeBackToBase() { throw new Error("Electron is required"); }, async revealTaskWorkspace() {}, async listTaskBackends() { return [{ id: "jira", displayName: "Jira", configured: false, description: "在设置中配置 Jira 后启用" }]; }, async openExternal() {}, async getQoderStatus() { return { enabled: false, connected: false, running: false, models: [] }; }, async respondTaskUi() {}, onTaskEvent() { return () => undefined; },

  // Memory mock(浏览器回退模式无持久层)
  async listMemories() { return []; },
  async upsertMemory() { throw new Error("Electron is required"); },
  async updateMemory() { throw new Error("Electron is required"); },
  async deleteMemory() {},
  async searchMemory() { return { memories: [], wikiDocs: [] }; },
  async indexRepoWiki() { return { indexed: 0, removed: 0 }; },
  async listRepoWikiDocs() { return []; },
  async searchRepoWiki() { return []; },

  // Agent mock（浏览器回退模式：内存 demo 数据）
  async listAgents() { return demoAgents; },
  async saveAgent(profile) {
    const index = demoAgents.findIndex((item) => item.id === profile.id);
    if (index >= 0) demoAgents[index] = profile;
    else demoAgents.push(profile);
    return demoAgents;
  },
  async deleteAgent(id) {
    const index = demoAgents.findIndex((item) => item.id === id);
    if (index >= 0) demoAgents.splice(index, 1);
    return demoAgents;
  },
  async listAgentTemplates() { return demoAgentTemplates; },
  async exportAgents() { return undefined; },
  async importAgents() { return demoAgents; },

  // Chat mock
  async listChats() { return [...memoryChats.values()].map(({ messages, ...meta }) => meta).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
  async getChat(id) {
    const conversation = memoryChats.get(id);
    if (!conversation) return undefined;
    const messages: ChatMessage[] = conversation.messages.map((record) => ({ ...record, parts: [{ driverId: record.driverId, type: "text", text: messageText(record) }] }));
    return { conversation, messages };
  },
  async createChat(input) {
    const existing = [...memoryChats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find((item) => item.messages.length === 0);
    if (existing) return existing;
    const id = makeId();
    const conv: ChatConversation = {
      id,
      title: "新对话",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messageCount: 0,
      model: input?.model,
      driverId: input?.driverId,
      messages: []
    };
    memoryChats.set(id, conv);
    return conv;
  },
  async deleteChat(id) { memoryChats.delete(id); },
  async listChatModels() { return defaultModelGroups; },
  async startChatStream({ streamId, chatId, driverId, model, message, mode }) {
    const conv = memoryChats.get(chatId);
    if (!conv) throw new Error("Chat not found");
    const createdAt = nowIso();
    const userMessage: StoredMessageRecord = {
      id: message.id,
      role: "user",
      createdAt,
      driverId,
      raw: { kind: "user", text: message.text }
    };
    conv.messages = [...conv.messages.filter((item) => item.id !== message.id), userMessage];
    if (conv.messages.filter((item) => item.role === "user").length === 1) conv.title = defaultTitle(messageText(userMessage));
    conv.model = model;
    if (!conv.driverId) conv.driverId = driverId;
    conv.messageCount = conv.messages.length;
    conv.updatedAt = createdAt;
    const assistantId = makeId();
    const demoCreation = mode === "task-create" ? { backend: "jira" as const, externalKey: "BSADAPT344-36525", summary: messageText(userMessage).slice(0, 32), projectKey: "BSADAPT344", issueType: "任务" } : undefined;
    const reply = demoCreation ? `已创建 Jira 任务 ${demoCreation.externalKey}。是否需要立即执行？` : `（演示模式）收到：${messageText(userMessage).slice(0, 80)}`;
    const emit = (chunk?: ChatStreamChunk, done?: boolean) => memoryListeners.forEach((callback) => callback({ streamId, chatId, driverId, chunk, done }));
    emit({ type: "start", messageId: assistantId, messageMetadata: { createdAt, model: "demo" } });
    const metadata: ChatMessageMetadata = { createdAt, model: "demo", status: "done", agentMode: mode ?? "chat", ...(demoCreation ? { taskCreation: demoCreation } : {}) };
    const assistantRecord: StoredMessageRecord = {
      id: assistantId,
      role: "assistant",
      createdAt,
      driverId,
      raw: { kind: "assistant", parts: [{ driverId, type: "text", text: reply }], ...(demoCreation ? { taskCreation: demoCreation } : {}) }
    };
    const parts: DriverPart[] = [{ driverId, type: "text", text: "" }];
    let index = 0;
    const timer = window.setInterval(() => {
      const delta = reply.slice(index, index + 4);
      index += delta.length;
      const textPart = parts[0];
      if (textPart && textPart.type === "text") textPart.text = reply.slice(0, index);
      if (delta) emit({ type: "part", part: { driverId, type: "text", text: reply.slice(0, index) } });
      if (index >= reply.length) {
        window.clearInterval(timer);
        memoryStreamTimers.delete(streamId);
        if (demoCreation) emit({ type: "task-created", result: demoCreation });
        emit({ type: "done", status: "done" });
        emit(undefined, true);
        conv.messages.push(assistantRecord);
        conv.messageCount = conv.messages.length;
        conv.updatedAt = nowIso();
      }
    }, 45);
    memoryStreamTimers.set(streamId, timer);
  },
  async abortChat({ streamId, chatId }) {
    const timer = memoryStreamTimers.get(streamId);
    if (timer !== undefined) window.clearInterval(timer);
    memoryStreamTimers.delete(streamId);
    const driverId = memoryChats.get(chatId)?.driverId ?? "qoder";
    memoryListeners.forEach((callback) => callback({ streamId, chatId, driverId, chunk: { type: "done", status: "aborted" }, done: true }));
  },
  onChatStreamEvent(callback) { memoryListeners.add(callback); return () => { memoryListeners.delete(callback); }; },
  async listTrace() { return []; },
  async getTrace() { return []; }
};
