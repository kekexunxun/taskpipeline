import type { AgentEvent, Approval, RepositoryProfile, Task, TaskCard, TaskRepository } from "@coding-agent/core";

export type ChangedFile = { repositoryId: string; repositoryName: string; path: string; status: string };
export type TaskDetail = { task?: Task; repositories: TaskRepository[]; events: AgentEvent[]; approvals: Approval[]; changedFiles: ChangedFile[] };
export type QoderStatus = {
  enabled: boolean; connected: boolean; running: boolean;
  account?: { subscriptionType?: string };
  usage?: { userType?: string; totalUsagePercentage?: number; isHighestTier?: boolean; expiresAt?: number; isQuotaExceeded?: boolean; userQuota?: { total?: number; used?: number; remaining?: number; percentage?: number; unit?: string }; addOnQuota?: { total?: number; used?: number; remaining?: number; percentage?: number; unit?: string }; orgResourcePackage?: { used?: number; cap?: number; remaining?: number; available?: boolean; unit?: string } } | null;
  models: Array<{ value: string; displayName: string; description: string; isDefault?: boolean; isEnabled?: boolean; isReasoning?: boolean; priceFactor?: number }>;
  error?: string;
};
export type JiraTaskCandidate = Pick<Task, "jiraKey" | "title" | "description" | "keywords" | "acceptanceCriteria"> & { jiraKey: string };
export type RepositoryFolder = Omit<RepositoryProfile, "id">;
export type MergeRepoStatus = { repoId: string; repoName: string; mergeRequestIid: number; mergeRequestUrl?: string; state: "opened" | "merged" | "closed" | "error"; error?: string };
export type MergeStatusSummary = { taskId: string; taskTitle: string; repos: MergeRepoStatus[]; allMerged: boolean; taskCompleted: boolean };

// === Chat API surface ===

export type ChatMessageRole = "user" | "assistant" | "system";
export type ChatMessageStatus = "streaming" | "done" | "error";

export type ChatMessage = {
  id: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  model?: string;
  status?: ChatMessageStatus;
};

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
  priceFactor?: number;
};

export type ChatModelGroup = {
  provider: "qoder" | "openai";
  displayName: string;
  models: ChatModelInfo[];
};

export type ChatEvent =
  | { type: "chat_message_start"; chatId: string; messageId: string; role: "assistant" }
  | { type: "chat_message_delta"; chatId: string; messageId: string; delta: string }
  | { type: "chat_message_done"; chatId: string; messageId: string; content: string; model?: string }
  | { type: "chat_message_error"; chatId: string; messageId: string; error: string };

export type AgentApi = {
  listTasks(): Promise<TaskCard[]>; getTask(id: string): Promise<TaskDetail>; createTask(input: { title: string; description: string }): Promise<Task>; updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  deleteTask(id: string): Promise<void>; listRepositories(): Promise<RepositoryProfile[]>; saveRepository(profile: RepositoryProfile): Promise<void>; deleteRepository(id: string): Promise<void>; chooseRepositoryFolder(): Promise<RepositoryFolder | undefined>; attachRepository(taskId: string, repositoryId: string): Promise<TaskRepository>; detachRepository(taskId: string, repositoryId: string): Promise<void>; getSetting(key: string): Promise<string | undefined>; setSetting(key: string, value: string, secret?: boolean): Promise<void>;
  startTask(taskId: string): Promise<void>; sendTaskMessage(taskId: string, message: string): Promise<void>; abortTask(): Promise<void>; runReview(taskId: string): Promise<void>; resetReview(taskId: string): Promise<void>; resetDelivery(taskId: string): Promise<void>; submitMergeRequests(taskId: string): Promise<void>; refreshMergeStatus(): Promise<MergeStatusSummary[]>; manualComplete(taskId: string): Promise<void>;
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
  appendUserMessage(id: string, text: string): Promise<ChatMessage>;
  listChatModels(): Promise<ChatModelGroup[]>;
  sendChatMessage(id: string, messageId: string, model: string): Promise<void>;
  abortChat(id: string): Promise<void>;
  onChatEvent(callback: (event: ChatEvent) => void): () => void;
};

