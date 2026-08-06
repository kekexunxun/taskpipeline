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
import { TaskStore, LocalFileKeyStore, boardColumnFor, transitionTask, type AgentEvent, type Memory, type SessionUsage, type SettingResolver, type Task, type TaskEventSink, type TaskRepository, type TaskStartMode, type TaskState } from "@coding-agent/core";
import {
  AtlassianClientFactory, DeliveryService, fetchJiraTasks, GitService, importJiraIssue, MergeStatusRefresher, openTaskEditor, OpenCodeReviewService,
  OpenAICompatReviewer, parseGitLabRemote, redactSecrets,
  ReviewOrchestrator, TaskCompleter, TaskWorkflow, testAtlassianConnection, asReviewer, type RepositoryCommandMap
} from "@coding-agent/integrations";
import { resolveBundledOcrBinary, resolveOcrBinary, createOcrRunner } from "./ocr.js";
import { accessToken, query, type AccountInfo, type ModelInfo, type Query, type SDKMessage, type UsageInfo } from "@qoder-ai/qoder-agent-sdk";
import { parsePlanDecision, sdkResultText } from "./plan-content.js";
import { ChatService } from "./chat/chat-service.js";
import { JiraTaskCreationBackend } from "./chat/task-backends/jira.js";
import { resolveChatModel, type ResolvedChatModel } from "./chat/chat-models.js";
import type { ChatConversation } from "./chat/chat-types.js";
import { MemoryService, renderMemoryContext } from "./memory/memory-service.js";
import { extractMemories } from "./memory/memory-extractor.js";
import { implementationOutcomeInstruction, isExplicitNoChangeCompletionRequest, nextStepForImplementation, nextStepForPlan, parseImplementationDecision } from "./task-readiness.js";

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
const memoryService = new MemoryService(store);
let activeTaskId: string | undefined;
let activeQoderQuery: Query | undefined;
let activeQoderAbort: AbortController | undefined;
let activePlanningTaskId: string | undefined;
let activePlanText = "";
type ActiveTaskOperation = { controller: AbortController; promise: Promise<unknown> };
const activeTaskOperations = new Map<string, ActiveTaskOperation>();

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
  planning: "计划中", awaiting_plan_approval: "等待计划确认", awaiting_input: "等待补充", generating_tests: "生成测试用例中", validating: "校验中", validation_failed: "校验失败",
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

// 把 Atlassian MCP 调用失败包装成"操作名 + 原因"的中文错误，渲染端会直接展示这条消息。
// 原始堆栈写到主进程日志，便于排查；避免把 "MCP request timeout: initialize" 这种无操作意义的
// 内部消息直接给到用户。
async function safeAtlassianCall<T>(action: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[atlassian] ${action} failed:`, error);
    throw new Error(`${action}失败：${reason}`);
  }
}

function runTaskOperation<T>(taskId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  activeTaskOperations.get(taskId)?.controller.abort(new Error("新的任务操作已开始"));
  const controller = new AbortController();
  const promise = Promise.resolve().then(() => action(controller.signal));
  const operation: ActiveTaskOperation = { controller, promise };
  activeTaskOperations.set(taskId, operation);
  void promise.finally(() => {
    if (activeTaskOperations.get(taskId) === operation) activeTaskOperations.delete(taskId);
  }).catch(() => undefined);
  return promise;
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
const chatService = new ChatService(store, dataDir, getQoderStatus, () => protectedValue("qoderToken"), () => protectedValue("modelApiKey"), () => mainWindow, () => {
  // 任务创建 Agent：按 system setting 选 backend；目前仅 Jira 后端可用。
  // 未来接入 GitHub / Linear 时这里按 backendId 分发。
  if (resolveDefaultBackend() === "jira") return new JiraTaskCreationBackend(atlassianFactory);
  return undefined;
}, async ({ conversationId, query }) => memoryService.buildSystemPrompt({ userId: memoryService.ensureUserId(), conversationId, query }), async ({ conversation, model }) => consolidateChatMemory(conversation, model));

// === Review 实现(Qoder / OpenAI 兼容) =========================================

async function callQoderReviewer(prompt: string, taskId: string, model?: string, signal?: AbortSignal): Promise<string> {
  const token = protectedValue("qoderToken");
  if (!token) throw new Error("请先配置 Qoder Token");
  const abort = new AbortController();
  const abortFromTask = () => abort.abort(signal?.reason);
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abortFromTask, { once: true });
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
    signal?.removeEventListener("abort", abortFromTask);
    if (timer) clearTimeout(timer);
    if (!abort.signal.aborted) abort.abort();
    try { await q.close(); } catch { /* ignore */ }
  }
}

function callQoderOrOpenAIReviewer(input: Parameters<OpenAICompatReviewer["call"]>[0], taskId: string, model?: string, signal?: AbortSignal): Promise<string> {
  if (modelProvider() === "qoder") return callQoderReviewer(buildReviewPromptForQoder(input), taskId, model, signal);
  return openAIReviewer.call(input, taskId, model, signal);
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
  if (message.type === "result") return sdkResultText(record.result, record.errors);
  if (message.type !== "assistant") return undefined;
  const content = record.message?.content;
  if (!Array.isArray(content)) return undefined;
  return content.filter((item: any) => item?.type === "text").map((item: any) => item.text).filter(Boolean).join("\n") || undefined;
}

async function savePlanDecision(taskId: string, texts: string[]): Promise<Task> {
  const decision = parsePlanDecision(texts);
  if (decision.outcome === "changes_required") return taskWorkflow.setPlan(taskId, decision.content);

  let changedFiles: Awaited<ReturnType<typeof taskChangedFiles>>;
  try {
    changedFiles = await taskChangedFiles(taskId, false);
  } catch (error) {
    const pending = taskWorkflow.setPlan(taskId, [
      "## 需要人工确认",
      "",
      "Agent 判断当前代码已满足任务要求，但系统无法确认工作区是否存在文件变化，因此任务未自动完成。",
      "",
      decision.content
    ].join("\n"));
    store.updateTask(taskId, { summary: "无法确认文件状态，等待计划确认" });
    addTaskEvent({
      taskId,
      kind: "error",
      title: "无法确认计划阶段的文件改动",
      detail: error instanceof Error ? error.message : String(error)
    });
    return pending;
  }

  if (nextStepForPlan(decision.outcome, changedFiles.length) === "complete_without_changes") {
    return taskWorkflow.completeWithoutChanges(taskId, decision.content);
  }

  const changedList = changedFiles.map((file) => `- ${file.repositoryName}: ${file.path} (${file.status})`).join("\n");
  const pending = taskWorkflow.setPlan(taskId, [
    "## 需要人工确认",
    "",
    `Agent 判断当前代码已满足任务要求，但系统检测到 ${changedFiles.length} 个文件变化，因此任务未自动完成。`,
    "",
    decision.content,
    "",
    "## 检测到的文件变化",
    "",
    changedList
  ].join("\n"));
  store.updateTask(taskId, { summary: "计划结论与文件变化不一致，等待确认" });
  addTaskEvent({
    taskId,
    kind: "status",
    title: "计划结论与文件变化不一致",
    detail: `Agent 返回无需修改，但系统检测到 ${changedFiles.length} 个文件变化，任务不会自动完成。`
  });
  return pending;
}

function recordQoderMessage(taskId: string, message: SDKMessage, recordText = true): void {
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
  if (text && recordText) addTaskEvent({ taskId, kind: "message", title: "Qoder Agent", detail: text });
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

async function runQoder(taskId: string, extraPrompt?: string, signal?: AbortSignal, resumeSessionId?: string): Promise<void> {
  const task = await taskWorkflow.prepare(taskId, signal);
  const token = protectedValue("qoderToken");
  if (!token) throw new Error("请先配置 Qoder Token");
  const repos = store.listTaskRepositories(task.id);
  if (repos.length === 0) throw new Error("任务未关联代码仓库");
  activeTaskId = task.id;
  addTaskEvent({ taskId, kind: "status", title: "执行环境:Qoder Agent SDK", detail: "使用应用随附运行时,并在已配置仓库目录中执行" });
  activeQoderAbort?.abort();
  const qoderAbort = new AbortController();
  activeQoderAbort = qoderAbort;
  const abortFromTask = () => qoderAbort.abort(signal?.reason);
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abortFromTask, { once: true });
  const memoryContext = await taskMemoryContext(task, repos);
  // 续接执行时按 session_id 恢复原会话：不再重复注入完整任务上下文，避免上下文错乱，
  // 直接把"继续指令"作为新消息追加到历史会话里。
  const prompt = resumeSessionId
    ? (extraPrompt ?? "任务此前执行失败/中断，请基于当前会话上下文继续完成剩余工作。")
    : [
      memoryContext ?? "",
      task.title,
      task.description,
      task.planContent ? `Approved implementation plan:\n${task.planContent}` : "",
      `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      extraPrompt ? `Additional request:\n${extraPrompt}` : "",
      implementationOutcomeInstruction
    ].filter(Boolean).join("\n\n");
  const q = query({ prompt, options: { auth: accessToken(token), cwd: repos[0]!.worktreePath ?? repos[0]!.localPath, additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath), abortController: qoderAbort, includePartialMessages: true, permissionMode: "acceptEdits", persistSession: true, ...(resumeSessionId ? { resume: resumeSessionId } : {}), ...(task.qoderModel ? { model: task.qoderModel } : {}) } });
  activeQoderQuery = q;
  emitPi({ type: "agent_start", provider: "qoder", taskId, phase: "implementation" });
  const logFile = qoderLogFile(task.id);
  const responseTexts: string[] = [];
  // 从消息流捕获本次会话的 session_id，持久化供失败后续接按 ID 恢复。
  let currentSessionId: string | undefined = resumeSessionId;
  if (logFile) {
    try {
      appendFileSync(logFile, JSON.stringify({
        t: new Date().toISOString(), kind: "meta", taskId: task.id, prompt,
        options: { cwd: repos[0]!.worktreePath ?? repos[0]!.localPath, model: task.qoderModel, additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath), resume: resumeSessionId }
      }) + "\n", "utf8");
    } catch { /* 忽略 */ }
  }
  try {
    for await (const message of q) {
      logQoderMessage(logFile, message);
      const sid = (message as { session_id?: string }).session_id;
      if (sid) currentSessionId = sid;
      const text = qoderText(message);
      if ((message.type === "assistant" || message.type === "result") && text) responseTexts.push(text);
      recordQoderMessage(task.id, message);
    }
    await finishImplementation(task.id, responseTexts, signal);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    addTaskEvent({ taskId, kind: "error", title: "Qoder 执行失败", detail });
    const current = store.getTask(task.id);
    if (["implementing", "validating"].includes(current?.state ?? "")) updateState(current!, "failed");
    emitPi({ type: "agent_error", taskId, message: detail });
  } finally {
    if (currentSessionId) store.updateTask(task.id, { qoderSessionId: currentSessionId });
    signal?.removeEventListener("abort", abortFromTask);
    activeQoderQuery = undefined;
    activeQoderAbort = undefined;
    emitPi({ type: "agent_end", provider: "qoder", taskId, phase: "implementation" });
  }
}

