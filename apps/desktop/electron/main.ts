import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIDialogOptions,
  type ExtensionUIContext
} from "@earendil-works/pi-coding-agent";
import { TaskStore, LocalFileKeyStore, transitionTask, type AgentEvent, type SessionUsage, type SettingResolver, type Task, type TaskEventSink, type TaskRepository } from "@coding-agent/core";
import {
  AtlassianClientFactory, DeliveryService, GitService, importJiraIssue, MergeStatusRefresher, openTaskEditor, OpenCodeReviewService,
  OpenAICompatReviewer, parseGitLabRemote, redactSecrets,
  ReviewOrchestrator, syncJiraTasks, TaskCompleter, TaskWorkflow, testAtlassianConnection, asReviewer
} from "@coding-agent/integrations";
import { resolveBundledOcrBinary, resolveOcrBinary, createOcrRunner } from "./ocr.js";
import { accessToken, query, type AccountInfo, type ModelInfo, type Query, type SDKMessage, type UsageInfo } from "@qoder-ai/qoder-agent-sdk";
import { ChatService } from "./chat/chat-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let piSession: AgentSession | undefined;
let unsubscribePi: (() => void) | undefined;
const pendingUi = new Map<string, (response: Record<string, unknown>) => void>();
const dataDir = process.env.CODING_AGENT_DATA_DIR ?? join(app.getPath("userData"), "data");
process.env.CODING_AGENT_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });
const store = new TaskStore(join(dataDir, "coding-agent.db"));
const keyStore = new LocalFileKeyStore(dataDir);
let activeTaskId: string | undefined;
let activeQoderQuery: Query | undefined;
let activeQoderAbort: AbortController | undefined;

type ModelProfile = { provider?: string; baseUrl?: string; model?: string; apiKeyEnv?: string };
type QoderStatus = {
  enabled: boolean;
  connected: boolean;
  running: boolean;
  account?: AccountInfo;
  usage?: UsageInfo | null;
  models: Array<Pick<ModelInfo, "value" | "displayName" | "description" | "isDefault" | "isEnabled" | "isReasoning" | "isVl" | "priceFactor">>;
  error?: string;
};

const taskStateLabels: Record<Task["state"], string> = {
  draft: "待处理", confirmed: "已确认", preparing: "准备环境", implementing: "实现中",
  awaiting_review: "等待 Review", reviewing: "Review 中", review_blocked: "Review 阻断",
  awaiting_commit: "等待提交 MR", delivering: "提交 MR 中", await_merge: "等待合并",
  completed: "已完成", failed: "执行失败", cancelled: "已取消"
};

// === 抽象层宿主实现 ===========================================================

class DesktopEventSink implements TaskEventSink {
  addEvent(input: Omit<AgentEvent, "id" | "createdAt">): AgentEvent {
    const event = store.addEvent(input);
    emitTaskChanged(input.taskId);
    return event;
  }
  emitChanged(taskId: string): void { emitTaskChanged(taskId); }
}

class DesktopSettingResolver implements SettingResolver {
  get(key: string): string | undefined { return store.getSetting(key); }
  getSecret(key: string, envName?: string): string | undefined {
    if (envName && process.env[envName]) return process.env[envName];
    return keyStore.resolve(store.getSetting(key), key);
  }
}

const desktopSink = new DesktopEventSink();
const desktopResolver = new DesktopSettingResolver();

// === 通用工具 =================================================================

function settingFlag(key: string): boolean { return store.getSetting(key) === "true"; }
function protectedValue(key: string): string | undefined { return keyStore.resolve(store.getSetting(key), key); }
function taskWorkspace(taskId: string): string { return join(dataDir, "workspaces", taskId); }
function sendTaskEvent(event: Record<string, unknown>): void {
  const json = JSON.stringify(event, (_key, value) => typeof value === "string" ? redactSecrets(value) : value);
  mainWindow?.webContents.send("task:event", JSON.parse(json) as unknown);
}
function emitTaskChanged(taskId: string): void { sendTaskEvent({ type: "task_changed", taskId }); }
function addTaskEvent(event: Parameters<TaskStore["addEvent"]>[0]): void {
  store.addEvent(event);
  emitTaskChanged(event.taskId);
}
function updatePiUsage(taskId: string): void {
  if (!piSession) return;
  const stats = piSession.getSessionStats();
  store.updateTask(taskId, { sessionUsage: {
    provider: "openai",
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    costUsd: stats.cost,
    turns: stats.assistantMessages
  } });
  emitTaskChanged(taskId);
}
function workspaceEntry(name: string, repositoryId: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "repository";
  const entry = used.has(base) ? `${base}-${repositoryId.slice(0, 8)}` : base;
  used.add(entry);
  return entry;
}
function updateState(task: Task, state: Task["state"]): Task {
  if (task.state !== state) transitionTask(task.state, state);
  const updated = store.updateTask(task.id, { state });
  addTaskEvent({ taskId: task.id, kind: "status", title: `状态更新为 ${taskStateLabels[state]}` });
  return updated;
}

