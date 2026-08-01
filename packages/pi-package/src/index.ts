import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LocalFileKeyStore, TaskStore, type AgentEvent, type McpProfile, type SettingResolver, type Task, type TaskEventSink, type TaskState } from "@coding-agent/core";
import {
  AtlassianClientFactory, DeliveryService, GitService, McpClient, MergeStatusRefresher, OpenAICompatReviewer, OpenCodeReviewService,
  ReviewOrchestrator, syncJiraTasks, TaskCompleter, TaskWorkflow, testAtlassianConnection
} from "@coding-agent/integrations";
import { DockerToolRouter } from "./sandbox.js";
import { evaluatePermission } from "./permission.js";

const dataDir = process.env.CODING_AGENT_DATA_DIR ?? join(homedir(), ".internal-coding-agent");
const store = new TaskStore(join(dataDir, "coding-agent.db"));
const keyStore = new LocalFileKeyStore(dataDir);
const owner = `pi:${process.pid}`;
const sandboxRouter = new DockerToolRouter(store, () => selectedTask(""), process.env.DOCKER_BINARY ?? "docker");

// === 抽象层宿主实现 ===========================================================

/**
 * Pi 端的 TaskEventSink。
 *
 * Pi Extension 没有 IPC 推送通道,这里只把事件落库,前端通过下次拉取
 * `tasks:list` / `tasks:get` 时拿到最新状态。`emitChanged` 留空,
 * 需要时宿主可以扩展为通过 `ctx.ui.notify` 提示用户刷新。
 */
class PiEventSink implements TaskEventSink {
  addEvent(input: Omit<AgentEvent, "id" | "createdAt">): AgentEvent { return store.addEvent(input); }
  emitChanged(_taskId: string): void { /* Pi 无 IPC,依赖下次拉取;保留空实现便于接口契约 */ }
}

/** Pi 端的 SettingResolver:读 setting + 解密 secret,语义与 desktop 一致。 */
class PiSettingResolver implements SettingResolver {
  get(key: string): string | undefined { return store.getSetting(key); }
  getSecret(key: string, envName?: string): string | undefined {
    if (envName && process.env[envName]) return process.env[envName];
    return keyStore.resolve(store.getSetting(key), key);
  }
}

const piSink = new PiEventSink();
const piResolver = new PiSettingResolver();
const gitService = new GitService();
const ocrService = new OpenCodeReviewService(store.getSetting("ocrBinary") ?? process.env.OCR_BINARY ?? "ocr");
const openAIReviewer = new OpenAICompatReviewer(piResolver);
function buildReviewOrchestrator(): ReviewOrchestrator {
  return new ReviewOrchestrator({ ocr: ocrService, git: gitService, reviewer: openAIReviewer }, piSink);
}
const taskWorkflow = new TaskWorkflow(store, piResolver, piSink, (taskId) => join(dataDir, "workspaces", taskId));
const mergeRefresher = new MergeStatusRefresher(store, piResolver, piSink);
const taskCompleter = new TaskCompleter(store, piSink);
const atlassianFactory = new AtlassianClientFactory(piResolver);

/**
 * 把解密后的 token 注入到 McpProfile.env,使 McpClient 内部
 * `this.env[this.profile.tokenEnv]` 能拿到。注意不能改 tokenEnv 自身,
 * McpClient 内部会通过 env[tokenEnv] 取值,所以这里把 token 写入 env 即可。
 */
function buildJiraClient(profile: McpProfile): McpClient {
  const token = configuredSecret("jiraToken", profile.tokenEnv);
  if (!token) return new McpClient(profile);
  const envName = profile.tokenEnv ?? "JIRA_TOKEN";
  return new McpClient({ ...profile, env: { ...profile.env, [envName]: token } });
}

/**
 * Pi 端的 DeliveryService 实例。
 * 每次调用都新建一个,因为要注入 `ctx.ui.confirm` 作为 approver。
 */
function buildDeliveryService(ctx: { ui: { confirm(title: string, message: string): Promise<boolean> } }): DeliveryService {
  return new DeliveryService(store, gitService, piResolver, piSink, {
    approver: async (task, kind, context) => {
      const approval = store.addApproval({ taskId: task.id, kind, context });
      const accepted = await ctx.ui.confirm("业务节点确认", context);
      store.resolveApproval(approval.id, accepted ? "approved" : "rejected");
      return accepted;
    }
  });
}

function selectedTask(args: string): Task | undefined {
  const id = args.trim() || store.getSetting("activeTaskId") || "";
  return id ? store.getTask(id) : undefined;
}

function setState(task: Task, state: TaskState): Task {
  const updated = store.updateTask(task.id, { state });
  store.addEvent({ taskId: task.id, kind: "status", title: `状态更新为 ${state}` });
  return updated;
}

