import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, getAgentDir, hasTrustRequiringProjectResources, ModelRuntime, ProjectTrustStore, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { TaskStore, LocalFileKeyStore, transitionTask } from "@coding-agent/core";
import { AtlassianClientFactory, DeliveryService, fetchJiraTasks, GitService, importJiraIssue, MergeStatusRefresher, openTaskEditor, OpenCodeReviewService, OpenAICompatReviewer, redactSecrets, ReviewOrchestrator, TaskCompleter, TaskWorkflow, testAtlassianConnection, asReviewer } from "@coding-agent/integrations";
import { resolveBundledOcrBinary, resolveOcrBinary, createOcrRunner } from "./ocr.js";
import { accessToken, query } from "@qoder-ai/qoder-agent-sdk";
import { parsePlanDecision, sdkResultText } from "./plan-content.js";
import { ChatService } from "./chat/chat-service.js";
import { JiraTaskCreationAgent } from "./chat/task-creation-agent.js";
import { implementationOutcomeInstruction, isExplicitNoChangeCompletionRequest, nextStepForImplementation, nextStepForPlan, parseImplementationDecision } from "./task-readiness.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow;
let piSession;
let unsubscribePi;
const pendingUi = new Map();
const dataDir = process.env.CODING_AGENT_DATA_DIR ?? join(app.getPath("userData"), "data");
process.env.CODING_AGENT_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });
const store = new TaskStore(join(dataDir, "coding-agent.db"));
const keyStore = new LocalFileKeyStore(dataDir);
let activeTaskId;
let activeQoderQuery;
let activeQoderAbort;
let activePlanningTaskId;
let activePlanText = "";
const activeTaskOperations = new Map();
const taskStateLabels = {
    draft: "待处理", confirmed: "已确认", preparing: "准备环境", implementing: "实现中",
    planning: "计划中", awaiting_plan_approval: "等待计划确认", awaiting_input: "等待补充", validating: "校验中", validation_failed: "校验失败",
    awaiting_review: "等待 Review", reviewing: "Review 中", review_blocked: "Review 阻断",
    awaiting_commit: "等待提交 MR", delivering: "提交 MR 中", await_merge: "等待合并",
    completed: "已完成", failed: "执行失败", cancelled: "已取消"
};
// === 抽象层宿主实现 ===========================================================
class DesktopEventSink {
    addEvent(input) {
        const event = store.addEvent(input);
        emitTaskChanged(input.taskId);
        return event;
    }
    emitChanged(taskId) { emitTaskChanged(taskId); }
}
class DesktopSettingResolver {
    get(key) { return store.getSetting(key); }
    getSecret(key, envName) {
        if (envName && process.env[envName])
            return process.env[envName];
        return keyStore.resolve(store.getSetting(key), key);
    }
}
const desktopSink = new DesktopEventSink();
const desktopResolver = new DesktopSettingResolver();
// === 通用工具 =================================================================
function settingFlag(key) { return store.getSetting(key) === "true"; }
function protectedValue(key) { return keyStore.resolve(store.getSetting(key), key); }
function taskWorkspace(taskId) { return join(dataDir, "workspaces", taskId); }
function sendTaskEvent(event) {
    const json = JSON.stringify(event, (_key, value) => typeof value === "string" ? redactSecrets(value) : value);
    mainWindow?.webContents.send("task:event", JSON.parse(json));
}
function emitTaskChanged(taskId) { sendTaskEvent({ type: "task_changed", taskId }); }
function addTaskEvent(event) {
    store.addEvent(event);
    emitTaskChanged(event.taskId);
}
function updatePiUsage(taskId) {
    if (!piSession)
        return;
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
function workspaceEntry(name, repositoryId, used) {
    const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "repository";
    const entry = used.has(base) ? `${base}-${repositoryId.slice(0, 8)}` : base;
    used.add(entry);
    return entry;
}
function updateState(task, state) {
    if (task.state !== state)
        transitionTask(task.state, state);
    const updated = store.updateTask(task.id, { state });
    addTaskEvent({ taskId: task.id, kind: "status", title: `状态更新为 ${taskStateLabels[state]}` });
    return updated;
}
// 把 Atlassian MCP 调用失败包装成"操作名 + 原因"的中文错误，渲染端会直接展示这条消息。
// 原始堆栈写到主进程日志，便于排查；避免把 "MCP request timeout: initialize" 这种无操作意义的
// 内部消息直接给到用户。
async function safeAtlassianCall(action, operation) {
    try {
        return await operation();
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[atlassian] ${action} failed:`, error);
        throw new Error(`${action}失败：${reason}`);
    }
}
function runTaskOperation(taskId, action) {
    activeTaskOperations.get(taskId)?.controller.abort(new Error("新的任务操作已开始"));
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => action(controller.signal));
    const operation = { controller, promise };
    activeTaskOperations.set(taskId, operation);
    void promise.finally(() => {
        if (activeTaskOperations.get(taskId) === operation)
            activeTaskOperations.delete(taskId);
    }).catch(() => undefined);
    return promise;
}
function modelProvider() {
    const raw = store.getSetting("modelProfile");
    if (!raw)
        return "qoder";
    try {
        return JSON.parse(raw).provider === "qoder" ? "qoder" : "openai";
    }
    catch {
        return "qoder";
    }
}
// === 下沉模块实例(整个进程单例) ===============================================
const ocrService = new OpenCodeReviewService(resolveOcrBinary(), createOcrRunner());
const gitService = new GitService();
const openAIReviewer = new OpenAICompatReviewer(desktopResolver);
function buildReviewOrchestrator() {
    return new ReviewOrchestrator({ ocr: ocrService, git: gitService, reviewer: asReviewer(callQoderOrOpenAIReviewer) }, desktopSink);
}
const taskWorkflow = new TaskWorkflow(store, desktopResolver, desktopSink, taskWorkspace);
const deliveryService = new DeliveryService(store, gitService, desktopResolver, desktopSink);
const mergeRefresher = new MergeStatusRefresher(store, desktopResolver, desktopSink);
const taskCompleter = new TaskCompleter(store, desktopSink);
const atlassianFactory = new AtlassianClientFactory(desktopResolver);
const chatService = new ChatService(store, dataDir, getQoderStatus, () => protectedValue("qoderToken"), () => protectedValue("modelApiKey"), () => mainWindow, () => new JiraTaskCreationAgent(atlassianFactory));
// === Review 实现(Qoder / OpenAI 兼容) =========================================
async function callQoderReviewer(prompt, taskId, model, signal) {
    const token = protectedValue("qoderToken");
    if (!token)
        throw new Error("请先配置 Qoder Token");
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
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
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
                        const content = message.message?.content;
                        if (Array.isArray(content))
                            text += content.filter((c) => c?.type === "text" && c.text).map((c) => c.text).join("\n");
                    }
                    else if (message.type === "result") {
                        const result = message.result;
                        if (result)
                            text += result;
                    }
                }
                return text;
            })(),
            timeoutPromise
        ]);
    }
    finally {
        signal?.removeEventListener("abort", abortFromTask);
        if (timer)
            clearTimeout(timer);
        if (!abort.signal.aborted)
            abort.abort();
        try {
            await q.close();
        }
        catch { /* ignore */ }
    }
}
function callQoderOrOpenAIReviewer(input, taskId, model, signal) {
    if (modelProvider() === "qoder")
        return callQoderReviewer(buildReviewPromptForQoder(input), taskId, model, signal);
    return openAIReviewer.call(input, taskId, model, signal);
}
function buildReviewPromptForQoder(input) {
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
function qoderText(message) {
    const record = message;
    if (message.type === "result")
        return sdkResultText(record.result, record.errors);
    if (message.type !== "assistant")
        return undefined;
    const content = record.message?.content;
    if (!Array.isArray(content))
        return undefined;
    return content.filter((item) => item?.type === "text").map((item) => item.text).filter(Boolean).join("\n") || undefined;
}
async function savePlanDecision(taskId, texts) {
    const decision = parsePlanDecision(texts);
    if (decision.outcome === "changes_required")
        return taskWorkflow.setPlan(taskId, decision.content);
    let changedFiles;
    try {
        changedFiles = await taskChangedFiles(taskId, false);
    }
    catch (error) {
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
function recordQoderMessage(taskId, message, recordText = true) {
    const text = qoderText(message);
    const current = store.getTask(taskId)?.sessionUsage;
    const previous = current?.provider === "qoder" ? current : undefined;
    if (message.type === "assistant") {
        const u = message.message?.usage;
        if (u) {
            const inputTokens = (previous?.inputTokens ?? 0) + (u.input_tokens ?? 0);
            const outputTokens = (previous?.outputTokens ?? 0) + (u.output_tokens ?? 0);
            const cacheRead = (previous?.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            const cacheWrite = (previous?.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
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
        const result = message;
        const models = Object.values(result.modelUsage ?? {});
        const sum = (k) => models.reduce((s, m) => s + (m?.[k] ?? 0), 0);
        const mIn = sum("inputTokens"), mOut = sum("outputTokens"), mRd = sum("cacheReadInputTokens"), mWr = sum("cacheCreationInputTokens"), mCost = sum("costUSD");
        const uIn = result.usage?.input_tokens ?? 0, uOut = result.usage?.output_tokens ?? 0, uRd = result.usage?.cache_read_input_tokens ?? 0, uWr = result.usage?.cache_creation_input_tokens ?? 0;
        const pick = (mv, uv, prev) => mv > 0 ? mv : uv > 0 ? uv : (prev ?? 0);
        const inputTokens = pick(mIn, uIn, previous?.inputTokens);
        const outputTokens = pick(mOut, uOut, previous?.outputTokens);
        const cacheRead = pick(mRd, uRd, previous?.cacheReadTokens);
        const cacheWrite = pick(mWr, uWr, previous?.cacheWriteTokens);
        const cost = mCost > 0 ? mCost : (result.total_cost_usd ?? 0);
        const usage = {
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
    if (text && recordText)
        addTaskEvent({ taskId, kind: "message", title: "Qoder Agent", detail: text });
    else if (message.type === "system")
        addTaskEvent({ taskId, kind: "status", title: `Qoder ${message.subtype}`, detail: JSON.stringify(message).slice(0, 2000) });
    emitPi({ type: "qoder_event", taskId, message });
}
function qoderLogFile(taskId) {
    if (process.env.CODING_AGENT_QODER_LOG !== "1")
        return undefined;
    const dir = join(dataDir, "logs", "qoder");
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(dir, `${taskId}-${stamp}.jsonl`);
}
function logQoderMessage(file, message) {
    if (!file)
        return;
    try {
        appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), msg: message }) + "\n", "utf8");
    }
    catch { /* 日志写不进去不能影响主流程 */ }
}
async function runQoder(taskId, extraPrompt, signal) {
    const task = await taskWorkflow.prepare(taskId, signal);
    const token = protectedValue("qoderToken");
    if (!token)
        throw new Error("请先配置 Qoder Token");
    const repos = store.listTaskRepositories(task.id);
    if (repos.length === 0)
        throw new Error("任务未关联代码仓库");
    activeTaskId = task.id;
    addTaskEvent({ taskId, kind: "status", title: "执行环境:Qoder Agent SDK", detail: "使用应用随附运行时,并在已配置仓库目录中执行" });
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
        `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
        extraPrompt ? `Additional request:\n${extraPrompt}` : "",
        implementationOutcomeInstruction
    ].filter(Boolean).join("\n\n");
    const q = query({ prompt, options: { auth: accessToken(token), cwd: repos[0].worktreePath ?? repos[0].localPath, additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath), abortController: qoderAbort, includePartialMessages: true, permissionMode: "acceptEdits", persistSession: true, ...(task.qoderModel ? { model: task.qoderModel } : {}) } });
    activeQoderQuery = q;
    emitPi({ type: "agent_start", provider: "qoder", taskId, phase: "implementation" });
    const logFile = qoderLogFile(task.id);
    const responseTexts = [];
    if (logFile) {
        try {
            appendFileSync(logFile, JSON.stringify({
                t: new Date().toISOString(), kind: "meta", taskId: task.id, prompt,
                options: { cwd: repos[0].worktreePath ?? repos[0].localPath, model: task.qoderModel, additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath) }
            }) + "\n", "utf8");
        }
        catch { /* 忽略 */ }
    }
    try {
        for await (const message of q) {
            logQoderMessage(logFile, message);
            const text = qoderText(message);
            if ((message.type === "assistant" || message.type === "result") && text)
                responseTexts.push(text);
            recordQoderMessage(task.id, message);
        }
        await finishImplementation(task.id, responseTexts, signal);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        addTaskEvent({ taskId, kind: "error", title: "Qoder 执行失败", detail });
        const current = store.getTask(task.id);
        if (["implementing", "validating"].includes(current?.state ?? ""))
            updateState(current, "failed");
        emitPi({ type: "agent_error", taskId, message: detail });
    }
    finally {
        signal?.removeEventListener("abort", abortFromTask);
        activeQoderQuery = undefined;
        activeQoderAbort = undefined;
        emitPi({ type: "agent_end", provider: "qoder", taskId, phase: "implementation" });
    }
}
async function runQoderPlan(taskId, feedback, signal) {
    const task = store.getTask(taskId);
    const token = protectedValue("qoderToken");
    if (!task || task.state !== "planning")
        throw new Error("当前任务不能生成计划");
    if (!token)
        throw new Error("请先配置 Qoder Token");
    const repos = store.listTaskRepositories(task.id);
    if (repos.length === 0)
        throw new Error("任务未关联代码仓库");
    activeTaskId = task.id;
    activePlanningTaskId = task.id;
    activePlanText = "";
    const prompt = [`请只读分析以下 Coding 任务。`, `任务：${task.title}`, task.description, `验收标准：\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`, feedback ? `上一次计划的调整意见：\n${feedback}` : "", "禁止修改文件，禁止执行安装、构建或其他会改变工作区的命令。", "最终只输出一个 JSON 对象，不要输出过程说明或 Markdown 代码块。若代码已满足要求，输出 {\"outcome\":\"already_satisfied\",\"summary\":\"判断依据和验证建议\"}；否则输出 {\"outcome\":\"changes_required\",\"plan\":\"完整实施计划，包含涉及文件、实施步骤、验证方式和风险\"}。"].filter(Boolean).join("\n\n");
    const abort = new AbortController();
    const abortFromTask = () => abort.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abortFromTask, { once: true });
    activeQoderAbort = abort;
    const q = query({ prompt, options: { auth: accessToken(token), cwd: repos[0].worktreePath ?? repos[0].localPath, additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath), abortController: abort, includePartialMessages: true, permissionMode: "plan", persistSession: true, ...(task.qoderModel ? { model: task.qoderModel } : {}) } });
    activeQoderQuery = q;
    emitPi({ type: "agent_start", provider: "qoder", taskId, phase: "planning" });
    const planMessages = [];
    try {
        for await (const message of q) {
            recordQoderMessage(task.id, message, false);
            const text = qoderText(message);
            if ((message.type === "assistant" || message.type === "result") && text)
                planMessages.push(text);
        }
        await savePlanDecision(taskId, planMessages);
    }
    catch (error) {
        const current = store.getTask(taskId);
        if (current?.state === "planning")
            updateState(current, "failed");
        throw error;
    }
    finally {
        signal?.removeEventListener("abort", abortFromTask);
        activePlanningTaskId = undefined;
        activeQoderQuery = undefined;
        activeQoderAbort = undefined;
        emitPi({ type: "agent_end", provider: "qoder", taskId, phase: "planning" });
    }
}
async function advanceAfterValidation(taskId, state, signal) {
    if (state !== "awaiting_review")
        return;
    signal?.throwIfAborted();
    if (taskWorkflow.isReviewEnabled()) {
        await taskWorkflow.runReview(taskId, buildReviewOrchestrator(), signal);
    }
    else {
        store.updateTask(taskId, { reviewStatus: "waived" });
        updateState(store.getTask(taskId), "awaiting_commit");
        addTaskEvent({ taskId, kind: "status", title: "已跳过 Review,等待提交 MR" });
    }
    const updated = store.getTask(taskId);
    if (updated?.state === "awaiting_commit" && taskWorkflow.shouldAutoCreateMergeRequests())
        await deliveryService.submitMergeRequests(taskId, signal);
}
async function finishImplementation(taskId, responseTexts, signal) {
    const task = store.getTask(taskId);
    if (!task || task.state !== "implementing")
        return;
    const decision = parseImplementationDecision(responseTexts);
    if (decision.outcome === "needs_input") {
        taskWorkflow.awaitInput(taskId, decision.content || "Agent 表示当前信息不足或实现尚未完成，请补充后继续。");
        return;
    }
    let changedFiles;
    try {
        changedFiles = await taskChangedFiles(taskId, false);
    }
    catch (error) {
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
    const validated = await taskWorkflow.runValidation(taskId, signal);
    await advanceAfterValidation(taskId, validated.state, signal);
}
// === Pi Session 集成(留在 desktop) ============================================
function syncPiModelConfig(raw) {
    const profile = JSON.parse(raw);
    if (!profile.baseUrl || !profile.model)
        return;
    const agentDir = store.getSetting("piAgentDir") ?? getAgentDir();
    mkdirSync(agentDir, { recursive: true });
    const modelsPath = join(agentDir, "models.json");
    const current = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) : {};
    const providers = current.providers && typeof current.providers === "object" && !Array.isArray(current.providers) ? current.providers : {};
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
function emitPi(event) {
    const json = JSON.stringify(event, (_key, value) => typeof value === "string" ? redactSecrets(value) : value);
    const record = JSON.parse(json);
    if (activePlanningTaskId && record.type === "message_update") {
        const update = record.assistantMessageEvent;
        if (update?.type === "text_delta" && update.delta)
            activePlanText += update.delta;
    }
    if (activePlanningTaskId)
        record.phase = "planning";
    if (activeTaskId && modelProvider() === "openai" && ["message_end", "agent_end"].includes(String(record.type)))
        updatePiUsage(activeTaskId);
    if (activeTaskId && record.type === "tool_execution_end")
        emitTaskChanged(activeTaskId);
    sendTaskEvent(typeof record.taskId === "string" || !activeTaskId ? record : { ...record, taskId: activeTaskId });
    if (record.type === "agent_end" && activeTaskId && !activePlanningTaskId && modelProvider() === "openai") {
        const taskId = activeTaskId;
        const responseTexts = Array.isArray(record.messages)
            ? record.messages.flatMap((message) => message?.role === "assistant" && Array.isArray(message.content)
                ? message.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text)
                : [])
            : [];
        void runTaskOperation(taskId, (signal) => finishImplementation(taskId, responseTexts, signal)).catch((error) => emitPi({ type: "agent_error", message: error instanceof Error ? error.message : String(error) }));
    }
}
function requestUi(method, payload, options) {
    const id = randomUUID();
    return new Promise((resolve) => {
        let timer;
        const finish = (response) => {
            if (timer)
                clearTimeout(timer);
            pendingUi.delete(id);
            if (response.cancelled)
                resolve(undefined);
            else if (method === "confirm")
                resolve(Boolean(response.confirmed));
            else
                resolve(response.value);
        };
        pendingUi.set(id, finish);
        emitPi({ type: "extension_ui_request", id, method, ...payload, timeout: options?.timeout });
        if (options?.timeout)
            timer = setTimeout(() => finish({ cancelled: true }), options.timeout);
        options?.signal?.addEventListener("abort", () => finish({ cancelled: true }), { once: true });
    });
}
function createGuiUI() {
    const ui = {
        select: (title, options, opts) => requestUi("select", { title, options }, opts),
        confirm: async (title, message, opts) => (await requestUi("confirm", { title, message }, opts)) ?? false,
        input: (title, placeholder, opts) => requestUi("input", { title, placeholder }, opts),
        editor: (title, prefill) => requestUi("editor", { title, prefill }),
        notify: (message, type = "info") => emitPi({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notificationType: type }),
        setStatus: (key, text) => emitPi({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text }),
        setTitle: (title) => emitPi({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title }),
        setEditorText: (text) => emitPi({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text }),
        pasteToEditor: (text) => emitPi({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text }),
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
    return ui;
}
async function stopPi() {
    unsubscribePi?.();
    unsubscribePi = undefined;
    if (piSession) {
        if (!piSession.isIdle)
            await piSession.abort();
        piSession.dispose();
        piSession = undefined;
    }
    for (const resolve of pendingUi.values())
        resolve({ cancelled: true });
    pendingUi.clear();
}
async function startPi(taskId) {
    await stopPi();
    const task = store.getTask(taskId);
    if (!task)
        throw new Error("Task not found");
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
            if (!hasTrustRequiringProjectResources(cwd))
                return true;
            const trustStore = new ProjectTrustStore(agentDir);
            const saved = trustStore.get(cwd);
            if (saved !== null)
                return saved;
            const choice = await requestUi("select", {
                title: "信任项目配置",
                options: ["信任并记住", "仅本次信任", "不信任"],
                message: `仓库 ${cwd} 包含项目级 Pi Extension、Skill 或配置。仅信任你确认过的代码仓库。`
            });
            if (choice === "信任并记住") {
                trustStore.set(cwd, true);
                return true;
            }
            return choice === "仅本次信任";
        } });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const modelRaw = store.getSetting("modelProfile");
    if (modelRaw) {
        const profile = JSON.parse(modelRaw);
        const localKey = keyStore.resolve(store.getSetting("modelApiKey"), "modelApiKey");
        const apiKey = (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined) ?? localKey;
        if (apiKey)
            await modelRuntime.setRuntimeApiKey(profile.provider ?? "company-openai", apiKey);
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
async function startTask(taskId, options = {}) {
    const current = store.getTask(taskId);
    if (modelProvider() === "qoder" && current && ["draft", "failed"].includes(current.state))
        store.updateTask(taskId, { sessionUsage: undefined });
    const mode = options.mode ?? "direct";
    const task = await runTaskOperation(taskId, (signal) => taskWorkflow.begin(taskId, mode, options.repositoryCommands, signal));
    if (mode === "plan") {
        if (modelProvider() === "qoder")
            void runTaskOperation(taskId, (signal) => runQoderPlan(taskId, undefined, signal)).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
        else {
            await runTaskOperation(taskId, async (signal) => {
                signal.throwIfAborted();
                activePlanningTaskId = taskId;
                activePlanText = "";
                await startPi(taskId);
                await piSession.prompt(`你处于只读计划模式。禁止修改文件、安装依赖或运行会改变工作区的命令。最终只输出 JSON：代码已满足要求时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n${task.title}\n${task.description}`, { source: "rpc" });
                signal.throwIfAborted();
                const plan = activePlanText.trim();
                activePlanningTaskId = undefined;
                if (plan)
                    await savePlanDecision(taskId, [plan]);
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
        if (!piSession)
            throw new Error("OpenAI agent session is unavailable");
        await piSession.prompt(`${task.title}\n\n${task.description}\n\n${task.planContent ? `Approved implementation plan:\n${task.planContent}\n\n` : ""}Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\n${implementationOutcomeInstruction}`, { source: "rpc" });
    });
}
async function approveTaskPlan(taskId) {
    const before = store.getTask(taskId);
    if (!before?.planContent)
        throw new Error("当前任务没有可批准的计划");
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
        await piSession.prompt(`${task.title}\n\n${task.description}\n\nApproved implementation plan:\n${task.planContent}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\n${implementationOutcomeInstruction}`, { source: "rpc" });
    });
}
async function reviseTaskPlan(taskId, feedback) {
    const task = taskWorkflow.revisePlan(taskId);
    addTaskEvent({ taskId, kind: "message", title: "计划调整意见", detail: feedback });
    if (modelProvider() === "qoder") {
        void runTaskOperation(taskId, (signal) => runQoderPlan(taskId, feedback, signal)).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
        return;
    }
    await runTaskOperation(taskId, async (signal) => {
        signal.throwIfAborted();
        activePlanningTaskId = taskId;
        activePlanText = "";
        await startPi(taskId);
        await piSession.prompt(`你处于只读计划模式。根据调整意见重新判断，禁止修改文件。最终只输出 JSON：无需修改时输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n任务：${task.title}\n${task.description}\n\n上一版计划：\n${task.planContent ?? ""}\n\n调整意见：\n${feedback}`, { source: "rpc" });
        signal.throwIfAborted();
        const plan = activePlanText.trim();
        activePlanningTaskId = undefined;
        if (!plan)
            throw new Error("Agent 未返回有效计划");
        await savePlanDecision(taskId, [plan]);
    });
}
async function retryTaskValidation(taskId) {
    await runTaskOperation(taskId, async (signal) => {
        const validated = await taskWorkflow.runValidation(taskId, signal);
        await advanceAfterValidation(taskId, validated.state, signal);
    });
}
async function sendTaskMessage(taskId, message) {
    let task = store.getTask(taskId);
    if (!task || !["implementing", "awaiting_input", "awaiting_review", "reviewing", "review_blocked", "awaiting_commit", "await_merge", "validation_failed"].includes(task.state))
        throw new Error("当前任务不能继续 AI 对话");
    addTaskEvent({ taskId, kind: "message", title: "你", detail: message });
    if (task.state === "awaiting_input" && isExplicitNoChangeCompletionRequest(message)) {
        taskWorkflow.completeAtUserRequest(taskId);
        return;
    }
    if (task.state === "awaiting_input")
        task = taskWorkflow.resumeImplementation(taskId);
    else if (task.state !== "implementing")
        task = updateState(task, "implementing");
    store.updateTask(task.id, { reviewStatus: "pending" });
    if (modelProvider() === "qoder") {
        void runTaskOperation(taskId, (signal) => runQoder(taskId, message, signal)).catch((error) => emitPi({ type: "agent_error", taskId, message: error instanceof Error ? error.message : String(error) }));
        return;
    }
    await runTaskOperation(taskId, async (signal) => {
        signal.throwIfAborted();
        if (!piSession || activeTaskId !== taskId)
            await startPi(taskId);
        await piSession.prompt(`${message}\n\n${implementationOutcomeInstruction}`, { source: "rpc", ...(piSession.isStreaming ? { streamingBehavior: "followUp" } : {}) });
    });
}
async function stopTaskOperations(taskId, markFailed) {
    const operation = activeTaskOperations.get(taskId);
    operation?.controller.abort(new Error(markFailed ? "任务已停止" : "任务已删除"));
    const task = store.getTask(taskId);
    if (markFailed && task && ["planning", "implementing", "validating"].includes(task.state))
        updateState(task, "failed");
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
        try {
            await qoderQuery?.interrupt();
        }
        catch { /* The query may already be closed. */ }
        try {
            await qoderQuery?.close();
        }
        catch { /* The query may already be closed. */ }
        await stopPi();
    }
    try {
        await operation?.promise;
    }
    catch { /* Cancellation is expected while removing a task. */ }
}
async function removeTaskWorkspace(taskId, repositories) {
    const git = gitService;
    for (const repo of repositories) {
        if (!repo.worktreePath)
            continue;
        try {
            await git.removeWorktree(repo.localPath, repo.worktreePath);
        }
        catch {
            rmSync(repo.worktreePath, { recursive: true, force: true });
        }
    }
    rmSync(taskWorkspace(taskId), { recursive: true, force: true });
    rmSync(join(dataDir, "worktrees", taskId), { recursive: true, force: true });
    for (const localPath of new Set(repositories.map((repo) => repo.localPath))) {
        try {
            await git.pruneWorktrees(localPath);
        }
        catch { /* The source repository may no longer exist. */ }
    }
}
async function deleteTask(taskId, mode = "all") {
    if (mode !== "workspace" && mode !== "all")
        throw new Error("不支持的任务清理方式");
    const task = store.getTask(taskId);
    if (!task)
        throw new Error("Task not found");
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
        const preservedStates = new Set(["draft", "failed", "completed", "await_merge", "cancelled"]);
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
    if (activeTaskId === taskId)
        activeTaskId = undefined;
}
async function taskChangedFiles(taskId, ignoreErrors = true) {
    const git = gitService;
    const groups = await Promise.all(store.listTaskRepositories(taskId).map(async (repo) => {
        if (repo.deliveryStatus === "workspace_removed")
            return [];
        try {
            const files = await git.changedFiles(repo.worktreePath ?? repo.localPath, repo.baseBranch);
            return files.map((file) => ({ repositoryId: repo.repositoryId, repositoryName: repo.name, ...file }));
        }
        catch (error) {
            if (!ignoreErrors)
                throw error;
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
                if (!repo)
                    return repository;
                if (repo.deliveryStatus === "workspace_removed")
                    return repository;
                try {
                    const changedFiles = await gitService.changedFiles(repo.worktreePath ?? repo.localPath, repo.baseBranch);
                    return { ...repository, changedFileCount: changedFiles.length };
                }
                catch {
                    return repository;
                }
            }))
        };
    }));
}
async function openEditorForTask(taskId, editor) {
    if (!["vscode", "qoder"].includes(editor))
        throw new Error("不支持的编辑器");
    const paths = store.listTaskRepositories(taskId).map((repo) => repo.worktreePath ?? repo.localPath);
    await openTaskEditor(editor, paths);
}
async function* holdQoderProbe(signal) {
    if (signal.aborted)
        return;
    await new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
async function getQoderStatus() {
    const token = protectedValue("qoderToken");
    if (modelProvider() !== "qoder" || !token)
        return { enabled: false, connected: false, running: false, models: [] };
    const probeAbort = activeQoderQuery ? undefined : new AbortController();
    const q = activeQoderQuery ?? query({
        prompt: holdQoderProbe(probeAbort.signal),
        options: { auth: accessToken(token), cwd: process.cwd(), abortController: probeAbort, persistSession: false, controlRequestTimeoutMs: 15_000 }
    });
    try {
        const initialization = await q.initializationResult();
        const usage = await q.getUsageInfo();
        let models = initialization.models;
        try {
            models = await q.getAvailableModels({ fetchStrategy: "cache" });
        }
        catch { /* Initialization models are a valid fallback for older runtimes. */ }
        return {
            enabled: true, connected: true, running: Boolean(activeQoderQuery),
            account: initialization.account, usage,
            models: models.filter((model) => model.isEnabled !== false).map(({ value, displayName, description, isDefault, isEnabled, isReasoning, isVl, priceFactor }) => ({ value, displayName, description, isDefault, isEnabled, isReasoning, isVl, priceFactor }))
        };
    }
    catch (error) {
        return { enabled: true, connected: false, running: Boolean(activeQoderQuery), models: [], error: error instanceof Error ? error.message : String(error) };
    }
    finally {
        if (probeAbort) {
            probeAbort.abort();
            try {
                await q.close();
            }
            catch { /* The probe may already be closed after an initialization failure. */ }
        }
    }
}
// === IPC 路由(全部保留) =======================================================
function registerIpc() {
    ipcMain.handle("tasks:list", async () => { await mergeRefresher.refresh(); return taskCardsWithCurrentChanges(); });
    ipcMain.handle("tasks:get", async (_event, id) => { await mergeRefresher.refresh(); return { task: store.getTask(id), repositories: store.listTaskRepositories(id), events: store.listEvents(id), approvals: store.listApprovals(id), changedFiles: await taskChangedFiles(id) }; });
    ipcMain.handle("tasks:create", (_event, input) => store.createTask(input));
    ipcMain.handle("tasks:update", (_event, id, patch) => store.updateTask(id, patch));
    ipcMain.handle("tasks:delete", (_event, id, mode) => deleteTask(id, mode));
    ipcMain.handle("repos:list", () => store.listRepositoryProfiles());
    ipcMain.handle("repos:save", (_event, profile) => store.saveRepositoryProfile(profile));
    ipcMain.handle("repos:delete", (_event, id) => store.deleteRepositoryProfile(id));
    ipcMain.handle("repos:choose-folder", async () => {
        const localPath = (await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })).filePaths[0];
        if (!localPath)
            return undefined;
        try {
            const info = await gitService.inspectRepository(localPath);
            return { name: basename(info.rootPath), localPath: info.rootPath, remoteUrl: info.remoteUrl, defaultBranch: info.currentBranch };
        }
        catch {
            throw new Error("仓库异常:所选目录不是有效的 Git 仓库,或当前未检出分支");
        }
    });
    ipcMain.handle("tasks:attach-repo", (_event, taskId, repositoryId) => store.attachRepository(taskId, repositoryId));
    ipcMain.handle("tasks:detach-repo", (_event, taskId, repositoryId) => store.detachRepository(taskId, repositoryId));
    ipcMain.handle("settings:get", (_event, key) => ["jiraToken", "confluenceToken", "qoderToken", "modelApiKey", "gitlabToken"].includes(key) ? (store.getSetting(key) ? "__configured__" : undefined) : store.getSetting(key));
    ipcMain.handle("settings:set", (_event, key, value, secret = false) => {
        store.setSetting(key, secret ? keyStore.protect(value, key) : value);
        if (key === "modelProfile")
            syncPiModelConfig(value);
    });
    ipcMain.handle("tasks:start", (_event, taskId, options) => startTask(taskId, options));
    ipcMain.handle("tasks:reimplement", (_event, taskId) => taskWorkflow.reimplement(taskId));
    ipcMain.handle("tasks:approve-plan", (_event, taskId) => approveTaskPlan(taskId));
    ipcMain.handle("tasks:revise-plan", (_event, taskId, feedback) => reviseTaskPlan(taskId, feedback));
    ipcMain.handle("tasks:retry-validation", (_event, taskId) => retryTaskValidation(taskId));
    ipcMain.handle("tasks:message", (_event, taskId, message) => sendTaskMessage(taskId, message));
    ipcMain.handle("tasks:abort", () => activeTaskId ? stopTaskOperations(activeTaskId, true) : undefined);
    ipcMain.handle("tasks:review", (_event, taskId) => runTaskOperation(taskId, (signal) => taskWorkflow.runReview(taskId, buildReviewOrchestrator(), signal)));
    ipcMain.handle("tasks:reset-review", (_event, taskId) => taskWorkflow.resetReview(taskId));
    ipcMain.handle("tasks:reset-delivery", (_event, taskId) => deliveryService.resetDelivery(taskId));
    ipcMain.handle("tasks:submit-mrs", (_event, taskId) => runTaskOperation(taskId, (signal) => deliveryService.submitMergeRequests(taskId, signal)));
    ipcMain.handle("tasks:refresh-merge-status", () => mergeRefresher.refresh());
    ipcMain.handle("tasks:manual-complete", (_event, taskId) => taskCompleter.manualComplete(taskId));
    ipcMain.handle("tasks:open-editor", (_event, taskId, editor) => openEditorForTask(taskId, editor));
    ipcMain.handle("qoder:status", () => getQoderStatus());
    // 用系统默认浏览器打开 URL(避免在 Electron 内嵌窗口中 target=_blank 开新 BrowserWindow)。
    // 只放行 http(s),防止被注入 file:// / 命令协议等本地 scheme。
    ipcMain.handle("shell:open-external", async (_event, url) => {
        if (typeof url !== "string")
            throw new Error("url 必须是字符串");
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            throw new Error("无效的 URL");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
            throw new Error("仅支持 http(s) 链接");
        await shell.openExternal(parsed.toString());
    });
    ipcMain.handle("jira:import", async (_event, keyOrUrl) => safeAtlassianCall("导入 Jira Issue", () => importJiraIssue(atlassianFactory.create("jira"), keyOrUrl, store)));
    ipcMain.handle("jira:sync", async () => safeAtlassianCall("同步 Jira 任务", () => fetchJiraTasks(atlassianFactory.create("jira"))));
    ipcMain.handle("jira:import-many", (_event, candidates) => {
        const tasks = candidates.flatMap((candidate) => {
            const taskKey = typeof candidate.taskKey === "string" ? candidate.taskKey.trim().toUpperCase() : "";
            const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
            if (!taskKey || !title)
                return [];
            return [store.upsertJiraTask({ taskKey, source: "jira", sourceUrl: typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : undefined, title, description: typeof candidate.description === "string" ? candidate.description : "", keywords: Array.isArray(candidate.keywords) ? candidate.keywords.map(String) : [], acceptanceCriteria: Array.isArray(candidate.acceptanceCriteria) ? candidate.acceptanceCriteria.map(String) : [], state: "draft", reviewStatus: "pending" })];
        });
        if (tasks.length > 0)
            store.setSetting("lastJiraSync", new Date().toISOString());
        return tasks;
    });
    ipcMain.handle("atlassian:test", async (_event, kind) => testAtlassianConnection(atlassianFactory.create(kind)));
    ipcMain.handle("task:ui-response", (_event, response) => pendingUi.get(String(response.id))?.(response));
    // === Chat 对话(Codex 样式) =================================================
    ipcMain.handle("chats:list", () => chatService.listChats());
    ipcMain.handle("chats:get", (_event, id) => chatService.getChat(id));
    ipcMain.handle("chats:create", (_event, model) => chatService.createChat(model));
    ipcMain.handle("chats:delete", (_event, id) => chatService.deleteChat(id));
    ipcMain.handle("chats:list-models", () => chatService.listModels());
    ipcMain.handle("chats:start-stream", (_event, input) => {
        void chatService.startChatStream(input).catch((reason) => console.error("[chat] stream failed", reason));
    });
    ipcMain.handle("chats:abort", (_event, input) => chatService.abortChat(input));
}
async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1500, height: 920, minWidth: 900, minHeight: 640, backgroundColor: "#111210",
        titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
        webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false }
    });
    if (process.env.VITE_DEV_SERVER_URL)
        await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    else
        await mainWindow.loadFile(join(__dirname, "../dist/index.html"));
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
app.on("window-all-closed", () => { if (process.platform !== "darwin")
    app.quit(); });
app.on("before-quit", () => { void stopPi(); store.close(); });
//# sourceMappingURL=main.js.map