const TEST_CASE_GENERATION_PROMPT = [
  "你是一个测试用例生成 Agent，专为当前 Coding 任务生成最小测试集。",
  "硬性约束：",
  "1. 不得修改任何业务逻辑文件、不得重构、不得调整非测试相关的配置。",
  "2. 仅为本次改动产出可被现有 testCommand 跑通的最小测试集（单元测试为主，必要时一个集成测试）。",
  "3. 若现有 testCommand 不存在或无法识别测试文件，请按仓库常见约定新增。",
  "4. 所有新增文件必须以 _test.* / .test.* / .spec.* 结尾，并放到合理的测试目录。",
  "5. 完成后请把测试相关的修改 commit 到当前 feature 分支（一个 commit 即可），commit message 形如 `test: <简短说明>`。",
  "",
  "请在最后输出一个 JSON 对象（不要输出额外说明）：",
  "{\"files\":[\"path/to/test1\", \"path/to/test2\"], \"commitSha\":\"<短 sha 或全 sha>\", \"summary\":\"<一句话概述>\"}",
  "若没有任何可测试的逻辑面，输出 {\"files\":[], \"summary\":\"<解释原因>\"}。"
].join("\n");

type TestCaseGenerationResult = { files: string[]; commitSha?: string; summary: string };

function parseTestCaseGeneration(texts: string[]): TestCaseGenerationResult {
  for (const text of [...texts].reverse()) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as { files?: unknown; commitSha?: unknown; summary?: unknown };
      const files = Array.isArray(value.files) ? value.files.filter((item): item is string => typeof item === "string") : [];
      const summary = typeof value.summary === "string" ? value.summary : "";
      return { files, commitSha: typeof value.commitSha === "string" ? value.commitSha : undefined, summary };
    } catch { /* fallthrough */ }
  }
  return { files: [], summary: "Agent 未返回有效测试用例 JSON" };
}

async function runQoderTestCases(taskId: string, signal?: AbortSignal): Promise<TestCaseGenerationResult> {
  const task = store.getTask(taskId);
  const token = protectedValue("qoderToken");
  if (!task || task.state !== "generating_tests") throw new Error("当前任务不能生成测试用例");
  if (!token) throw new Error("请先配置 Qoder Token");
  const repos = store.listTaskRepositories(task.id);
  if (repos.length === 0) throw new Error("任务未关联代码仓库");
  activeTaskId = task.id;
  addTaskEvent({ taskId, kind: "status", title: "正在生成测试用例" });
  // 复用实现阶段的 query 资源管理：先关闭上一轮（避免与即将启动的 runValidation 抢资源）。
  activeQoderAbort?.abort();
  const qoderAbort = new AbortController();
  activeQoderAbort = qoderAbort;
  const abortFromTask = () => qoderAbort.abort(signal?.reason);
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abortFromTask, { once: true });
  const prompt = [
    task.title,
    task.description,
    task.planContent ? `Approved implementation plan:\n${task.planContent}` : "",
    TEST_CASE_GENERATION_PROMPT
  ].filter(Boolean).join("\n\n");
  const q = query({
    prompt,
    options: {
      auth: accessToken(token),
      cwd: repos[0]!.worktreePath ?? repos[0]!.localPath,
      additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath),
      abortController: qoderAbort,
      includePartialMessages: true,
      permissionMode: "acceptEdits",
      persistSession: true,
      ...(task.qoderModel ? { model: task.qoderModel } : {})
    }
  });
  activeQoderQuery = q;
  emitPi({ type: "agent_start", provider: "qoder", taskId, phase: "test_generation" });
  const logFile = qoderLogFile(task.id);
  const responseTexts: string[] = [];
  try {
    for await (const message of q) {
      logQoderMessage(logFile, message);
      const text = qoderText(message);
      if ((message.type === "assistant" || message.type === "result") && text) responseTexts.push(text);
      recordQoderMessage(task.id, message);
    }
    return parseTestCaseGeneration(responseTexts);
  } finally {
    signal?.removeEventListener("abort", abortFromTask);
    activeQoderQuery = undefined;
    activeQoderAbort = undefined;
    emitPi({ type: "agent_end", provider: "qoder", taskId, phase: "test_generation" });
  }
}