function modelProvider(): "qoder" | "openai" {
  const raw = store.getSetting("modelProfile");
  if (!raw) return "qoder";
  try { return JSON.parse(raw).provider === "qoder" ? "qoder" : "openai"; } catch { return "qoder"; }
}

// === 下沉模块实例(整个进程单例) ===============================================

const ocrService = new OpenCodeReviewService(resolveOcrBinary(), createOcrRunner());
const gitService = new GitService();
const openAIReviewer = new OpenAICompatReviewer(desktopResolver);
function buildReviewOrchestrator(): ReviewOrchestrator {
  return new ReviewOrchestrator({ ocr: ocrService, git: gitService, reviewer: asReviewer(callQoderOrOpenAIReviewer) }, desktopSink);
}
const taskWorkflow = new TaskWorkflow(store, desktopResolver, desktopSink, taskWorkspace);
const deliveryService = new DeliveryService(store, gitService, desktopResolver, desktopSink);
const mergeRefresher = new MergeStatusRefresher(store, desktopResolver, desktopSink);
const taskCompleter = new TaskCompleter(store, desktopSink);
const atlassianFactory = new AtlassianClientFactory(desktopResolver);
const chatService = new ChatService(store, dataDir, getQoderStatus, () => protectedValue("qoderToken"), () => protectedValue("modelApiKey"), () => mainWindow);

// === Review 实现(Qoder / OpenAI 兼容) =========================================

async function callQoderReviewer(prompt: string, taskId: string, model?: string): Promise<string> {
  const token = protectedValue("qoderToken");
  if (!token) throw new Error("请先配置 Qoder Token");
  const abort = new AbortController();
  const q = query({
    prompt,
    options: {
      auth: accessToken(token),
      cwd: process.cwd(),
      abortController: abort,
      persistSession: false,
      permissionMode: "default",
      controlRequestTimeoutMs: 15_000,
      ...(model ? { model } : {})
    }
  });
  const REVIEW_LLM_TIMEOUT_MS = 3 * 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort(new Error(`qoder review 在 ${REVIEW_LLM_TIMEOUT_MS / 1000}s 内未返回,主动 abort`));
      reject(new Error(`qoder review 在 ${REVIEW_LLM_TIMEOUT_MS / 1000}s 内未返回,主动 abort`));
    }, REVIEW_LLM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        let text = "";
        for await (const message of q) {
          recordQoderMessage(taskId, message);
          if (message.type === "assistant") {
            const content = (message as unknown as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
            if (Array.isArray(content)) text += content.filter((c) => c?.type === "text" && c.text).map((c) => c.text).join("\n");
          } else if (message.type === "result") {
            const result = (message as unknown as { result?: string }).result;
            if (result) text += result;
          }
        }
        return text;
      })(),
      timeoutPromise
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!abort.signal.aborted) abort.abort();
    try { await q.close(); } catch { /* ignore */ }
  }
}

function callQoderOrOpenAIReviewer(input: Parameters<OpenAICompatReviewer["call"]>[0], taskId: string, model?: string): Promise<string> {
  if (modelProvider() === "qoder") return callQoderReviewer(buildReviewPromptForQoder(input), taskId, model);
  return openAIReviewer.call(input, taskId, model);
}