function configuredSecret(settingKey: string, envName?: string): string | undefined {
  if (envName && process.env[envName]) return process.env[envName];
  return keyStore.resolve(store.getSetting(settingKey), settingKey);
}

async function approve(task: Task, kind: Parameters<TaskStore["addApproval"]>[0]["kind"], context: string, ctx: { ui: { confirm(title: string, message: string): Promise<boolean> } }): Promise<boolean> {
  const approval = store.addApproval({ taskId: task.id, kind, context });
  const accepted = await ctx.ui.confirm("业务节点确认", context);
  store.resolveApproval(approval.id, accepted ? "approved" : "rejected");
  return accepted;
}

export default function codingAgentExtension(pi: ExtensionAPI) {
  let toolsBeforePlanning: string[] | undefined;
  sandboxRouter.register(pi, process.cwd());
  pi.on("session_start", async (_event, ctx) => {
    const mode = await sandboxRouter.check();
    store.setSetting("sandboxStatus", mode);
    const task = selectedTask("");
    if (task) store.addEvent({
      taskId: task.id,
      kind: "status",
      title: mode === "docker" ? "执行环境：Docker 沙箱" : "执行环境：本机",
      detail: mode === "docker" ? "系统已自动选择 Docker 沙箱" : "Docker 服务不可用，系统已自动回退到本机执行"
    });
  });
  pi.on("session_shutdown", async () => { await sandboxRouter.stop(); });

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    const task = selectedTask("");
    if (task?.state === "planning" && event.toolName === "bash") {
      const command = String(input.command ?? "").trim();
      if (!/^(pwd|ls|find|rg|grep|sed|head|tail|cat|wc|git\s+(status|diff|log|show|branch|rev-parse)\b)/.test(command)) return { block: true, reason: "计划模式只允许只读命令" };
    }
    const roots = task ? store.listTaskRepositories(task.id).map((repo) => resolvePath(repo.worktreePath ?? repo.localPath)) : [];
    const decision = evaluatePermission(event.toolName, input, roots, sandboxRouter.activeCwd(process.cwd()));
    if (decision.action === "allow") return undefined;
    if (decision.action === "block") return { block: true, reason: decision.reason };
    if (!isToolCallEventType("bash", event)) return { block: true, reason: decision.reason };
    const command = event.input.command;
    if (!ctx.hasUI) return { block: true, reason: "受保护命令在无交互模式下默认拒绝" };
    const allowed = await ctx.ui.confirm("受保护命令", `${command}\n\n确认执行？`);
    if (!allowed) return { block: true, reason: "用户拒绝执行" };
    if (task) store.addEvent({ taskId: task.id, kind: "permission", title: "已批准受保护命令", detail: command });
    return undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    const task = selectedTask("");
    if (!task || task.state !== "planning") return;
    const last = [...event.messages].reverse().find((message: any) => message?.role === "assistant") as any;
    const plan = last?.content?.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("\n").trim();
    if (!plan) return;
    if (/"outcome"\s*:\s*"already_satisfied"|无需(?:任何)?(?:代码)?修改|代码已满足|already satisfied|no (?:code )?changes? (?:are )?required/i.test(plan)) {
      taskWorkflow.completeWithoutChanges(task.id, plan);
      if (toolsBeforePlanning) pi.setActiveTools(toolsBeforePlanning);
      toolsBeforePlanning = undefined;
      ctx.ui.notify("代码已满足任务要求，任务已自动完成", "info");
      return;
    }
    taskWorkflow.setPlan(task.id, plan);
    const choice = await ctx.ui.select("计划已生成", ["批准并开始", "补充意见并重新生成", "稍后确认"]);
    if (choice === "批准并开始") {
      const approval = store.addApproval({ taskId: task.id, kind: "plan", context: plan });
      store.resolveApproval(approval.id, "approved");
      await taskWorkflow.approvePlan(task.id);
      if (toolsBeforePlanning) pi.setActiveTools(toolsBeforePlanning);
      toolsBeforePlanning = undefined;
      pi.sendUserMessage(`按已批准计划实现任务：\n\n${plan}`, { deliverAs: "followUp" });
    } else if (choice === "补充意见并重新生成") {
      const feedback = await ctx.ui.editor("计划调整意见", "");
      if (feedback?.trim()) {
        taskWorkflow.revisePlan(task.id);
        pi.sendUserMessage(`根据以下意见重新生成完整计划，仍然禁止修改文件：\n\n${feedback.trim()}`, { deliverAs: "followUp" });
      }
    }
  });

  pi.registerCommand("tasks", {
    description: "查看 Todo、InProgress、InReview 和 Done 任务",
    handler: async (_args, ctx) => {
      const cards = store.listCards();
      const text = [
        `Todo：${cards.filter((task) => task.boardColumn === "todo").length}`,
        `InProgress：${cards.filter((task) => task.boardColumn === "in_progress").length}`,
        `InReview：${cards.filter((task) => task.boardColumn === "in_review").length}`,
        `Done：${cards.filter((task) => task.boardColumn === "done").length}`,
        "",
        ...store.listTasks().map((task) => `${task.id.slice(0, 8)}  [${task.state}] ${task.jiraKey ?? "LOCAL"} ${task.title}`)
      ].join("\n");
      ctx.ui.notify(text, "info");
    }
  });

  pi.registerCommand("task-open", {
    description: "打开并编辑任务：/task-open <task-id>",
    handler: async (args, ctx) => {
      const task = selectedTask(args);
      if (!task) return ctx.ui.notify("找不到任务", "error");
      store.setSetting("activeTaskId", task.id);
      const description = await ctx.ui.editor(`编辑 ${task.jiraKey ?? task.id.slice(0, 8)}：${task.title}`, task.description);
      if (description !== undefined && description !== task.description) store.updateTask(task.id, { description });
      ctx.ui.notify(`当前任务：${task.title}`, "info");
    }
  });

  pi.registerCommand("task-start", {
    description: "确认并开始任务：/task-start <task-id>",
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting("activeTaskId") || "";
      if (!taskId) return ctx.ui.notify("找不到任务", "error");
      let task = store.getTask(taskId);
      if (!task) return ctx.ui.notify("找不到任务", "error");
      if (!store.acquireLease(task.id, owner, 120_000)) return ctx.ui.notify("任务正在另一个 Pi/GUI 会话中运行", "warning");
      if (task.state === "draft") {
        const approved = await ctx.ui.confirm("确认任务", `${task.title}\n\n${task.description}`);
        if (!approved) { store.releaseLease(task.id, owner); return; }
        task = setState(task, "confirmed");
      }
      const selection = await ctx.ui.select("启动方式", ["直接开始", "先生成计划"]);
      if (!selection) { store.releaseLease(task.id, owner); return; }
      const mode = selection === "先生成计划" ? "plan" : "direct";
      try { await taskWorkflow.begin(task.id, mode); }
      catch (error) { store.releaseLease(task.id, owner); return ctx.ui.notify(`准备环境失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
      store.setSetting("activeTaskId", task.id);
      if (mode === "plan") {
        toolsBeforePlanning = pi.getActiveTools();
        pi.setActiveTools(toolsBeforePlanning.filter((name) => !["write", "edit", "apply_patch", "notebookedit"].includes(name.toLowerCase())));
        pi.sendUserMessage(`只读分析任务，禁止修改文件或执行会改变工作区的命令。最终只输出 JSON：无需修改时输出 {"outcome":"already_satisfied","summary":"判断依据"}；需要修改时输出 {"outcome":"changes_required","plan":"完整实施计划"}。\n\n${task.title}\n\n${task.description}`, { deliverAs: "followUp" });
        ctx.ui.notify("已进入计划模式", "info");
      } else {
        pi.sendUserMessage(`开始实现任务：\n\n${task.title}\n\n${task.description}`, { deliverAs: "followUp" });
        ctx.ui.notify("worktree 与准备命令已完成，开始实现。", "info");
      }
    }
  });

  pi.registerCommand("review", {
    description: "对当前任务运行 Open Code Review（委托模式：ocr rule + LLM）",
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting("activeTaskId") || "";
      if (!taskId) return ctx.ui.notify("没有活动任务", "error");
      try {
        await taskWorkflow.runReview(taskId, buildReviewOrchestrator());
        const task = store.getTask(taskId);
        if (!task) return;
        if (task.reviewStatus === "blocked") ctx.ui.notify("Review 存在阻断问题", "warning");
        else if (task.reviewStatus === "passed") ctx.ui.notify("Review 已通过", "info");
      } catch (error) {
        ctx.ui.notify(`Review 失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });

  pi.registerCommand("task-reset-review", {
    description: "重置 review 状态（reviewing → review_blocked）",
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting("activeTaskId") || "";
      if (!taskId) return ctx.ui.notify("找不到任务", "error");
      try { taskWorkflow.resetReview(taskId); ctx.ui.notify("review 状态已重置", "info"); }
      catch (error) { ctx.ui.notify(`重置失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
    }
  });

  pi.registerCommand("jira-sync", {
    description: "通过已配置的 Jira MCP 同步任务",
    handler: async (_args, ctx) => {
      const raw = store.getSetting("jiraMcpProfile");
      if (!raw) return ctx.ui.notify("请先在 GUI 设置 Jira MCP Profile", "warning");
      const profile = JSON.parse(raw) as McpProfile;
      // 委托给下沉的 syncJiraTasks,逻辑与 desktop 一致(分页 / status 字段映射 / lastJiraSync 设置)
      const client = buildJiraClient(profile);
      try {
        const tasks = await syncJiraTasks(client, store);
        ctx.ui.notify(`Jira MCP 同步完成：已更新 ${tasks.length} 个任务`, "info");
      } catch (error) {
        ctx.ui.notify(`Jira 同步失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });

  pi.registerCommand("jira-test", {
    description: "测试当前 Jira MCP 配置是否可用",
    handler: async (_args, ctx) => {
      const client = atlassianFactory.create("jira");
      try {
        const result = await testAtlassianConnection(client);
        ctx.ui.notify(result.message, result.ok ? "info" : "error");
      } catch (error) {
        ctx.ui.notify(`连接失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });

  pi.registerCommand("deliver", {
    description: "提交并交付当前任务（commit --no-verify + push 90s + GitLab MR）",
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting("activeTaskId") || "";
      if (!taskId) return ctx.ui.notify("没有活动任务", "error");
      const task = store.getTask(taskId);
      if (!task) return ctx.ui.notify("没有活动任务", "error");
      if (task.state !== "awaiting_commit") return ctx.ui.notify(`当前状态 ${task.state} 不允许交付`, "warning");
      const gitlabProfile = gitlabProfileFromStore();
      if (!gitlabProfile?.baseUrl) return ctx.ui.notify("GitLab 配置不完整：缺少实例地址", "error");
      const token = configuredSecret("gitlabToken", gitlabProfile.tokenEnv);
      if (!token) return ctx.ui.notify("GitLab Token 未通过环境变量或加密配置提供", "error");
      const delivery = buildDeliveryService(ctx);
      try {
        await delivery.submitMergeRequests(taskId);
        const updated = store.getTask(taskId);
        if (updated?.state === "await_merge") ctx.ui.notify("交付完成", "info");
        else ctx.ui.notify(`任务已退到 ${updated?.state}`, "warning");
      } catch (error) {
        ctx.ui.notify(`提交失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });

  pi.registerCommand("task-reset-delivery", {
    description: "重置提交 MR 状态（delivering → awaiting_commit）",
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting("activeTaskId") || "";
      if (!taskId) return ctx.ui.notify("找不到任务", "error");
      try { (new DeliveryService(store, gitService, piResolver, piSink)).resetDelivery(taskId); ctx.ui.notify("提交状态已重置", "info"); }
      catch (error) { ctx.ui.notify(`重置失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
    }
  });

  pi.registerCommand("task-manual-complete", {
    description: "手动结束 await_merge 任务（跳过未合并 MR）",
    handler: async (args, ctx) => {
      const taskId = args.trim() || store.getSetting("activeTaskId") || "";
      if (!taskId) return ctx.ui.notify("找不到任务", "error");
      try { taskCompleter.manualComplete(taskId); ctx.ui.notify("任务已手动结束", "info"); }
      catch (error) { ctx.ui.notify(`手动结束失败：${error instanceof Error ? error.message : String(error)}`, "error"); }
    }
  });

  pi.registerCommand("task-refresh-mr", {
    description: "刷新所有 await_merge 任务的 MR 状态",
    handler: async (_args, ctx) => {
      try {
        const results = await mergeRefresher.refresh();
        const merged = results.filter((r) => r.taskCompleted).length;
        ctx.ui.notify(`刷新完成：${results.length} 个任务,${merged} 个已自动完成`, "info");
      } catch (error) {
        ctx.ui.notify(`刷新失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });

  pi.registerCommand("task-resume", {
    description: "恢复失败或暂停的任务",
    handler: async (args, ctx) => {
      const task = selectedTask(args);
      if (!task) return ctx.ui.notify("找不到任务", "error");
      if (!store.acquireLease(task.id, owner, 120_000)) return ctx.ui.notify("任务已被占用", "warning");
      store.setSetting("activeTaskId", task.id);
      ctx.ui.notify(`已恢复 ${task.title}`, "info");
    }
  });

  pi.registerCommand("task-cancel", {
    description: "取消当前任务并释放租约",
    handler: async (args, ctx) => {
      const task = selectedTask(args);
      if (!task) return ctx.ui.notify("找不到任务", "error");
      const approved = await ctx.ui.confirm("取消任务", "将停止执行并保留 worktree。确认取消？");
      if (!approved) return;
      if (!["completed", "cancelled"].includes(task.state)) store.updateTask(task.id, { state: "cancelled" });
      store.releaseLease(task.id, owner);
      ctx.ui.notify("任务已取消，worktree 已保留", "info");
    }
  });
}

function gitlabProfileFromStore(): { baseUrl: string; tokenEnv?: string } | undefined {
  const raw = store.getSetting("gitlabProfile");
  if (!raw) return undefined;
  return JSON.parse(raw) as { baseUrl: string; tokenEnv?: string };
}