async function runQoderPlan(taskId: string, feedback?: string, signal?: AbortSignal): Promise<void> {
  const task = store.getTask(taskId);
  const token = protectedValue("qoderToken");
  if (!task || task.state !== "planning") throw new Error("当前任务不能生成计划");
  if (!token) throw new Error("请先配置 Qoder Token");
  const repos = store.listTaskRepositories(task.id);
  if (repos.length === 0) throw new Error("任务未关联代码仓库");

  // === 二次执行计划卡死的关键修复 ============================
  // 1) 把上一个 activeQoderQuery 立即释放（最多等 5s），避免 SDK 内部残留会话；
  // 2) 上一轮的 AbortController 先 abort，保证旧 for-await 能退出；
  // 3) 新 AbortController 在旧资源完全释放后再替换 activeQoderAbort。
  // 否则第二次 runQoderPlan 进入 for-await 之后，新旧两路 stream 同时打 recordQoderMessage，
  // 且 finally 里的 close 会无限阻塞，导致任务一直停在"计划中"。
  const previousQuery = activeQoderQuery;
  const previousAbort = activeQoderAbort;
  activeQoderQuery = undefined;
  activeQoderAbort = undefined;
  previousAbort?.abort();
  if (previousQuery) {
    try { await previousQuery.interrupt(); } catch { /* may already be closed */ }
    await closeQoderQuerySafely(previousQuery, 5_000);
  }
  // ============================================================

  activeTaskId = task.id;
  activePlanningTaskId = task.id;
  activePlanText = "";
  const memoryContext = await taskMemoryContext(task, repos);
  const prompt = [memoryContext ?? "", `请只读分析以下 Coding 任务。`, `任务：${task.title}`, task.description, `验收标准：\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`, feedback ? `上一次计划的调整意见：\n${feedback}` : "", "禁止修改文件，禁止执行安装、构建或其他会改变工作区的命令。", "最终只输出一个 JSON 对象，不要输出过程说明或 Markdown 代码块。若代码已满足要求，输出 {\"outcome\":\"already_satisfied\",\"summary\":\"判断依据和验证建议\"}；否则输出 {\"outcome\":\"changes_required\",\"plan\":\"完整实施计划，包含涉及文件、实施步骤、验证方式和风险\"}。"].filter(Boolean).join("\n\n");
  const abort = new AbortController();
  const abortFromTask = () => abort.abort(signal?.reason);
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abortFromTask, { once: true });
  activeQoderAbort = abort;
  const q = query({ prompt, options: { auth: accessToken(token), cwd: repos[0]!.worktreePath ?? repos[0]!.localPath, additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath), abortController: abort, includePartialMessages: true, permissionMode: "plan", persistSession: true, ...(task.qoderModel ? { model: task.qoderModel } : {}) } });
  activeQoderQuery = q;
  emitPi({ type: "agent_start", provider: "qoder", taskId, phase: "planning" });
  const planMessages: string[] = [];
  // 5 分钟硬超时：避免再次出现"永不返回"卡死。即便 SDK 真的泄漏，UI 也能在 5min 内看到 failed。
  const HARD_TIMEOUT_MS = 5 * 60 * 1000;
  let hardTimer: NodeJS.Timeout | undefined;
  const hardTimeout = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => reject(new Error("计划生成超时(>5min)，已强制中止当前 query")), HARD_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      (async () => {
        for await (const message of q) {
          recordQoderMessage(task.id, message, false);
          const text = qoderText(message);
          if ((message.type === "assistant" || message.type === "result") && text) planMessages.push(text);
        }
        await savePlanDecision(taskId, planMessages);
      })(),
      hardTimeout
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    addTaskEvent({ taskId, kind: "error", title: "计划生成失败", detail });
    abort.abort();
    await closeQoderQuerySafely(q, 5_000);
    const current = store.getTask(taskId);
    if (current?.state === "planning") {
      store.updateTask(taskId, { failureStage: "planning" });
      updateState(current, "failed");
    }
    throw error;
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    signal?.removeEventListener("abort", abortFromTask);
    if (activeQoderQuery === q) activeQoderQuery = undefined;
    if (activeQoderAbort === abort) activeQoderAbort = undefined;
    activePlanningTaskId = undefined;
    emitPi({ type: "agent_end", provider: "qoder", taskId, phase: "planning" });
  }
}

async function advanceAfterValidation(taskId: string, state: TaskState, signal?: AbortSignal): Promise<void> {
  if (state !== "awaiting_review") return;
  signal?.throwIfAborted();
  const task = store.getTask(taskId);
  // 任务级覆盖优先于系统级设置。
  if (taskWorkflow.isReviewEnabledFor(task)) {
    await taskWorkflow.runReview(taskId, buildReviewOrchestrator(), signal);
  } else {
    store.updateTask(taskId, { reviewStatus: "waived" });
    updateState(store.getTask(taskId)!, "awaiting_commit");
    addTaskEvent({ taskId, kind: "status", title: "已跳过 Review,等待提交 MR" });
  }
  const updated = store.getTask(taskId);
  if (updated?.state === "awaiting_commit" && taskWorkflow.shouldAutoCreateMergeRequestsFor(updated)) {
    await deliveryService.submitMergeRequests(taskId, signal);
  }
}