function buildReviewPromptForQoder(input: Parameters<OpenAICompatReviewer["call"]>[0]): string {
  return [
    "You are a code reviewer. Follow the rules below as a checklist.",
    "Review the diff carefully. Report only actionable findings.",
    "Severity: critical (data loss / security / crash) | high (bug) | medium (perf / missing error handling) | low (style).",
    "Drop low unless genuinely valuable.",
    "",
    `Repository: ${input.repo}`,
    `Task: ${input.task}`,
    `Changed files: ${input.files.join(", ")}`,
    "",
    "## Review rules (from ocr)",
    input.rules || "(no rule.json configured, apply general code review heuristics)",
    "",
    "## Diff",
    "```diff",
    input.diff,
    "```",
    "",
    "Respond with strict JSON only (no prose, no code fence). Write each `message` value in Chinese (zh-CN):",
    '{"status":"completed","comments":[{"path":"...","line":<number|null>,"severity":"critical|high|medium|low","message":"..."}],"summary":{"files":<number>,"comments":<number>}}'
  ].join("\n");
}

// === Qoder 集成(留在 desktop) ==================================================

function qoderText(message: SDKMessage): string | undefined {
  const record = message as unknown as Record<string, any>;
  if (message.type === "result") return record.result ?? record.errors?.join("\n");
  if (message.type !== "assistant") return undefined;
  const content = record.message?.content;
  if (!Array.isArray(content)) return undefined;
  return content.filter((item: any) => item?.type === "text").map((item: any) => item.text).filter(Boolean).join("\n") || undefined;
}

function recordQoderMessage(taskId: string, message: SDKMessage): void {
  const text = qoderText(message);
  const current = store.getTask(taskId)?.sessionUsage;
  const previous = current?.provider === "qoder" ? current : undefined;

  if (message.type === "assistant") {
    const u = (message as unknown as {
      message?: { usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } };
    }).message?.usage;
    if (u) {
      const inputTokens  = (previous?.inputTokens ?? 0) + (u.input_tokens ?? 0);
      const outputTokens = (previous?.outputTokens ?? 0) + (u.output_tokens ?? 0);
      const cacheRead    = (previous?.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      const cacheWrite   = (previous?.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      store.updateTask(taskId, { sessionUsage: {
        provider: "qoder",
        inputTokens, outputTokens,
        cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
        totalTokens: inputTokens + outputTokens + cacheRead + cacheWrite,
        costUsd: previous?.costUsd, durationMs: previous?.durationMs, turns: previous?.turns
      } });
    }
  }

  if (message.type === "result") {
    const result = message as unknown as {
      duration_ms: number; num_turns: number; total_cost_usd?: number;
      modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>;
      usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    };
    const models = Object.values(result.modelUsage ?? {});
    const sum = (k: "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "costUSD") =>
      models.reduce((s, m) => s + ((m?.[k] as number) ?? 0), 0);
    const mIn = sum("inputTokens"), mOut = sum("outputTokens"), mRd = sum("cacheReadInputTokens"), mWr = sum("cacheCreationInputTokens"), mCost = sum("costUSD");
    const uIn = result.usage?.input_tokens ?? 0, uOut = result.usage?.output_tokens ?? 0, uRd = result.usage?.cache_read_input_tokens ?? 0, uWr = result.usage?.cache_creation_input_tokens ?? 0;
    const pick = (mv: number, uv: number, prev: number | undefined) => mv > 0 ? mv : uv > 0 ? uv : (prev ?? 0);
    const inputTokens = pick(mIn, uIn, previous?.inputTokens);
    const outputTokens = pick(mOut, uOut, previous?.outputTokens);
    const cacheRead = pick(mRd, uRd, previous?.cacheReadTokens);
    const cacheWrite = pick(mWr, uWr, previous?.cacheWriteTokens);
    const cost = mCost > 0 ? mCost : (result.total_cost_usd ?? 0);
    const usage: SessionUsage = {
      provider: "qoder",
      inputTokens, outputTokens,
      cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
      totalTokens: inputTokens + outputTokens + cacheRead + cacheWrite,
      costUsd: (previous?.costUsd ?? 0) + cost,
      durationMs: (previous?.durationMs ?? 0) + result.duration_ms,
      turns: (previous?.turns ?? 0) + result.num_turns
    };
    store.updateTask(taskId, { sessionUsage: usage });
  }
  if (text) addTaskEvent({ taskId, kind: "message", title: "Qoder Agent", detail: text });
  else if (message.type === "system") addTaskEvent({ taskId, kind: "status", title: `Qoder ${message.subtype}`, detail: JSON.stringify(message).slice(0, 2000) });
  emitPi({ type: "qoder_event", taskId, message });
}

function qoderLogFile(taskId: string): string | undefined {
  if (process.env.CODING_AGENT_QODER_LOG !== "1") return undefined;
  const dir = join(dataDir, "logs", "qoder");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `${taskId}-${stamp}.jsonl`);
}

function logQoderMessage(file: string | undefined, message: SDKMessage): void {
  if (!file) return;
  try { appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), msg: message }) + "\n", "utf8"); }
  catch { /* 日志写不进去不能影响主流程 */ }
}

