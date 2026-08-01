import type { AgentEvent, Approval, RepositoryProfile, Task, TaskCard, TaskRepository, TaskStartMode } from "@coding-agent/core";
import type { UIMessage, UIMessageChunk } from "ai";

export type ChangedFile = { repositoryId: string; repositoryName: string; path: string; status: string };
export type TaskDetail = { task?: Task; repositories: TaskRepository[]; events: AgentEvent[]; approvals: Approval[]; changedFiles: ChangedFile[] };
export type QoderStatus = {
  enabled: boolean; connected: boolean; running: boolean;
  account?: { subscriptionType?: string };
  usage?: { userType?: string; totalUsagePercentage?: number; isHighestTier?: boolean; expiresAt?: number; isQuotaExceeded?: boolean; userQuota?: { total?: number; used?: number; remaining?: number; percentage?: number; unit?: string }; addOnQuota?: { total?: number; used?: number; remaining?: number; percentage?: number; unit?: string }; orgResourcePackage?: { used?: number; cap?: number; remaining?: number; available?: boolean; unit?: string } } | null;
  models: Array<{ value: string; displayName: string; description: string; isDefault?: boolean; isEnabled?: boolean; isReasoning?: boolean; isVl?: boolean; priceFactor?: number }>;
  error?: string;
};
export type JiraTaskCandidate = Pick<Task, "jiraKey" | "title" | "description" | "keywords" | "acceptanceCriteria"> & { jiraKey: string };
export type RepositoryFolder = Omit<RepositoryProfile, "id">;
export type MergeRepoStatus = { repoId: string; repoName: string; mergeRequestIid: number; mergeRequestUrl?: string; state: "opened" | "merged" | "closed" | "error"; error?: string };
export type MergeStatusSummary = { taskId: string; taskTitle: string; repos: MergeRepoStatus[]; allMerged: boolean; taskCompleted: boolean };
export type CreateTaskInput = Pick<Task, "title" | "description"> & Partial<Pick<Task, "keywords" | "acceptanceCriteria">>;
export type RepositoryCommands = Partial<Pick<TaskRepository, "setupCommand" | "lintCommand" | "testCommand" | "buildCommand">>;
export type StartTaskOptions = { mode: TaskStartMode; repositoryCommands?: Record<string, RepositoryCommands> };

// === Chat API surface ===

export type ChatMessageStatus = "done" | "error" | "aborted";
export type ChatMessageMetadata = { createdAt: string; model?: string; status?: ChatMessageStatus };
export type ChatMessage = UIMessage<ChatMessageMetadata>;

export type ChatConversationMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: "qoder" | "openai";
  messageCount: number;
};

export type ChatConversation = ChatConversationMeta & { messages: ChatMessage[] };

export type ChatModelInfo = {
  value: string;
  displayName: string;
  isDefault?: boolean;
  isReasoning?: boolean;
  isVl?: boolean;
  priceFactor?: number;
};

export type ChatModelGroup = {
  provider: "qoder" | "openai";
  displayName: string;
  models: ChatModelInfo[];
};

export type StartChatStreamInput = { streamId: string; chatId: string; model: string; message: ChatMessage };
export type AbortChatStreamInput = { streamId: string; chatId: string };
export type ChatStreamEvent = { streamId: string; chatId: string; chunk?: UIMessageChunk; error?: string; done?: boolean };

export type AgentApi = {
  listTasks(): Promise<TaskCard[]>; getTask(id: string): Promise<TaskDetail>; createTask(input: CreateTaskInput): Promise<Task>; updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  deleteTask(id: string): Promise<void>; listRepositories(): Promise<RepositoryProfile[]>; saveRepository(profile: RepositoryProfile): Promise<void>; deleteRepository(id: string): Promise<void>; chooseRepositoryFolder(): Promise<RepositoryFolder | undefined>; attachRepository(taskId: string, repositoryId: string): Promise<TaskRepository>; detachRepository(taskId: string, repositoryId: string): Promise<void>; getSetting(key: string): Promise<string | undefined>; setSetting(key: string, value: string, secret?: boolean): Promise<void>;
  startTask(taskId: string, options?: StartTaskOptions): Promise<void>; approveTaskPlan(taskId: string): Promise<void>; reviseTaskPlan(taskId: string, feedback: string): Promise<void>; retryTaskValidation(taskId: string): Promise<void>; sendTaskMessage(taskId: string, message: string): Promise<void>; abortTask(): Promise<void>; runReview(taskId: string): Promise<void>; resetReview(taskId: string): Promise<void>; resetDelivery(taskId: string): Promise<void>; submitMergeRequests(taskId: string): Promise<void>; refreshMergeStatus(): Promise<MergeStatusSummary[]>; manualComplete(taskId: string): Promise<void>;
  importJiraTask(keyOrUrl: string): Promise<Task>; syncJiraTasks(): Promise<JiraTaskCandidate[]>; importJiraTasks(candidates: JiraTaskCandidate[]): Promise<Task[]>; testAtlassian(kind: "jira" | "confluence"): Promise<{ ok: boolean; message: string }>;
  openTaskEditor(taskId: string, editor: "vscode" | "qoder"): Promise<void>;
  openExternal(url: string): Promise<void>;
  getQoderStatus(): Promise<QoderStatus>;
  respondTaskUi(response: unknown): Promise<void>; onTaskEvent(callback: (event: any) => void): () => void;
  // chat
  listChats(): Promise<ChatConversationMeta[]>;
  getChat(id: string): Promise<ChatConversation | undefined>;
  createChat(model?: string): Promise<ChatConversation>;
  deleteChat(id: string): Promise<void>;
  listChatModels(): Promise<ChatModelGroup[]>;
  startChatStream(input: StartChatStreamInput): Promise<void>;
  abortChat(input: AbortChatStreamInput): Promise<void>;
  onChatStreamEvent(callback: (event: ChatStreamEvent) => void): () => void;
};