async function finishImplementation(taskId: string, responseTexts: string[], signal?: AbortSignal): Promise<void> {
  const task = store.getTask(taskId);
  if (!task || task.state !== "implementing") return;
  const decision = parseImplementationDecision(responseTexts);
  if (decision.outcome === "needs_input") {
    taskWorkflow.awaitInput(taskId, decision.content || "Agent 表示当前信息不足或实现尚未完成，请补充后继续。");
    return;
  }
  // 实现已结束（成功 / 结论待确认等），异步整理任务执行记录为记忆，不阻塞后续校验流程。
  void consolidateTaskMemory(taskId, responseTexts);
  let changedFiles: Awaited<ReturnType<typeof taskChangedFiles>>;
  try {
    changedFiles = await taskChangedFiles(taskId, false);
  } catch (error) {
    addTaskEvent({
      taskId,
      kind: "error",
      title: "无法确认文件改动",
      detail: `${error instanceof Error ? error.message : String(error)}\n任务不会自动进入校验、Review 或完成状态。`
    });
    return;
  }
  const nextStep = nextStepForImplementation(decision.outcome, changedFiles.length);
  if (nextStep === "complete_without_changes") {
    taskWorkflow.completeImplementationWithoutChanges(taskId, decision.content || "Agent 已确认当前仓库满足任务要求。无需修改代码。");
    return;
  }
  if (nextStep === "await_confirmation") {
    addTaskEvent({
      taskId,
      kind: "status",
      title: "等待确认执行结果",
      detail: decision.outcome === "unknown"
        ? "Agent 未明确说明实现是否完成，任务不会自动进入校验或 Review。"
        : "Agent 结论与文件改动状态不一致，任务不会自动推进。"
    });
    return;
  }
  // 若任务级/系统级开关打开，则在实现完成后、runValidation 之前先生成测试用例。
  if (taskWorkflow.shouldGenerateTestCases(task)) {
    await runTestCaseGenerationThenValidate(taskId, signal);
    return;
  }
  const validated = await taskWorkflow.runValidation(taskId, signal);
  await advanceAfterValidation(taskId, validated.state, signal);
}

async function runTestCaseGenerationThenValidate(taskId: string, signal?: AbortSignal): Promise<void> {
  try {
    taskWorkflow.beginTestCaseGeneration(taskId);
    const result = await runQoderTestCases(taskId, signal);
    taskWorkflow.finishTestCaseGeneration(taskId, result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    addTaskEvent({ taskId, kind: "error", title: "测试用例生成失败", detail });
    // 回退到 implementing 让用户可以重试，而不是直接失败整个任务。
    const current = store.getTask(taskId);
    if (current?.state === "generating_tests") updateState(current, "implementing");
    return;
  }
  const validated = await taskWorkflow.runValidation(taskId, signal);
  await advanceAfterValidation(taskId, validated.state, signal);
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
  if (activePlanningTaskId && record.type === "message_update") {
    const update = record.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (update?.type === "text_delta" && update.delta) activePlanText += update.delta;
  }
  if (activePlanningTaskId) record.phase = "planning";
  if (activeTaskId && modelProvider() === "openai" && ["message_end", "agent_end"].includes(String(record.type))) updatePiUsage(activeTaskId);
  if (activeTaskId && record.type === "tool_execution_end") emitTaskChanged(activeTaskId);
  sendTaskEvent(typeof record.taskId === "string" || !activeTaskId ? record : { ...record, taskId: activeTaskId });
  if (record.type === "agent_end" && activeTaskId && !activePlanningTaskId && modelProvider() === "openai") {
    const taskId = activeTaskId;
    const responseTexts = Array.isArray(record.messages)
      ? record.messages.flatMap((message: any) => message?.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text)
        : [])
      : [];
    void runTaskOperation(taskId, (signal) => finishImplementation(taskId, responseTexts, signal)).catch((error) => emitPi({ type: "agent_error", message: error instanceof Error ? error.message : String(error) }));
  }
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

async function startTask(taskId: string, options: { mode?: TaskStartMode; repositoryCommands?: RepositoryCommandMap; useAllRepositories?: boolean } = {}): Promise<void> {
  const current = store.getTask(taskId);
  // 任务启动时可空选仓库：若 `useAllRepositories=true` 且任务当前没有 attach 任何仓库，
  // 先把 system 配的全部仓库 attach 上去，再走原来的 begin 路径。
  if (options.useAllRepositories && current) {
    const existing = store.listTaskRepositories(taskId);
    if (existing.length === 0) {
      const all = store.listRepositoryProfiles();
      for (const profile of all) {
        const exists = existing.find((repo) => repo.repositoryId === profile.id);
        if (!exists) store.attachRepository(taskId, profile.id);
      }
    }
  }
  if (modelProvider() === "qoder" && current && ["draft", "failed"].includes(current.state)) store.updateTask(taskId, { sessionUsage: undefined });
  const mode = options.mode ?? "direct";
  const task = await runTaskOperation(taskId, (signal) => taskWorkflow.begin(taskId, mode, options.repositoryCommands, signal));
  if (mode === "plan") {
    if (modelProvider() === "qoder") void runTaskOperation(taskId, (signal) => runQoderPlan(taskId, undefined, signal)).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
    else {
      await runTaskOperation(taskId, async (signal) => {
        signal.throwIfAborted();
        activePlanningTaskId = taskId;
        activePlanText = "";
        await startPi(taskId);
        const memoryContext = await taskMemoryContext(task, store.listTaskRepositories(taskId));
        await piSession!.prompt(`你处于只读计划模式。禁止修改文件、安装依赖或运行会改变工作区的命令。最终只输出 JSON：代码已满足要求时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n${memoryContext ? `${memoryContext}\n\n` : ""}${task.title}\n${task.description}`, { source: "rpc" });
        signal.throwIfAborted();
        const plan = activePlanText.trim();
        activePlanningTaskId = undefined;
        if (plan) await savePlanDecision(taskId, [plan]);
      });
    }
    return;
  }
  if (modelProvider() === "qoder") {
    void runTaskOperation(taskId, (signal) => runQoder(taskId, undefined, signal)).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted();
    await startPi(taskId);
    if (!piSession) throw new Error("OpenAI agent session is unavailable");
    const memoryContext = await taskMemoryContext(task, store.listTaskRepositories(taskId));
    await piSession.prompt(`${memoryContext ? `${memoryContext}\n\n` : ""}${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ""}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\n${implementationOutcomeInstruction}`, { source: "rpc" });
  });
}

/** 任务失败/中断后续接继续执行时,追加给 Agent 的指令:保留已完成改动,定位失败原因后继续。 */
const resumeImplementationInstruction =
  "任务此前执行失败/中断。请先检查当前工作区与代码状态（已完成的改动应保留），定位失败原因后继续完成剩余工作；不要重新执行已完成的部分，也不要重复安装依赖或重建环境。";

async function resumeTask(taskId: string): Promise<void> {
  const current = store.getTask(taskId);
  if (!current || current.state !== "failed") throw new Error("只有失败的任务可以继续执行");
  store.updateTask(taskId, { sessionUsage: undefined });
  // 计划阶段失败(计划尚未生成成功)时继续生成计划;其它失败继续实现流程。
  // `failureStage === "planning"` 由 runQoderPlan 失败路径标记;`startMode === "plan" && !planContent` 兼容历史存量数据。
  const failedDuringPlanning = current.failureStage === "planning" || (current.startMode === "plan" && !current.planContent);
  store.updateTask(taskId, { failureStage: undefined });
  if (failedDuringPlanning) {
    const task = await runTaskOperation(taskId, (signal) => taskWorkflow.begin(taskId, "plan", undefined, signal));
    if (modelProvider() === "qoder") {
      void runTaskOperation(taskId, (signal) => runQoderPlan(taskId, undefined, signal)).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    await runTaskOperation(taskId, async (signal) => {
      signal.throwIfAborted();
      activePlanningTaskId = taskId;
      activePlanText = "";
      await startPi(taskId);
      if (!piSession) throw new Error("OpenAI agent session is unavailable");
      const memoryContext = await taskMemoryContext(task, store.listTaskRepositories(taskId));
      await piSession.prompt(`你处于只读计划模式。禁止修改文件、安装依赖或运行会改变工作区的命令。最终只输出 JSON：代码已满足要求时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n${memoryContext ? `${memoryContext}\n\n` : ""}${task.title}\n${task.description}`, { source: "rpc" });
      signal.throwIfAborted();
      const plan = activePlanText.trim();
      activePlanningTaskId = undefined;
      if (plan) await savePlanDecision(taskId, [plan]);
    });
    return;
  }
  // 实现阶段失败:复用 prepare 的失败恢复路径(worktree 缺失时补建,已完整时直接回到 implementing,不重跑 setup 命令)。
  const task = await runTaskOperation(taskId, (signal) => taskWorkflow.prepare(taskId, signal));
  if (modelProvider() === "qoder") {
    void runTaskOperation(taskId, (signal) => runQoder(taskId, resumeImplementationInstruction, signal, task.qoderSessionId)).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted();
    await startPi(taskId);
    if (!piSession) throw new Error("OpenAI agent session is unavailable");
    const memoryContext = await taskMemoryContext(task, store.listTaskRepositories(taskId));
    await piSession.prompt(`${resumeImplementationInstruction}\n\n${memoryContext ? `${memoryContext}\n\n` : ""}${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ""}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\n${implementationOutcomeInstruction}`, { source: "rpc" });
  });
}