async function runQoder(taskId: string, extraPrompt?: string): Promise<void> {
  const task = await taskWorkflow.prepare(taskId);
  const token = protectedValue("qoderToken");
  if (!token) throw new Error("请先配置 Qoder Token");
  const repos = store.listTaskRepositories(task.id);
  if (repos.length === 0) throw new Error("任务未关联代码仓库");
  activeTaskId = task.id;
  addTaskEvent({ taskId, kind: "status", title: "执行环境:Qoder Agent SDK", detail: "使用应用随附运行时,并在已配置仓库目录中执行" });
  activeQoderAbort?.abort();
  activeQoderAbort = new AbortController();
  const prompt = extraPrompt
    ? `${task.title}\n\n${task.description}\n\nAdditional request:\n${extraPrompt}`
    : `${task.title}\n\n${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`;
  const q = query({ prompt, options: { auth: accessToken(token), cwd: repos[0]!.worktreePath ?? repos[0]!.localPath, additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath), abortController: activeQoderAbort, includePartialMessages: true, permissionMode: "acceptEdits", persistSession: true, ...(task.qoderModel ? { model: task.qoderModel } : {}) } });
  activeQoderQuery = q;
  emitPi({ type: "agent_start", provider: "qoder", taskId });
  const logFile = qoderLogFile(task.id);
  if (logFile) {
    try {
      appendFileSync(logFile, JSON.stringify({
        t: new Date().toISOString(), kind: "meta", taskId: task.id, prompt,
        options: { cwd: repos[0]!.worktreePath ?? repos[0]!.localPath, model: task.qoderModel, additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath) }
      }) + "\n", "utf8");
    } catch { /* 忽略 */ }
  }
  try {
    for await (const message of q) {
      logQoderMessage(logFile, message);
      recordQoderMessage(task.id, message);
    }
    await finishImplementation(task.id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    addTaskEvent({ taskId, kind: "error", title: "Qoder 执行失败", detail });
    const current = store.getTask(task.id);
    if (current?.state === "implementing") updateState(current, "failed");
    emitPi({ type: "agent_error", taskId, message: detail });
  } finally {
    activeQoderQuery = undefined;
    activeQoderAbort = undefined;
    emitPi({ type: "agent_end", provider: "qoder", taskId });
  }
}

async function finishImplementation(taskId: string): Promise<void> {
  const task = store.getTask(taskId);
  if (!task || task.state !== "implementing") return;
  if (taskWorkflow.isReviewEnabled()) await taskWorkflow.runReview(taskId, buildReviewOrchestrator());
  else updateState(task, "awaiting_review");
  const updated = store.getTask(taskId);
  if (updated?.state === "awaiting_commit" && taskWorkflow.shouldAutoCreateMergeRequests()) await deliveryService.submitMergeRequests(taskId);
}

// === Pi Session 集成(留在 desktop) ============================================