declare global { interface Window { agentApi?: AgentApi } }

const demoTasks: TaskCard[] = [
  { id: "demo-1", jiraKey: "PAY-1842", title: "修复结算页优惠券并发校验", description: "优惠券并发使用时偶发重复核销。补充幂等保护与回归测试。", keywords: ["payment", "concurrency"], acceptanceCriteria: ["并发请求只核销一次"], state: "implementing", reviewStatus: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "in_progress", summary: "正在补充幂等锁和单元测试", repositories: [{ id: "r1", name: "payment-service", changeSummary: "5 files +128 -24", deliveryStatus: "changed" }] },
  { id: "demo-2", jiraKey: "OPS-938", title: "订单导出增加审计字段", description: "从 Jira 同步的待办任务。", keywords: ["export", "audit"], acceptanceCriteria: [], state: "draft", reviewStatus: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "todo", repositories: [{ id: "r2", name: "order-console", deliveryStatus: "pending" }] },
  { id: "demo-3", jiraKey: "CORE-417", title: "升级事件重试策略", description: "MR 已提交，等待合并。", keywords: ["events"], acceptanceCriteria: [], state: "await_merge", reviewStatus: "passed", commitMessage: "fix: CORE-417 improve retry backoff", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "in_review", repositories: [{ id: "r3", name: "event-core", changeSummary: "3 files +74 -18", deliveryStatus: "mr_created", mergeRequestUrl: "#" }] },
  { id: "demo-4", jiraKey: "WEB-206", title: "修复控制台权限展示", description: "MR 已合并。", keywords: ["console"], acceptanceCriteria: [], state: "completed", reviewStatus: "passed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "done", repositories: [{ id: "r4", name: "web-console", deliveryStatus: "mr_created", mergeRequestUrl: "#" }] }
];

const demoRepositories: RepositoryProfile[] = [
  { id: "repo-payment", name: "payment-service", localPath: "/demo/payment-service", defaultBranch: "main", setupCommand: "npm install", lintCommand: "npm run lint", testCommand: "npm test", buildCommand: "npm run build" },
  { id: "repo-order", name: "order-console", localPath: "/demo/order-console", defaultBranch: "main", setupCommand: "npm install", lintCommand: "npm run lint", testCommand: "npm test", buildCommand: "npm run build" },
  { id: "repo-events", name: "event-core", localPath: "/demo/event-core", defaultBranch: "main" },
  { id: "repo-web", name: "web-console", localPath: "/demo/web-console", defaultBranch: "main" }
];

const demoTaskRepositories = new Map<string, TaskRepository[]>(demoTasks.map((task, index) => {
  const profile = demoRepositories[index]!;
  const cardRepo = task.repositories[0]!;
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
    provider: "qoder",
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
function messageText(message: ChatMessage) { return message.parts.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join(""); }

export const api: AgentApi = window.agentApi ?? {
  async listTasks() { return demoTasks; },
  async getTask(id) { const task = demoTasks.find((item) => item.id === id); return { task, repositories: demoTaskRepositories.get(id) ?? [], approvals: [], changedFiles: [], events: task?.state === "implementing" ? [{ id: "e1", taskId: id, kind: "status", title: "任务已确认，AI 会话已启动", createdAt: new Date(Date.now() - 240000).toISOString() }, { id: "e2", taskId: id, kind: "tool", title: "读取支付服务上下文", detail: "分析幂等键生成与优惠券核销路径", createdAt: new Date(Date.now() - 170000).toISOString() }, { id: "e3", taskId: id, kind: "command", title: "单元测试通过", detail: "18 passed · 1.8s", createdAt: new Date(Date.now() - 60000).toISOString() }] : [] }; },
  async createTask(input) {
    const now = nowIso();
    const task: TaskCard = { id: makeId(), ...input, keywords: input.keywords ?? [], acceptanceCriteria: input.acceptanceCriteria ?? [], state: "draft", reviewStatus: "pending", createdAt: now, updatedAt: now, boardColumn: "todo", repositories: [] };
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
  async deleteTask(id) { const index = demoTasks.findIndex((item) => item.id === id); if (index >= 0) demoTasks.splice(index, 1); demoTaskRepositories.delete(id); }, async listRepositories() { return demoRepositories; }, async saveRepository() {}, async deleteRepository() {}, async chooseRepositoryFolder() { return undefined; }, async attachRepository(taskId, repositoryId) { const profile = demoRepositories.find((item) => item.id === repositoryId); if (!profile) throw new Error("Repository not found"); const repo: TaskRepository = { id: makeId(), taskId, repositoryId, name: profile.name, localPath: profile.localPath, baseBranch: profile.defaultBranch, setupCommand: profile.setupCommand, lintCommand: profile.lintCommand, testCommand: profile.testCommand, buildCommand: profile.buildCommand, deliveryStatus: "pending" }; demoTaskRepositories.set(taskId, [...(demoTaskRepositories.get(taskId) ?? []), repo]); return repo; }, async detachRepository(taskId, repositoryId) { demoTaskRepositories.set(taskId, (demoTaskRepositories.get(taskId) ?? []).filter((repo) => repo.repositoryId !== repositoryId)); }, async getSetting() { return undefined; }, async setSetting() {}, async startTask() {}, async approveTaskPlan() {}, async reviseTaskPlan() {}, async retryTaskValidation() {}, async sendTaskMessage() {}, async abortTask() {}, async runReview() {}, async resetReview() {}, async resetDelivery() {}, async submitMergeRequests() {}, async refreshMergeStatus() { return [] as MergeStatusSummary[]; }, async manualComplete() {}, async importJiraTask() { return demoTasks[1]!; }, async syncJiraTasks() { return []; }, async importJiraTasks() { return []; }, async testAtlassian() { return { ok: false, message: "Electron is required" }; }, async openTaskEditor() { throw new Error("Electron is required"); }, async openExternal() {}, async getQoderStatus() { return { enabled: false, connected: false, running: false, models: [] }; }, async respondTaskUi() {}, onTaskEvent() { return () => undefined; },

  // Chat mock
  async listChats() { return [...memoryChats.values()].map(({ messages, ...meta }) => meta).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
  async getChat(id) { return memoryChats.get(id); },
  async createChat(model) {
    const existing = [...memoryChats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find((item) => item.messages.length === 0);
    if (existing) return existing;
    const id = makeId();
    const conv: ChatConversation = { id, title: "新对话", createdAt: nowIso(), updatedAt: nowIso(), messageCount: 0, model, messages: [] };
    memoryChats.set(id, conv);
    return conv;
  },
  async deleteChat(id) { memoryChats.delete(id); },
  async listChatModels() { return defaultModelGroups; },
  async startChatStream({ streamId, chatId, model, message }) {
    const conv = memoryChats.get(chatId); if (!conv) throw new Error("Chat not found");
    const createdAt = nowIso();
    const userMessage: ChatMessage = { ...message, metadata: { createdAt, status: "done" } };
    conv.messages = [...conv.messages.filter((item) => item.id !== message.id), userMessage];
    if (conv.messages.filter((item) => item.role === "user").length === 1) conv.title = defaultTitle(messageText(message));
    conv.model = model; conv.messageCount = conv.messages.length; conv.updatedAt = createdAt;
    const assistantId = makeId(); const textId = `text-${assistantId}`; const reply = `（演示模式）收到：${messageText(message).slice(0, 80)}`;
    const emit = (chunk?: UIMessageChunk, done?: boolean) => memoryListeners.forEach((callback) => callback({ streamId, chatId, chunk, done }));
    emit({ type: "start", messageId: assistantId, messageMetadata: { createdAt, model: "demo" } }); emit({ type: "text-start", id: textId });
    let index = 0;
    const timer = window.setInterval(() => {
      const delta = reply.slice(index, index + 4); index += delta.length;
      if (delta) emit({ type: "text-delta", id: textId, delta });
      if (index >= reply.length) {
        window.clearInterval(timer); memoryStreamTimers.delete(streamId);
        emit({ type: "text-end", id: textId }); emit({ type: "finish", finishReason: "stop", messageMetadata: { createdAt, model: "demo", status: "done" } }); emit(undefined, true);
        conv.messages.push({ id: assistantId, role: "assistant", metadata: { createdAt, model: "demo", status: "done" }, parts: [{ type: "text", text: reply, state: "done" }] }); conv.messageCount = conv.messages.length; conv.updatedAt = nowIso();
      }
    }, 45);
    memoryStreamTimers.set(streamId, timer);
  },
  async abortChat({ streamId, chatId }) { const timer = memoryStreamTimers.get(streamId); if (timer !== undefined) window.clearInterval(timer); memoryStreamTimers.delete(streamId); memoryListeners.forEach((callback) => callback({ streamId, chatId, chunk: { type: "abort", reason: "用户已停止生成" }, done: true })); },
  onChatStreamEvent(callback) { memoryListeners.add(callback); return () => memoryListeners.delete(callback); }
};