declare global { interface Window { agentApi?: AgentApi } }

const demoTasks: TaskCard[] = [
  { id: "demo-1", jiraKey: "PAY-1842", title: "修复结算页优惠券并发校验", description: "优惠券并发使用时偶发重复核销。补充幂等保护与回归测试。", keywords: ["payment", "concurrency"], acceptanceCriteria: ["并发请求只核销一次"], state: "implementing", reviewStatus: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "in_progress", summary: "正在补充幂等锁和单元测试", repositories: [{ id: "r1", name: "payment-service", changeSummary: "5 files +128 -24", deliveryStatus: "changed" }] },
  { id: "demo-2", jiraKey: "OPS-938", title: "订单导出增加审计字段", description: "从 Jira 同步的待办任务。", keywords: ["export", "audit"], acceptanceCriteria: [], state: "draft", reviewStatus: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "todo", repositories: [{ id: "r2", name: "order-console", deliveryStatus: "pending" }] },
  { id: "demo-3", jiraKey: "CORE-417", title: "升级事件重试策略", description: "MR 已提交，等待合并。", keywords: ["events"], acceptanceCriteria: [], state: "await_merge", reviewStatus: "passed", commitMessage: "fix: CORE-417 improve retry backoff", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "in_review", repositories: [{ id: "r3", name: "event-core", changeSummary: "3 files +74 -18", deliveryStatus: "mr_created", mergeRequestUrl: "#" }] },
  { id: "demo-4", jiraKey: "WEB-206", title: "修复控制台权限展示", description: "MR 已合并。", keywords: ["console"], acceptanceCriteria: [], state: "completed", reviewStatus: "passed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), boardColumn: "done", repositories: [{ id: "r4", name: "web-console", deliveryStatus: "mr_created", mergeRequestUrl: "#" }] }
];

// 浏览器回退（vite 不带 Electron 启动时使用）的 mock 实现：任务走 demo 数据，
// Chat 走纯内存 store —— 仅供 UI 演示，不会写本地文件。
const memoryChats = new Map<string, ChatConversation>();
const memoryListeners = new Set<(event: ChatEvent) => void>();
const defaultModelGroups: ChatModelGroup[] = [
  {
    provider: "qoder",
    displayName: "Qoder Agent SDK",
    models: [
      { value: "qoder:claude-sonnet-4.5", displayName: "Claude Sonnet 4.5", isDefault: true, isReasoning: false, priceFactor: 1 },
      { value: "qoder:gpt-5", displayName: "GPT-5", isDefault: false, isReasoning: true, priceFactor: 1.2 }
    ]
  }
];

function mockAssistantReply(chatId: string, messageId: string, userText: string) {
  // 用 setTimeout 模拟流式输出（仅 mock）
  const text = `（演示模式）收到：${userText.slice(0, 80)}`;
  setTimeout(() => memoryListeners.forEach((cb) => cb({ type: "chat_message_start", chatId, messageId, role: "assistant" })), 100);
  let i = 0;
  const timer = window.setInterval(() => {
    i += 4;
    if (i >= text.length) {
      window.clearInterval(timer);
      memoryListeners.forEach((cb) => cb({ type: "chat_message_done", chatId, messageId, content: text, model: "demo" }));
      return;
    }
    memoryListeners.forEach((cb) => cb({ type: "chat_message_delta", chatId, messageId, delta: text.slice(i - 4, i) }));
  }, 60);
}

function nowIso() { return new Date().toISOString(); }
function makeId() { return crypto.randomUUID(); }
function defaultTitle(text: string) { return text.slice(0, 32).replace(/\s+/g, " ").trim() || "新对话"; }

export const api: AgentApi = window.agentApi ?? {
  async listTasks() { return demoTasks; },
  async getTask(id) { const task = demoTasks.find((item) => item.id === id); return { task, repositories: [], approvals: [], changedFiles: [], events: task?.state === "implementing" ? [{ id: "e1", taskId: id, kind: "status", title: "任务已确认，AI 会话已启动", createdAt: new Date(Date.now() - 240000).toISOString() }, { id: "e2", taskId: id, kind: "tool", title: "读取支付服务上下文", detail: "分析幂等键生成与优惠券核销路径", createdAt: new Date(Date.now() - 170000).toISOString() }, { id: "e3", taskId: id, kind: "command", title: "单元测试通过", detail: "18 passed · 1.8s", createdAt: new Date(Date.now() - 60000).toISOString() }] : [] }; },
  async createTask(input) { return { ...demoTasks[1]!, ...input }; }, async updateTask(id, patch) { return { ...demoTasks.find((item) => item.id === id)!, ...patch }; }, async deleteTask() {}, async listRepositories() { return []; }, async saveRepository() {}, async deleteRepository() {}, async chooseRepositoryFolder() { return undefined; }, async attachRepository() { throw new Error("Electron is required"); }, async detachRepository() {}, async getSetting() { return undefined; }, async setSetting() {}, async startTask() {}, async sendTaskMessage() {}, async abortTask() {}, async runReview() {}, async resetReview() {}, async resetDelivery() {}, async submitMergeRequests() {}, async refreshMergeStatus() { return [] as MergeStatusSummary[]; }, async manualComplete() {}, async importJiraTask() { return demoTasks[1]!; }, async syncJiraTasks() { return []; }, async importJiraTasks() { return []; }, async testAtlassian() { return { ok: false, message: "Electron is required" }; }, async openTaskEditor() { throw new Error("Electron is required"); }, async openExternal() {}, async getQoderStatus() { return { enabled: false, connected: false, running: false, models: [] }; }, async respondTaskUi() {}, onTaskEvent() { return () => undefined; },

  // Chat mock
  async listChats() { return [...memoryChats.values()].map(({ messages, ...meta }) => meta).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
  async getChat(id) { return memoryChats.get(id); },
  async createChat(model) {
    const id = makeId();
    const conv: ChatConversation = { id, title: "新对话", createdAt: nowIso(), updatedAt: nowIso(), messageCount: 0, model, messages: [] };
    memoryChats.set(id, conv);
    return conv;
  },
  async deleteChat(id) { memoryChats.delete(id); },
  async appendUserMessage(id, text) {
    const conv = memoryChats.get(id); if (!conv) throw new Error("Chat not found");
    const msg: ChatMessage = { id: makeId(), role: "user", content: text, createdAt: nowIso(), status: "done" };
    conv.messages.push(msg);
    if (conv.messages.filter((m) => m.role === "user").length === 1) conv.title = defaultTitle(text);
    conv.messageCount = conv.messages.length; conv.updatedAt = nowIso();
    return msg;
  },
  async listChatModels() { return defaultModelGroups; },
  async sendChatMessage(chatId, messageId, _model) {
    const conv = memoryChats.get(chatId); if (!conv) throw new Error("Chat not found");
    const assistantId = makeId();
    conv.messages.push({ id: assistantId, role: "assistant", content: "", createdAt: nowIso(), status: "streaming" });
    const userText = conv.messages.find((m) => m.id === messageId)?.content ?? "";
    mockAssistantReply(chatId, assistantId, userText);
    // 等待流式结束后把 assistant 消息从 streaming 转为 done
    const finishTimer = window.setInterval(() => {
      const m = conv.messages.find((x) => x.id === assistantId);
      if (m && m.content.length > 0 && m.content.endsWith("）")) {
        m.status = "done";
        conv.updatedAt = nowIso();
        window.clearInterval(finishTimer);
      }
    }, 200);
  },
  async abortChat() { /* mock no-op */ },
  onChatEvent(callback) { memoryListeners.add(callback); return () => memoryListeners.delete(callback); }
};