async function approveTaskPlan(taskId: string): Promise<void> {
  const before = store.getTask(taskId);
  if (!before?.planContent) throw new Error("当前任务没有可批准的计划");
  const approval = store.addApproval({ taskId, kind: "plan", context: before.planContent });
  store.resolveApproval(approval.id, "approved");
  const task = await runTaskOperation(taskId, (signal) => taskWorkflow.approvePlan(taskId, signal));
  if (modelProvider() === "qoder") {
    void runTaskOperation(taskId, (signal) => runQoder(taskId, undefined, signal)).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted();
    await startPi(taskId);
    const memoryContext = await taskMemoryContext(task, store.listTaskRepositories(taskId));
    await piSession!.prompt(`${memoryContext ? `${memoryContext}\n\n` : ""}${task.title}\n\n${task.description}\n\nApproved implementation plan:\n${task.planContent}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\n${implementationOutcomeInstruction}`, { source: "rpc" });
  });
}

async function reviseTaskPlan(taskId: string, feedback: string): Promise<void> {
  const task = taskWorkflow.revisePlan(taskId);
  addTaskEvent({ taskId, kind: "message", title: "计划调整意见", detail: feedback });
  if (modelProvider() === "qoder") {
    try {
      await runTaskOperation(taskId, (signal) => runQoderPlan(taskId, feedback, signal));
    } catch (error) {
      // 错误已在 runQoderPlan 内部写 event + 推 failed，这里只把消息转发给 UI 通道。
      emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted();
    activePlanningTaskId = taskId;
    activePlanText = "";
    await startPi(taskId);
    await piSession!.prompt(`你处于只读计划模式。根据调整意见重新判断，禁止修改文件。最终只输出 JSON：无需修改时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n任务：${task.title}\n${task.description}\n\n上一版计划：\n${task.planContent ?? ""}\n\n调整意见：\n${feedback}`, { source: "rpc" });
    signal.throwIfAborted();
    const plan = activePlanText.trim();
    activePlanningTaskId = undefined;
    if (!plan) throw new Error("Agent 未返回有效计划");
    await savePlanDecision(taskId, [plan]);
  });
}

async function retryTaskValidation(taskId: string): Promise<void> {
  await runTaskOperation(taskId, async (signal) => {
    const validated = await taskWorkflow.runValidation(taskId, signal);
    await advanceAfterValidation(taskId, validated.state, signal);
  });
}