function syncPiModelConfig(raw: string): void {
  const profile = JSON.parse(raw) as ModelProfile;
  if (!profile.baseUrl || !profile.model) return;
  const agentDir = store.getSetting("piAgentDir") ?? getAgentDir();
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  const current = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown> : {};
  const providers = current.providers && typeof current.providers === "object" && !Array.isArray(current.providers) ? current.providers as Record<string, unknown> : {};
  const provider = profile.provider ?? "company-openai";
  const next = {
    ...current,
    providers: {
      ...providers,
      [provider]: {
        baseUrl: profile.baseUrl,
        api: "openai-completions",
        apiKey: `$${profile.apiKeyEnv ?? "OPENAI_API_KEY"}`,
        models: [{ id: profile.model, name: profile.model, reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 32768 }]
      }
    }
  };
  const temporaryPath = `${modelsPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, modelsPath);
}

function emitPi(event: unknown): void {
  const json = JSON.stringify(event, (_key, value) => typeof value === "string" ? redactSecrets(value) : value);
  const record = JSON.parse(json) as Record<string, unknown>;
  if (activeTaskId && modelProvider() === "openai" && ["message_end", "agent_end"].includes(String(record.type))) updatePiUsage(activeTaskId);
  if (activeTaskId && record.type === "tool_execution_end") emitTaskChanged(activeTaskId);
  sendTaskEvent(typeof record.taskId === "string" || !activeTaskId ? record : { ...record, taskId: activeTaskId });
  if (record.type === "agent_end" && activeTaskId && modelProvider() === "openai") void finishImplementation(activeTaskId).catch((error) => emitPi({ type: "agent_error", message: error instanceof Error ? error.message : String(error) }));
}

function requestUi<T>(method: string, payload: Record<string, unknown>, options?: ExtensionUIDialogOptions): Promise<T | undefined> {
  const id = randomUUID();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (response: Record<string, unknown>) => {
      if (timer) clearTimeout(timer);
      pendingUi.delete(id);
      if (response.cancelled) resolve(undefined);
      else if (method === "confirm") resolve(Boolean(response.confirmed) as T);
      else resolve(response.value as T | undefined);
    };
    pendingUi.set(id, finish);
    emitPi({ type: "extension_ui_request", id, method, ...payload, timeout: options?.timeout });
    if (options?.timeout) timer = setTimeout(() => finish({ cancelled: true }), options.timeout);
    options?.signal?.addEventListener("abort", () => finish({ cancelled: true }), { once: true });
  });
}

function createGuiUI(): ExtensionUIContext {
  const ui = {
    select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) => requestUi<string>("select", { title, options }, opts),
    confirm: async (title: string, message: string, opts?: ExtensionUIDialogOptions) => (await requestUi<boolean>("confirm", { title, message }, opts)) ?? false,
    input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) => requestUi<string>("input", { title, placeholder }, opts),
    editor: (title: string, prefill?: string) => requestUi<string>("editor", { title, prefill }),
    notify: (message: string, type = "info") => emitPi({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notificationType: type }),
    setStatus: (key: string, text?: string) => emitPi({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text }),
    setTitle: (title: string) => emitPi({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title }),
    setEditorText: (text: string) => emitPi({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text }),
    pasteToEditor: (text: string) => emitPi({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text }),
    getEditorText: () => "",
    onTerminalInput: () => () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    custom: async () => undefined,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is managed by the desktop application" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined
  };
  return ui as unknown as ExtensionUIContext;
}

async function stopPi(): Promise<void> {
  unsubscribePi?.();
  unsubscribePi = undefined;
  if (piSession) {
    if (!piSession.isIdle) await piSession.abort();
    piSession.dispose();
    piSession = undefined;
  }
  for (const resolve of pendingUi.values()) resolve({ cancelled: true });
  pendingUi.clear();
}

async function startPi(taskId: string): Promise<void> {
  await stopPi();
  const task = store.getTask(taskId);
  if (!task) throw new Error("Task not found");
  activeTaskId = taskId;
  store.setSetting("activeTaskId", taskId);
  const repo = store.listTaskRepositories(taskId)[0];
  const cwd = repo?.worktreePath ?? repo?.localPath ?? process.cwd();
  const agentDir = store.getSetting("piAgentDir") ?? getAgentDir();
  const sessionDir = join(dataDir, "pi-sessions");
  const sessionManager = task.piSessionPath
    ? SessionManager.open(task.piSessionPath, sessionDir, cwd)
    : SessionManager.create(cwd, sessionDir);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const extension = join(__dirname, "../../../packages/pi-package/dist/index.js");
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [extension] });
  await resourceLoader.reload({ resolveProjectTrust: async () => {
    if (!hasTrustRequiringProjectResources(cwd)) return true;
    const trustStore = new ProjectTrustStore(agentDir);
    const saved = trustStore.get(cwd);
    if (saved !== null) return saved;
    const choice = await requestUi<string>("select", {
      title: "信任项目配置",
      options: ["信任并记住", "仅本次信任", "不信任"],
      message: `仓库 ${cwd} 包含项目级 Pi Extension、Skill 或配置。仅信任你确认过的代码仓库。`
    });
    if (choice === "信任并记住") { trustStore.set(cwd, true); return true; }
    return choice === "仅本次信任";
  } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const modelRaw = store.getSetting("modelProfile");
  if (modelRaw) {
    const profile = JSON.parse(modelRaw) as ModelProfile;
    const localKey = keyStore.resolve(store.getSetting("modelApiKey"), "modelApiKey");
    const apiKey = (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined) ?? localKey;
    if (apiKey) await modelRuntime.setRuntimeApiKey(profile.provider ?? "company-openai", apiKey);
  }
  const created = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager, settingsManager, modelRuntime });
  piSession = created.session;
  let session = piSession;
  await session.bindExtensions({
    uiContext: createGuiUI(),
    mode: "rpc",
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: (targetId, options) => session.navigateTree(targetId, options),
      switchSession: async () => ({ cancelled: true }),
      reload: () => session.reload()
    },
    abortHandler: () => { void session.abort(); },
    shutdownHandler: () => { void stopPi(); },
    onError: (error) => emitPi({ type: "extension_error", ...error })
  });
  unsubscribePi = session.subscribe(emitPi);
  store.updateTask(task.id, { piSessionPath: session.sessionFile });
  emitPi({ type: "session_ready", sessionId: session.sessionId, sessionFile: session.sessionFile, diagnostics: created.extensionsResult.errors });
}

async function startTask(taskId: string): Promise<void> {
  const current = store.getTask(taskId);
  if (modelProvider() === "qoder" && current && ["draft", "failed"].includes(current.state)) store.updateTask(taskId, { sessionUsage: undefined });
  const task = await taskWorkflow.prepare(taskId);
  if (modelProvider() === "qoder") {
    void runQoder(taskId).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  await startPi(taskId);
  if (!piSession) throw new Error("OpenAI agent session is unavailable");
  await piSession.prompt(`${task.title}\n\n${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`, { source: "rpc" });
}

async function sendTaskMessage(taskId: string, message: string): Promise<void> {
  let task = store.getTask(taskId);
  if (!task || !["awaiting_review", "reviewing", "review_blocked", "awaiting_commit", "await_merge"].includes(task.state)) throw new Error("只有 InReview 任务可以继续 AI 对话");
  task = updateState(task, "implementing");
  store.updateTask(task.id, { reviewStatus: "pending" });
  addTaskEvent({ taskId, kind: "message", title: "你", detail: message });
  if (modelProvider() === "qoder") {
    void runQoder(taskId, message).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (!piSession || activeTaskId !== taskId) await startPi(taskId);
  await piSession!.prompt(message, { source: "rpc", ...(piSession!.isStreaming ? { streamingBehavior: "followUp" as const } : {}) });
}

async function deleteTask(taskId: string): Promise<void> {
  const task = store.getTask(taskId);
  if (!task || !["draft", "completed", "cancelled"].includes(task.state)) throw new Error("只有 Todo 或 Done 任务可以移除");
  if (activeTaskId === taskId && (activeQoderQuery || piSession?.isStreaming)) throw new Error("任务仍在执行,无法删除");
  const git = gitService;
  for (const repo of store.listTaskRepositories(taskId)) {
    if (!repo.worktreePath) continue;
    try { await git.removeWorktree(repo.localPath, repo.worktreePath); }
    catch {
      rmSync(repo.worktreePath, { recursive: true, force: true });
      try { await git.pruneWorktrees(repo.localPath); } catch { /* The source repository may no longer exist. */ }
    }
  }
  rmSync(taskWorkspace(taskId), { recursive: true, force: true });
  rmSync(join(dataDir, "worktrees", taskId), { recursive: true, force: true });
  store.deleteTask(taskId);
  if (activeTaskId === taskId) activeTaskId = undefined;
}

async function taskChangedFiles(taskId: string): Promise<Array<{ repositoryId: string; repositoryName: string; path: string; status: string }>> {
  const git = gitService;
  const groups = await Promise.all(store.listTaskRepositories(taskId).map(async (repo) => {
    try {
      const files = await git.changedFiles(repo.worktreePath ?? repo.localPath, repo.baseBranch);
      return files.map((file) => ({ repositoryId: repo.repositoryId, repositoryName: repo.name, ...file }));
    } catch { return []; }
  }));
  return groups.flat();
}

async function openEditorForTask(taskId: string, editor: "vscode" | "qoder"): Promise<void> {
  if (!(["vscode", "qoder"] as const).includes(editor)) throw new Error("不支持的编辑器");
  const paths = store.listTaskRepositories(taskId).map((repo) => repo.worktreePath ?? repo.localPath);
  await openTaskEditor(editor, paths);
}

async function* holdQoderProbe(signal: AbortSignal): AsyncGenerator<never> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function getQoderStatus(): Promise<QoderStatus> {
  const token = protectedValue("qoderToken");
  if (modelProvider() !== "qoder" || !token) return { enabled: false, connected: false, running: false, models: [] };
  const probeAbort = activeQoderQuery ? undefined : new AbortController();
  const q = activeQoderQuery ?? query({
    prompt: holdQoderProbe(probeAbort!.signal),
    options: { auth: accessToken(token), cwd: process.cwd(), abortController: probeAbort, persistSession: false, controlRequestTimeoutMs: 15_000 }
  });
  try {
    const initialization = await q.initializationResult();
    const usage = await q.getUsageInfo();
    let models = initialization.models;
    try { models = await q.getAvailableModels({ fetchStrategy: "cache" }); } catch { /* Initialization models are a valid fallback for older runtimes. */ }
    return {
      enabled: true, connected: true, running: Boolean(activeQoderQuery),
      account: initialization.account, usage,
      models: models.filter((model) => model.isEnabled !== false).map(({ value, displayName, description, isDefault, isEnabled, isReasoning, isVl, priceFactor }) => ({ value, displayName, description, isDefault, isEnabled, isReasoning, isVl, priceFactor }))
    };
  } catch (error) {
    return { enabled: true, connected: false, running: Boolean(activeQoderQuery), models: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (probeAbort) { probeAbort.abort(); try { await q.close(); } catch { /* The probe may already be closed after an initialization failure. */ } }
  }
}

// === IPC 路由(全部保留) =======================================================

function registerIpc(): void {
  ipcMain.handle("tasks:list", async () => { await mergeRefresher.refresh(); return store.listCards(); });
  ipcMain.handle("tasks:get", async (_event, id: string) => { await mergeRefresher.refresh(); return { task: store.getTask(id), repositories: store.listTaskRepositories(id), events: store.listEvents(id), approvals: store.listApprovals(id), changedFiles: await taskChangedFiles(id) }; });
  ipcMain.handle("tasks:create", (_event, input: Pick<Task, "title" | "description"> & Partial<Pick<Task, "keywords" | "acceptanceCriteria">>) => store.createTask(input));
  ipcMain.handle("tasks:update", (_event, id: string, patch: Record<string, unknown>) => store.updateTask(id, patch));
  ipcMain.handle("tasks:delete", (_event, id: string) => deleteTask(id));
  ipcMain.handle("repos:list", () => store.listRepositoryProfiles());
  ipcMain.handle("repos:save", (_event, profile) => store.saveRepositoryProfile(profile));
  ipcMain.handle("repos:delete", (_event, id: string) => store.deleteRepositoryProfile(id));
  ipcMain.handle("repos:choose-folder", async () => {
    const localPath = (await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory"] })).filePaths[0];
    if (!localPath) return undefined;
    try {
      const info = await gitService.inspectRepository(localPath);
      return { name: basename(info.rootPath), localPath: info.rootPath, remoteUrl: info.remoteUrl, defaultBranch: info.currentBranch };
    } catch { throw new Error("仓库异常:所选目录不是有效的 Git 仓库,或当前未检出分支"); }
  });
  ipcMain.handle("tasks:attach-repo", (_event, taskId: string, repositoryId: string) => store.attachRepository(taskId, repositoryId));
  ipcMain.handle("tasks:detach-repo", (_event, taskId: string, repositoryId: string) => store.detachRepository(taskId, repositoryId));
  ipcMain.handle("settings:get", (_event, key: string) => ["jiraToken", "confluenceToken", "qoderToken", "modelApiKey", "gitlabToken"].includes(key) ? (store.getSetting(key) ? "__configured__" : undefined) : store.getSetting(key));
  ipcMain.handle("settings:set", (_event, key: string, value: string, secret = false) => {
    store.setSetting(key, secret ? keyStore.protect(value, key) : value);
    if (key === "modelProfile") syncPiModelConfig(value);
  });
  ipcMain.handle("tasks:start", (_event, taskId: string) => startTask(taskId));
  ipcMain.handle("tasks:message", (_event, taskId: string, message: string) => sendTaskMessage(taskId, message));
  ipcMain.handle("tasks:abort", async () => { const task = activeTaskId ? store.getTask(activeTaskId) : undefined; if (task?.state === "implementing") updateState(task, "failed"); activeQoderAbort?.abort(); await activeQoderQuery?.interrupt(); await piSession?.abort(); });
  ipcMain.handle("tasks:review", (_event, taskId: string) => taskWorkflow.runReview(taskId, buildReviewOrchestrator()));
  ipcMain.handle("tasks:reset-review", (_event, taskId: string) => taskWorkflow.resetReview(taskId));
  ipcMain.handle("tasks:reset-delivery", (_event, taskId: string) => deliveryService.resetDelivery(taskId));
  ipcMain.handle("tasks:submit-mrs", (_event, taskId: string) => deliveryService.submitMergeRequests(taskId));
  ipcMain.handle("tasks:refresh-merge-status", () => mergeRefresher.refresh());
  ipcMain.handle("tasks:manual-complete", (_event, taskId: string) => taskCompleter.manualComplete(taskId));
  ipcMain.handle("tasks:open-editor", (_event, taskId: string, editor: "vscode" | "qoder") => openEditorForTask(taskId, editor));
  ipcMain.handle("qoder:status", () => getQoderStatus());
  // 用系统默认浏览器打开 URL(避免在 Electron 内嵌窗口中 target=_blank 开新 BrowserWindow)。
  // 只放行 http(s),防止被注入 file:// / 命令协议等本地 scheme。
  ipcMain.handle("shell:open-external", async (_event, url: string) => {
    if (typeof url !== "string") throw new Error("url 必须是字符串");
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("无效的 URL"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("仅支持 http(s) 链接");
    await shell.openExternal(parsed.toString());
  });
  ipcMain.handle("jira:import", async (_event, keyOrUrl: string) => importJiraIssue(atlassianFactory.create("jira"), keyOrUrl, store));
  ipcMain.handle("jira:sync", async () => syncJiraTasks(atlassianFactory.create("jira"), store));
  ipcMain.handle("jira:import-many", (_event, candidates: Array<Record<string, unknown>>) => candidates.flatMap((candidate) => {
    const jiraKey = typeof candidate.jiraKey === "string" ? candidate.jiraKey.trim().toUpperCase() : "";
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (!jiraKey || !title) return [];
    return [store.upsertJiraTask({ jiraKey, title, description: typeof candidate.description === "string" ? candidate.description : "", keywords: Array.isArray(candidate.keywords) ? candidate.keywords.map(String) : [], acceptanceCriteria: Array.isArray(candidate.acceptanceCriteria) ? candidate.acceptanceCriteria.map(String) : [], state: "draft", reviewStatus: "pending" })];
  }));
  ipcMain.handle("atlassian:test", async (_event, kind: "jira" | "confluence") => testAtlassianConnection(atlassianFactory.create(kind)));
  ipcMain.handle("task:ui-response", (_event, response: Record<string, unknown>) => pendingUi.get(String(response.id))?.(response));
  // === Chat 对话(Codex 样式) =================================================
  ipcMain.handle("chats:list", () => chatService.listChats());
  ipcMain.handle("chats:get", (_event, id: string) => chatService.getChat(id));
  ipcMain.handle("chats:create", (_event, model?: string) => chatService.createChat(model));
  ipcMain.handle("chats:delete", (_event, id: string) => chatService.deleteChat(id));
  ipcMain.handle("chats:list-models", () => chatService.listModels());
  ipcMain.handle("chats:start-stream", (_event, input) => {
    void chatService.startChatStream(input).catch((reason) => console.error("[chat] stream failed", reason));
  });
  ipcMain.handle("chats:abort", (_event, input) => chatService.abortChat(input));
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 640, backgroundColor: "#111210",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
  if (process.env.VITE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(join(__dirname, "../dist/index.html"));
}

app.whenReady().then(() => {
  if (!resolveBundledOcrBinary()) {
    console.warn("[ocr] @alibaba-group/open-code-review not found in node_modules; reviews will fall back to PATH lookup and may fail in packaged builds.");
  }
  registerIpc();
  void createWindow();
  const mergeTimer = setInterval(() => { void mergeRefresher.refresh(); }, 60_000);
  mergeTimer.unref();
  app.on("browser-window-focus", () => { void mergeRefresher.refresh(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { void stopPi(); store.close(); });