async function sendTaskMessage(taskId: string, message: string): Promise<void> {
  let task = store.getTask(taskId);
  if (!task || !["implementing", "awaiting_input", "awaiting_review", "reviewing", "review_blocked", "awaiting_commit", "await_merge", "validation_failed"].includes(task.state)) throw new Error("当前任务不能继续 AI 对话");
  addTaskEvent({ taskId, kind: "message", title: "你", detail: message });
  if (task.state === "awaiting_input" && isExplicitNoChangeCompletionRequest(message)) {
    taskWorkflow.completeAtUserRequest(taskId);
    return;
  }
  if (task.state === "awaiting_input") task = taskWorkflow.resumeImplementation(taskId);
  else if (task.state !== "implementing") task = updateState(task, "implementing");
  store.updateTask(task.id, { reviewStatus: "pending" });
  if (modelProvider() === "qoder") {
    void runTaskOperation(taskId, (signal) => runQoder(taskId, message, signal)).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  await runTaskOperation(taskId, async (signal) => {
    signal.throwIfAborted();
    if (!piSession || activeTaskId !== taskId) await startPi(taskId);
    await piSession!.prompt(`${message}\n\n${implementationOutcomeInstruction}`, { source: "rpc", ...(piSession!.isStreaming ? { streamingBehavior: "followUp" as const } : {}) });
  });
}

async function stopTaskOperations(taskId: string, markFailed: boolean): Promise<void> {
  const operation = activeTaskOperations.get(taskId);
  operation?.controller.abort(new Error(markFailed ? "任务已停止" : "任务已删除"));
  const task = store.getTask(taskId);
  if (markFailed && task && ["planning", "implementing", "validating", "generating_tests"].includes(task.state)) updateState(task, "failed");

  if (activeTaskId === taskId) {
    const qoderAbort = activeQoderAbort;
    const qoderQuery = activeQoderQuery;
    activeTaskId = undefined;
    activePlanningTaskId = undefined;
    activePlanText = "";
    activeQoderAbort = undefined;
    activeQoderQuery = undefined;
    store.setSetting("activeTaskId", "");

    qoderAbort?.abort(new Error(markFailed ? "任务已停止" : "任务已删除"));
    try { await qoderQuery?.interrupt(); } catch { /* The query may already be closed. */ }
    // close 自身在 Qoder SDK 内部可能因为子进程/会话未释放而卡死，加 5s 超时。
    await closeQoderQuerySafely(qoderQuery, 5_000);
    await stopPi();
  }
  try { await operation?.promise; } catch { /* Cancellation is expected while removing a task. */ }
}

/**
 * 安全关闭 Qoder query：5 秒内未完成则放弃等待。
 *
 * 背景：pi-coding-agent / qoder-agent-sdk 的 query.close() 在子进程未完全退出时
 *  会无限阻塞，进而导致二次执行计划（runQoderPlan 复用同一个 session）时
 *  整个主流程卡在 finally 块。强制超时并清理 activeQoderQuery 至少能保证
 *  下一次执行能正常启动新的 query。
 */
async function closeQoderQuerySafely(q: Query | undefined, timeoutMs: number): Promise<void> {
  if (!q) return;
  let timer: NodeJS.Timeout | undefined;
  const closePromise = Promise.resolve().then(async () => {
    try { await q.close(); } catch { /* already closed or interrupted */ }
  });
  try {
    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type TaskRemovalMode = "workspace" | "all";

async function removeTaskWorkspace(taskId: string, repositories: TaskRepository[]): Promise<void> {
  const git = gitService;
  for (const repo of repositories) {
    if (!repo.worktreePath) continue;
    try { await git.removeWorktree(repo.localPath, repo.worktreePath); }
    catch {
      rmSync(repo.worktreePath, { recursive: true, force: true });
    }
  }
  rmSync(taskWorkspace(taskId), { recursive: true, force: true });
  rmSync(join(dataDir, "worktrees", taskId), { recursive: true, force: true });
  for (const localPath of new Set(repositories.map((repo) => repo.localPath))) {
    try { await git.pruneWorktrees(localPath); } catch { /* The source repository may no longer exist. */ }
  }
}

async function deleteTask(taskId: string, mode: TaskRemovalMode = "all"): Promise<void> {
  if (mode !== "workspace" && mode !== "all") throw new Error("不支持的任务清理方式");
  const task = store.getTask(taskId);
  if (!task) throw new Error("Task not found");
  await stopTaskOperations(taskId, false);
  const repositories = store.listTaskRepositories(taskId);
  await removeTaskWorkspace(taskId, repositories);

  if (mode === "workspace") {
    for (const repo of repositories) {
      store.updateTaskRepository(repo.id, {
        worktreePath: undefined,
        featureBranch: undefined,
        deliveryStatus: "workspace_removed"
      });
    }
    const preservedStates = new Set<TaskState>(["draft", "failed", "completed", "await_merge", "cancelled"]);
    if (!preservedStates.has(task.state)) {
      store.updateTask(taskId, { state: "cancelled", failureStage: undefined });
    }
    addTaskEvent({
      taskId,
      kind: "status",
      title: "任务工作区已清理",
      detail: "已停止任务操作并删除 Worktree；任务、计划、执行记录和交付信息继续保留"
    });
    return;
  }

  store.deleteTask(taskId);
  memoryService.deleteConversationMemories(`task:${taskId}`);
  if (activeTaskId === taskId) activeTaskId = undefined;
}

async function taskChangedFiles(taskId: string, ignoreErrors = true): Promise<Array<{ repositoryId: string; repositoryName: string; path: string; status: string }>> {
  const git = gitService;
  const groups = await Promise.all(store.listTaskRepositories(taskId).map(async (repo) => {
    if (repo.deliveryStatus === "workspace_removed") return [];
    try {
      const files = await git.changedFiles(repo.worktreePath ?? repo.localPath, repo.baseBranch);
      return files.map((file) => ({ repositoryId: repo.repositoryId, repositoryName: repo.name, ...file }));
    } catch (error) {
      if (!ignoreErrors) throw error;
      return [];
    }
  }));
  return groups.flat();
}

async function taskCardsWithCurrentChanges() {
  return Promise.all(store.listCards().map(async (card) => {
    const repositories = new Map(store.listTaskRepositories(card.id).map((repo) => [repo.id, repo]));
    return {
      ...card,
      repositories: await Promise.all(card.repositories.map(async (repository) => {
        const repo = repositories.get(repository.id);
        if (!repo) return repository;
        if (repo.deliveryStatus === "workspace_removed") return repository;
        try {
          const changedFiles = await gitService.changedFiles(repo.worktreePath ?? repo.localPath, repo.baseBranch);
          return { ...repository, changedFileCount: changedFiles.length };
        } catch {
          return repository;
        }
      }))
    };
  }));
}

async function openEditorForTask(taskId: string, editor: "vscode" | "qoder"): Promise<void> {
  if (!(["vscode", "qoder"] as const).includes(editor)) throw new Error("不支持的编辑器");
  const paths = store.listTaskRepositories(taskId).map((repo) => repo.worktreePath ?? repo.localPath);
  await openTaskEditor(editor, paths);
}

/**
 * 手动把任务的 feature 分支合并到本地 base 分支（不推送远端、不建 MR）。
 *
 * 触发：用户在任务详情点击「合并到 base」按钮。
 * 行为（每个仓库顺序执行）：
 *   1) 在 worktree 中 `git status --porcelain` 检查是否有未提交改动；
 *      有则拒绝并提示先 commit 或 stash。
 *   2) `git checkout <baseBranch>`。
 *   3) `git merge --no-ff <featureBranch> -m "merge: <taskId> <title>"`。
 *   4) 成功后 `git checkout <featureBranch>`，保持 worktree 习惯。
 *   5) 任何步骤失败：把 stderr 写入 task event；回滚到 feature 分支；抛错给 UI。
 *
 * 安全约束：
 *   - 任一仓库的 worktree 路径未设置或未生成 feature branch 时拒绝。
 */
async function mergeBackToBase(taskId: string, signal?: AbortSignal): Promise<void> {
  const task = store.getTask(taskId);
  if (!task) throw new Error("任务不存在");
  const repos = store.listTaskRepositories(taskId);
  if (repos.length === 0) throw new Error("任务未关联代码仓库");
  addTaskEvent({ taskId, kind: "status", title: "开始合并 feature 分支到 base" });
  for (const repo of repos) {
    if (!repo.worktreePath) {
      addTaskEvent({ taskId, kind: "error", title: `仓库 ${repo.name} 缺少 worktree 路径`, detail: "请先完成「准备工作」创建 worktree。" });
      throw new Error(`仓库 ${repo.name} 缺少 worktree 路径`);
    }
    if (!repo.featureBranch) {
      addTaskEvent({ taskId, kind: "error", title: `仓库 ${repo.name} 未生成 feature 分支`, detail: "请先完成实现再合并。" });
      throw new Error(`仓库 ${repo.name} 未生成 feature 分支`);
    }
    const cwd = repo.worktreePath;
    signal?.throwIfAborted();
    try {
      const status = (await gitService.status(cwd)).trim();
      if (status) {
        addTaskEvent({ taskId, kind: "error", title: `仓库 ${repo.name} 工作区不干净`, detail: `请先 commit 或 stash 当前改动。\n${status}` });
        throw new Error(`仓库 ${repo.name} 工作区存在未提交改动`);
      }
      addTaskEvent({ taskId, kind: "command", title: `git checkout ${repo.baseBranch}`, detail: `工作目录: ${cwd}` });
      await gitService.checkout(cwd, repo.baseBranch, signal);
      const message = `merge: ${task.taskKey ?? task.id} ${task.title.slice(0, 60)}`;
      addTaskEvent({ taskId, kind: "command", title: `git merge --no-ff ${repo.featureBranch}`, detail: message });
      await gitService.mergeNoFF(cwd, repo.featureBranch, message, signal);
      addTaskEvent({ taskId, kind: "status", title: `仓库 ${repo.name} 已合并 ${repo.featureBranch} -> ${repo.baseBranch}` });
      addTaskEvent({ taskId, kind: "command", title: `git checkout ${repo.featureBranch}`, detail: "合并完成后切回 feature 分支，保持 worktree 习惯" });
      await gitService.checkout(cwd, repo.featureBranch, signal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 失败时尝试切回 feature 分支，避免把 worktree 留在 base。
      try { await gitService.checkout(cwd, repo.featureBranch, signal); } catch { /* 静默：原始错误更重要 */ }
      addTaskEvent({ taskId, kind: "error", title: `仓库 ${repo.name} 合并失败`, detail });
      throw error;
    }
  }
  addTaskEvent({ taskId, kind: "status", title: "已合并所有仓库的 feature 分支到 base（未推送远端）" });
}

type TaskBackendId = "jira" | "github" | "linear";
type TaskBackendInfo = { id: TaskBackendId; displayName: string; configured: boolean };

/**
 * 列出所有可用的「任务创建」后端。
 *
 * - Jira 后端的"configured" 取决于 JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN 是否齐全。
 * - GitHub / Linear 后端本期未实现，显示但 configured=false，方便 UI 提示用户。
 */
function listTaskBackends(): TaskBackendInfo[] {
  const jiraConfigured = !!(desktopResolver.get("jiraBaseUrl") && desktopResolver.get("jiraEmail") && desktopResolver.get("jiraApiToken"));
  // 计划内的占位项：实际接入由后续任务负责。
  return [
    { id: "jira", displayName: "Jira", configured: jiraConfigured },
    { id: "github", displayName: "GitHub Issues", configured: false },
    { id: "linear", displayName: "Linear", configured: false }
  ];
}

/**
 * 根据系统设置解析当前默认后端。任务创建 Agent 在 `chat-service` 启动时使用。
 */
function resolveDefaultBackend(): TaskBackendId {
  const hint = desktopResolver.get("taskCreationBackend");
  if (hint === "jira" || hint === "github" || hint === "linear") return hint;
  // 默认回退到 Jira（保持现有行为）。
  return "jira";
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

// === Memory 任务上下文(检索/注入/整理) ========================================

function resolveTaskChatModel(): ResolvedChatModel {
  if (modelProvider() === "qoder") {
    return { provider: "qoder", key: store.getSetting("defaultModel") ?? "claude-sonnet-4.5" };
  }
  return resolveChatModel("openai:default", store, () => protectedValue("modelApiKey"));
}

async function taskMemoryContext(task: Task, repos: TaskRepository[]): Promise<string | undefined> {
  try {
    const { memories, wikiDocs } = await memoryService.search({
      userId: memoryService.ensureUserId(),
      repositoryIds: repos.map((repo) => repo.repositoryId),
      conversationId: `task:${task.id}`,
      query: `${task.title}\n${task.description}`
    });
    addTaskEvent({
      taskId: task.id,
      kind: "status",
      title: "检索记忆上下文",
      detail: `用户级 ${memories.filter((m) => m.scope === "user").length} 条、仓库级 ${memories.filter((m) => m.scope === "repo").length} 条、对话级 ${memories.filter((m) => m.scope === "conversation").length} 条、repowiki 文档 ${wikiDocs.length} 篇${memories.length + wikiDocs.length ? "" : "（未命中）"}`
    });
    return renderMemoryContext(memories, wikiDocs);
  } catch (error) {
    console.warn("[memory] task context failed:", error);
    return undefined;
  }
}

async function consolidateTaskMemory(taskId: string, responseTexts: string[]): Promise<void> {
  try {
    const task = store.getTask(taskId);
    if (!task) return;
    const repos = store.listTaskRepositories(taskId);
    const events = store.listEvents(taskId);
    const transcript = [
      `任务：${task.title}\n${task.description}`,
      task.planContent ? `计划：\n${task.planContent}` : "",
      ...events.slice(-80).map((event) => `[${event.kind}] ${event.title}${event.detail ? `\n${event.detail}` : ""}`),
      ...responseTexts.slice(-5).map((text) => `AI 输出：\n${text}`)
    ].join("\n\n");
    const extracted = await extractMemories({
      model: resolveTaskChatModel(),
      qoderToken: modelProvider() === "qoder" ? protectedValue("qoderToken") : undefined,
      text: transcript,
      context: "task",
      allowedScopes: ["user", "repo"]
    });
    if (!extracted.length) return;
    const saved = memoryService.consolidateMemories(extracted, repos.map((repo) => repo.repositoryId), `task:${taskId}`);
    if (saved > 0) {
      addTaskEvent({ taskId, kind: "status", title: "记忆整理完成", detail: `从任务执行记录中整理并保存 ${saved} 条记忆` });
    }
  } catch (error) {
    console.warn("[memory] task consolidate failed:", error);
  }
}

async function consolidateChatMemory(conversation: ChatConversation, model: ResolvedChatModel): Promise<void> {
  try {
    const text = conversation.messages
      .filter((message) => message.role !== "system")
      .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.parts.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("")}`)
      .join("\n\n");
    if (!text.trim()) return;
    const extracted = await extractMemories({
      model,
      qoderToken: model.provider === "qoder" ? protectedValue("qoderToken") : undefined,
      text,
      context: "chat",
      allowedScopes: ["user", "conversation"]
    });
    if (!extracted.length) return;
    memoryService.consolidateMemories(extracted, [], conversation.id);
  } catch (error) {
    console.warn("[memory] chat consolidate failed:", error);
  }
}

// === IPC 路由(全部保留) =======================================================

function registerIpc(): void {
  ipcMain.handle("tasks:list", async () => { await mergeRefresher.refresh(); return taskCardsWithCurrentChanges(); });
  ipcMain.handle("tasks:get", async (_event, id: string) => { await mergeRefresher.refresh(); return { task: store.getTask(id), repositories: store.listTaskRepositories(id), events: store.listEvents(id), approvals: store.listApprovals(id), changedFiles: await taskChangedFiles(id) }; });
  ipcMain.handle("tasks:create", (_event, input: Pick<Task, "title" | "description"> & Partial<Pick<Task, "keywords" | "acceptanceCriteria">>) => store.createTask(input));
  ipcMain.handle("tasks:update", (_event, id: string, patch: Record<string, unknown>) => store.updateTask(id, patch));
  ipcMain.handle("tasks:delete", (_event, id: string, mode?: TaskRemovalMode) => deleteTask(id, mode));
  ipcMain.handle("repos:list", () => store.listRepositoryProfiles());
  ipcMain.handle("repos:save", async (_event, profile) => {
    store.saveRepositoryProfile(profile);
    try { await memoryService.refreshRepoWiki(profile.id, profile.localPath); }
    catch (error) { console.warn("[repowiki] index failed:", error); }
  });
  ipcMain.handle("repos:delete", (_event, id: string) => {
    store.deleteRepositoryProfile(id);
    memoryService.deleteRepoMemories(id);
  });
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
  // 编辑任务时持久化每个已关联仓库的命令配置（setup / lint / test / build）。
  ipcMain.handle("tasks:update-repo-commands", (_event, taskId: string, repositoryId: string, commands: Partial<Pick<TaskRepository, "setupCommand" | "lintCommand" | "testCommand" | "buildCommand">>) => {
    const repo = store.listTaskRepositories(taskId).find((item) => item.repositoryId === repositoryId);
    if (!repo) throw new Error(`任务仓库不存在: ${repositoryId}`);
    return store.updateTaskRepository(repo.id, commands);
  });
  ipcMain.handle("settings:get", (_event, key: string) => ["jiraToken", "confluenceToken", "qoderToken", "modelApiKey", "gitlabToken"].includes(key) ? (store.getSetting(key) ? "__configured__" : undefined) : store.getSetting(key));
  ipcMain.handle("settings:set", (_event, key: string, value: string, secret = false) => {
    store.setSetting(key, secret ? keyStore.protect(value, key) : value);
    if (key === "modelProfile") syncPiModelConfig(value);
  });
  ipcMain.handle("tasks:start", (_event, taskId: string, options?: { mode?: TaskStartMode; repositoryCommands?: RepositoryCommandMap; useAllRepositories?: boolean }) => startTask(taskId, options));
  ipcMain.handle("tasks:reimplement", (_event, taskId: string) => taskWorkflow.reimplement(taskId));
  ipcMain.handle("tasks:resume", (_event, taskId: string) => resumeTask(taskId));
  ipcMain.handle("tasks:approve-plan", (_event, taskId: string) => approveTaskPlan(taskId));
  ipcMain.handle("tasks:revise-plan", (_event, taskId: string, feedback: string) => reviseTaskPlan(taskId, feedback));
  ipcMain.handle("tasks:retry-validation", (_event, taskId: string) => retryTaskValidation(taskId));
  ipcMain.handle("tasks:message", (_event, taskId: string, message: string) => sendTaskMessage(taskId, message));
  ipcMain.handle("tasks:abort", () => activeTaskId ? stopTaskOperations(activeTaskId, true) : undefined);
  ipcMain.handle("tasks:review", (_event, taskId: string) => runTaskOperation(taskId, (signal) => taskWorkflow.runReview(taskId, buildReviewOrchestrator(), signal)));
  ipcMain.handle("tasks:reset-review", (_event, taskId: string) => taskWorkflow.resetReview(taskId));
  ipcMain.handle("tasks:reset-delivery", (_event, taskId: string) => deliveryService.resetDelivery(taskId));
  ipcMain.handle("tasks:submit-mrs", (_event, taskId: string) => runTaskOperation(taskId, (signal) => deliveryService.submitMergeRequests(taskId, signal)));
  ipcMain.handle("tasks:refresh-merge-status", () => mergeRefresher.refresh());
  ipcMain.handle("tasks:manual-complete", (_event, taskId: string) => taskCompleter.manualComplete(taskId));
  ipcMain.handle("tasks:open-editor", (_event, taskId: string, editor: "vscode" | "qoder") => openEditorForTask(taskId, editor));
  ipcMain.handle("tasks:merge-back-to-base", (_event, taskId: string) => runTaskOperation(taskId, (signal) => mergeBackToBase(taskId, signal)));
  // 在系统文件管理器打开任务 workspace（所有仓库 worktree 的父目录），不区分单/多仓库。
  ipcMain.handle("tasks:reveal-workspace", (_event, taskId: string) => {
    if (typeof taskId !== "string" || !taskId) throw new Error("taskId 不能为空");
    const workspace = taskWorkspace(taskId);
    if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
    shell.showItemInFolder(workspace);
  });
  ipcMain.handle("tasks:list-backends", () => listTaskBackends());
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
  ipcMain.handle("jira:import", async (_event, keyOrUrl: string) => safeAtlassianCall("导入 Jira Issue", () => importJiraIssue(atlassianFactory.create("jira"), keyOrUrl, store)));
  ipcMain.handle("jira:sync", async () => safeAtlassianCall("同步 Jira 任务", async () => {
    const candidates = await fetchJiraTasks(atlassianFactory.create("jira"));
    // 标注每个候选项在本地系统中的状态:已存在(existing)且不在 TODO 列(conflict)时,
    // 前端导入需要用户确认覆盖。
    return candidates.map((candidate) => {
      const existing = candidate.taskKey ? store.getTaskBySourceKey("jira", candidate.taskKey) : undefined;
      return {
        ...candidate,
        existing: Boolean(existing),
        conflict: Boolean(existing && boardColumnFor(existing.state) !== "todo")
      };
    });
  }));
  ipcMain.handle("jira:import-many", (_event, candidates: Array<Record<string, unknown>>) => {
    const tasks = candidates.flatMap((candidate) => {
      const taskKey = typeof candidate.taskKey === "string" ? candidate.taskKey.trim().toUpperCase() : "";
      const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
      if (!taskKey || !title) return [];
      return [store.upsertJiraTask({ taskKey, source: "jira", sourceUrl: typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : undefined, title, description: typeof candidate.description === "string" ? candidate.description : "", keywords: Array.isArray(candidate.keywords) ? candidate.keywords.map(String) : [], acceptanceCriteria: Array.isArray(candidate.acceptanceCriteria) ? candidate.acceptanceCriteria.map(String) : [], state: "draft", reviewStatus: "pending" })];
    });
    if (tasks.length > 0) store.setSetting("lastJiraSync", new Date().toISOString());
    return tasks;
  });
  ipcMain.handle("atlassian:test", async (_event, kind: "jira" | "confluence") => testAtlassianConnection(atlassianFactory.create(kind)));
  ipcMain.handle("task:ui-response", (_event, response: Record<string, unknown>) => pendingUi.get(String(response.id))?.(response));
  // === Memory 系统(仓库级 / 用户级 / 对话级 + repowiki 文档) ==================
  ipcMain.handle("memory:list", (_event, filter?: { scope?: Memory["scope"]; scopes?: Memory["scope"][]; repositoryId?: string; conversationId?: string }) => memoryService.listMemories(filter));
  ipcMain.handle("memory:upsert", (_event, input: Parameters<MemoryService["upsertMemory"]>[0]) => memoryService.upsertMemory(input));
  ipcMain.handle("memory:update", (_event, id: string, patch: Partial<Omit<Memory, "id" | "createdAt" | "updatedAt">>) => memoryService.updateMemory(id, patch));
  ipcMain.handle("memory:delete", (_event, id: string) => memoryService.deleteMemory(id));
  ipcMain.handle("memory:search", (_event, query: string, options?: { repositoryIds?: string[]; conversationId?: string; limit?: number }) =>
    memoryService.search({ userId: memoryService.ensureUserId(), query, ...options }));
  ipcMain.handle("repowiki:index", async (_event, repositoryId: string) => {
    const profile = store.listRepositoryProfiles().find((repo) => repo.id === repositoryId);
    if (!profile) throw new Error("仓库不存在");
    return memoryService.refreshRepoWiki(profile.id, profile.localPath);
  });
  ipcMain.handle("repowiki:list", (_event, repositoryId: string) => memoryService.listRepoWikiDocs(repositoryId));
  ipcMain.handle("repowiki:search", (_event, repositoryId: string, query: string) => memoryService.searchRepoWikiDocs(repositoryId, query));
  // === Chat 对话(Codex 样式) =================================================
  ipcMain.handle("chats:list", () => chatService.listChats());
  ipcMain.handle("chats:get", (_event, id: string) => chatService.getChat(id));
  ipcMain.handle("chats:create", (_event, model?: string) => chatService.createChat(model));
  ipcMain.handle("chats:delete", (_event, id: string) => {
    chatService.deleteChat(id);
    memoryService.deleteConversationMemories(id);
  });
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
  for (const repo of store.listRepositoryProfiles()) {
    void memoryService.refreshRepoWiki(repo.id, repo.localPath).catch((error) => console.warn("[repowiki] startup index failed:", error));
  }
  const mergeTimer = setInterval(() => { void mergeRefresher.refresh(); }, 60_000);
  mergeTimer.unref();
  app.on("browser-window-focus", () => { void mergeRefresher.refresh(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { void stopPi(); store.close(); });
