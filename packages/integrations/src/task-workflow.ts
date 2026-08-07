import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryProfile, SettingResolver, Task, TaskEventSink, TaskRepository, TaskStartMode, TaskState, TaskStore } from "@coding-agent/core";
import { isReviewable, resolveTaskSetting, transitionTask } from "@coding-agent/core";
import { GitService } from "./git.js";
import { runShell, type ShellRunner } from "./process.js";
import type { ReviewOrchestrator } from "./review-orchestrator.js";

export type RepositoryCommandOverrides = Partial<Pick<TaskRepository, "setupCommand" | "lintCommand" | "testCommand" | "buildCommand">>;
export type RepositoryCommandMap = Record<string, RepositoryCommandOverrides>;

/**
 * 生成测试用例的执行器接口。
 *
 * 由宿主（desktop 端）注入。可跑 Qoder / OpenAI Agent，
 * 提示词要求只写测试文件，不改业务逻辑。
 */
export type TestCaseGenerator = (task: Task, signal?: AbortSignal) => Promise<{ files: string[]; commitSha?: string; summary: string }>;

/**
 * 任务工作流封装。
 *
 * - `prepare(taskId)`:`draft -> confirmed -> preparing -> implementing`,
 *   自动创建 worktree、feature branch,等用户开始修改代码。
 * - `runReview(taskId, orchestrator)`:从 `implementing / awaiting_review / review_blocked` 触发,
 *   走完 review 流程,异常时回 `review_blocked`,通过时回 `awaiting_commit`。
 * - `resetReview(taskId)`:`reviewing -> review_blocked` 重置,清理 `reviewStatus`。
 * - `autoCreateMergeRequests(taskId)`:review 通过后自动调用 DeliveryService 提交 MR。
 */
export class TaskWorkflow {
  constructor(
    private readonly store: TaskStore,
    private readonly resolver: SettingResolver,
    private readonly sink: TaskEventSink,
    private readonly worktreeRootFor: (taskId: string) => string,
    private readonly reviewEnabled: () => boolean = () => this.resolver.get("openCodeReviewEnabled") === "true",
    private readonly autoCreateMergeRequests: () => boolean = () => this.resolver.get("autoCreateMergeRequests") === "true",
    private readonly shell: ShellRunner = runShell,
    private readonly git: GitService = new GitService(),
    /**
     * 仅在「系统设置 / 任务级覆盖」需要直接读取布尔时使用。
     * 大多数情况下应通过 `shouldGenerateTestCasesFor(task)` 走任务级优先 + 系统级兜底。
     */
    private readonly testCasesEnabled: () => boolean = () => this.resolver.get("createTestCasesEnabled") === "true",
    /**
     * 测试用例生成执行器。宿主（desktop 端）注入。
     * 保留可选；不传时 `beginTestCaseGeneration` 仍然可以走状态，但需要宿主自己跑 LLM。
     */
    private readonly testCaseGenerator?: TestCaseGenerator
  ) {}

  /** 状态机辅助:推进到指定 state,内部用 `transitionTask` 校验。 */
  private transitionTo(taskId: string, to: TaskState): Task {
    const current = this.store.getTask(taskId);
    if (!current) throw new Error("Task not found");
    if (current.state !== to) transitionTask(current.state, to);
    const updated = this.store.updateTask(taskId, { state: to });
    this.sink.addEvent({ taskId, kind: "status", title: `状态更新为 ${to}` });
    return updated;
  }

  private profiles(): Map<string, RepositoryProfile> {
    return new Map(this.store.listRepositoryProfiles().map((profile) => [profile.id, profile]));
  }

  private snapshotCommands(taskId: string, overrides: RepositoryCommandMap = {}): void {
    const profiles = this.profiles();
    for (const repo of this.store.listTaskRepositories(taskId)) {
      const profile = profiles.get(repo.repositoryId);
      const override = overrides[repo.repositoryId] ?? overrides[repo.id] ?? {};
      const command = (key: keyof RepositoryCommandOverrides) =>
        Object.prototype.hasOwnProperty.call(override, key) ? override[key] : profile?.[key] ?? repo[key];
      this.store.updateTaskRepository(repo.id, {
        setupCommand: command("setupCommand"),
        lintCommand: command("lintCommand"),
        testCommand: command("testCommand"),
        buildCommand: command("buildCommand")
      });
    }
  }

  private markRepositoriesUnchanged(taskId: string): void {
    for (const repo of this.store.listTaskRepositories(taskId)) {
      this.store.updateTaskRepository(repo.id, { deliveryStatus: "unchanged" });
    }
  }

  private async prepareWorktree(taskId: string, signal?: AbortSignal): Promise<Task> {
    let task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.state === "draft") task = this.transitionTo(taskId, "confirmed");
    if (task.state === "confirmed") task = this.transitionTo(taskId, "preparing");
    if (task.state !== "preparing") return task;
    const root = this.worktreeRootFor(taskId);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    const usedEntries = new Set<string>();
    for (const repo of this.store.listTaskRepositories(taskId)) {
      const base = repo.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "repository";
      const entry = usedEntries.has(base) ? `${base}-${repo.repositoryId.slice(0, 8)}` : base;
      usedEntries.add(entry);
      if (repo.worktreePath && repo.featureBranch) continue;
      const preferredBranch = task.taskKey?.trim() || task.id.slice(0, 8);
      signal?.throwIfAborted();
      const { path: worktreePath, branch } = await this.git.createTaskWorktree(repo.localPath, root, preferredBranch, repo.baseBranch, entry, signal);
      signal?.throwIfAborted();
      this.store.updateTaskRepository(repo.id, { featureBranch: branch, worktreePath, deliveryStatus: "pending" });
    }
    return this.store.getTask(taskId)!;
  }

  async begin(taskId: string, mode: TaskStartMode, overrides: RepositoryCommandMap = {}, signal?: AbortSignal): Promise<Task> {
    this.snapshotCommands(taskId, overrides);
    let current = this.store.getTask(taskId);
    if (!current) throw new Error("Task not found");
    const repositories = this.store.listTaskRepositories(taskId);
    if (current.state === "failed" && repositories.some((repo) => !repo.worktreePath || !repo.featureBranch)) {
      current = this.transitionTo(taskId, "preparing");
    }
    let task: Task;
    try {
      task = await this.prepareWorktree(taskId, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateTask(taskId, { failureStage: "preparing" });
      const failed = this.store.getTask(taskId);
      if (failed && failed.state !== "failed") this.transitionTo(taskId, "failed");
      this.sink.addEvent({ taskId, kind: "error", title: "任务环境准备失败", detail: message });
      throw new Error(`准备任务环境失败：${message}`, { cause: error });
    }
    this.store.updateTask(taskId, { startMode: mode, failureStage: undefined });
    if (mode === "plan") return this.transitionTo(taskId, "planning");
    if (task.state !== "preparing" && task.state !== "failed") return task;
    return this.runSetup(taskId, false, signal);
  }

  setPlan(taskId: string, content: string): Task {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "planning") throw new Error("当前任务不在计划生成状态");
    this.store.updateTask(taskId, { planContent: content, planRevision: (task.planRevision ?? 0) + 1 });
    return this.transitionTo(taskId, "awaiting_plan_approval");
  }

  completeWithoutChanges(taskId: string, content: string): Task {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "planning") throw new Error("当前任务不在计划生成状态");
    this.store.updateTask(taskId, { planContent: content, planRevision: (task.planRevision ?? 0) + 1, summary: "代码已满足任务要求，无需修改" });
    this.sink.addEvent({ taskId, kind: "status", title: "代码已满足要求，任务自动完成", detail: content });
    const completed = this.transitionTo(taskId, "completed");
    this.markRepositoriesUnchanged(taskId);
    return completed;
  }

  completeImplementationWithoutChanges(taskId: string, content: string): Task {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "implementing") throw new Error("当前任务不在实现状态");
    // Direct implementation normally cannot skip validation/review. This is the
    // narrow exception for an agent-confirmed, host-verified zero-change result.
    const updated = this.store.updateTask(taskId, { state: "completed", summary: "代码已满足任务要求，无需修改" });
    this.markRepositoriesUnchanged(taskId);
    this.sink.addEvent({ taskId, kind: "status", title: "代码已满足要求，任务自动完成", detail: content });
    this.sink.addEvent({ taskId, kind: "status", title: "状态更新为 completed" });
    return updated;
  }

  awaitInput(taskId: string, content: string): Task {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "implementing") throw new Error("当前任务不在实现状态");
    this.sink.addEvent({ taskId, kind: "status", title: "等待补充任务信息", detail: content });
    return this.transitionTo(taskId, "awaiting_input");
  }

  resumeImplementation(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "awaiting_input") throw new Error("当前任务不在等待补充状态");
    return this.transitionTo(taskId, "implementing");
  }

  completeAtUserRequest(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "awaiting_input") throw new Error("当前任务不在等待补充状态");
    transitionTask(task.state, "completed");
    const updated = this.store.updateTask(taskId, {
      state: "completed",
      summary: "用户确认无需修改，任务已完成",
      reviewStatus: "waived"
    });
    this.markRepositoriesUnchanged(taskId);
    this.sink.addEvent({ taskId, kind: "status", title: "用户确认无需修改，任务已完成" });
    return updated;
  }

  revisePlan(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "awaiting_plan_approval") throw new Error("当前任务没有待确认计划");
    return this.transitionTo(taskId, "planning");
  }

  async approvePlan(taskId: string, signal?: AbortSignal): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "awaiting_plan_approval") throw new Error("当前任务没有待确认计划");
    return this.runSetup(taskId, true, signal);
  }

  async runSetup(taskId: string, approvedPlan = false, signal?: AbortSignal): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.state !== "preparing" && !(approvedPlan && task.state === "awaiting_plan_approval") && task.state !== "failed") return task;
    try {
      await this.runCommands(taskId, "setup", signal);
      signal?.throwIfAborted();
      this.store.updateTask(taskId, { failureStage: undefined });
      return this.transitionTo(taskId, "implementing");
    } catch (error) {
      if (signal?.aborted) throw error;
      this.store.updateTask(taskId, { failureStage: "preparing" });
      const failed = this.store.getTask(taskId)!;
      if (failed.state !== "failed") this.transitionTo(taskId, "failed");
      throw error;
    }
  }

  async runValidation(taskId: string, signal?: AbortSignal): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task || !["implementing", "validating", "validation_failed", "generating_tests"].includes(task.state)) throw new Error("当前任务不能运行校验");
    this.transitionTo(taskId, "validating");
    try {
      await this.runCommands(taskId, "validation", signal);
      signal?.throwIfAborted();
      this.store.updateTask(taskId, { failureStage: undefined });
      return this.transitionTo(taskId, "awaiting_review");
    } catch (error) {
      if (signal?.aborted) throw error;
      this.store.updateTask(taskId, { failureStage: "validating" });
      return this.transitionTo(taskId, "validation_failed");
    }
  }

  /**
   * 进入"生成测试用例"阶段。
   *
   * 行为：
   * - 仅当任务处于 `implementing` 时才允许进入。
   * - 状态机:`implementing -> generating_tests`。
   * - 实际生成由注入的 `testCaseGenerator` 执行（宿主 desktop 端实现）。
   * - 生成成功后由调用方在主进程里推进到 `validating`。
   * - 失败由调用方在主进程里回 `failed`。
   *
   * 注意：本方法只负责状态推进和事件写入，不直接调用 LLM。
   * 这样保证 `TaskWorkflow` 不依赖 Qoder SDK，方便在 pi-package 等其他宿主复用。
   */
  beginTestCaseGeneration(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "implementing") throw new Error("当前任务不能生成测试用例");
    return this.transitionTo(taskId, "generating_tests");
  }

  /**
   * 测试用例生成成功后的回调：写 `testsGenerated` 字段并退到 `implementing`，
   * 由调用方继续推进到 `runValidation`。
   */
  finishTestCaseGeneration(taskId: string, info: { files: string[]; commitSha?: string; summary: string }): Task {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "generating_tests") throw new Error("当前任务不在生成测试用例状态");
    this.store.updateTask(taskId, {
      testsGenerated: { files: info.files, commitSha: info.commitSha, finishedAt: new Date().toISOString() }
    });
    this.sink.addEvent({
      taskId,
      kind: "status",
      title: `已生成 ${info.files.length} 个测试用例`,
      detail: info.commitSha ? `commit ${info.commitSha.slice(0, 8)}` : info.summary || undefined
    });
    return this.transitionTo(taskId, "implementing");
  }

  /**
   * 任务级开关辅助：实现完成后是否进入「生成测试用例」阶段。
   * 顺序为 task 字段 → system setting → defaults。
   */
  shouldGenerateTestCases(task: Task | undefined): boolean {
    return resolveTaskSetting(task, "createTestCasesEnabled", this.resolver, "createTestCasesEnabled", false);
  }

  /**
   * 任务级开关辅助：是否在 Review 完成后自动提交 Merge Request。
   */
  shouldAutoCreateMergeRequestsFor(task: Task | undefined): boolean {
    return resolveTaskSetting(task, "autoCreateMergeRequests", this.resolver, "autoCreateMergeRequests", false);
  }

  /**
   * 任务级开关辅助：是否在实现完成后进入 Review。
   */
  isReviewEnabledFor(task: Task | undefined): boolean {
    return resolveTaskSetting(task, "openCodeReviewEnabled", this.resolver, "openCodeReviewEnabled", false);
  }

  private async runCommands(taskId: string, phase: "setup" | "validation", signal?: AbortSignal): Promise<void> {
    for (const repo of this.store.listTaskRepositories(taskId)) {
      const cwd = repo.worktreePath ?? repo.localPath;
      const commands = phase === "setup"
        ? [{ label: "准备", command: repo.setupCommand }]
        : [{ label: "Lint", command: repo.lintCommand }, { label: "Test", command: repo.testCommand }, { label: "Build", command: repo.buildCommand }];
      for (const item of commands) {
        const command = item.command?.trim();
        if (!command) continue;
        this.sink.addEvent({ taskId, kind: "command", title: `${repo.name} ${item.label} 开始`, detail: command });
        try {
          signal?.throwIfAborted();
          const result = await this.shell(command, { cwd, cancelSignal: signal });
          signal?.throwIfAborted();
          const output = typeof result.stdout === "string" ? result.stdout.trim() : undefined;
          this.sink.addEvent({ taskId, kind: "command", title: `${repo.name} ${item.label} 通过`, detail: output || undefined });
        } catch (error) {
          this.sink.addEvent({ taskId, kind: "error", title: `${repo.name} ${item.label} 失败`, detail: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }
    }
  }

  /**
   * 准备任务环境(创建 worktree、feature branch)。
   * 行为兼容 desktop 原 `prepareTask`:
   * - `failed -> implementing`(允许从失败恢复;若 worktree 缺失则先补建)
   * - `draft -> confirmed -> preparing`
   * - `preparing` 创建 worktree,然后到 `implementing`
   * - 其他状态直接返回当前 task
   */
  async prepare(taskId: string, signal?: AbortSignal): Promise<Task> {
    let task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const repos = this.store.listTaskRepositories(taskId);
    if (task.state === "failed" && repos.some((repo) => !repo.worktreePath || !repo.featureBranch)) {
      task = this.transitionTo(taskId, "preparing");
    }
    if (task.state === "failed") task = this.transitionTo(taskId, "implementing");
    if (["draft", "confirmed", "preparing"].includes(task.state)) task = await this.prepareWorktree(taskId, signal);
    if (task.state === "preparing") task = this.transitionTo(taskId, "implementing");
    return task;
  }

  /**
   * 走完 review 流程。
   *
   * 行为(沿用 desktop 原 `runTaskReview`):
   * - `reviewing && reviewStatus === "running"` 时跳过,避免重入。
   * - `implementing -> awaiting_review -> reviewing`,`review_blocked -> reviewing`。
   * - 每个仓库调 `orchestrator.run`,阻断判定用 `orchestrator.isBlocking`。
   * - 全部仓库通过:`reviewStatus: passed`,`state: awaiting_commit`。
   * - 有阻断:`reviewStatus: blocked`,`state: review_blocked`。
   * - 异常:`reviewStatus: blocked`,`state: review_blocked`,不冒泡(便于调用方在 IPC 边界吞掉)。
   */
  async runReview(taskId: string, orchestrator: ReviewOrchestrator, signal?: AbortSignal): Promise<void> {
    let task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.state === "reviewing" && task.reviewStatus === "running") {
      this.sink.addEvent({ taskId, kind: "status", title: "review 已在进行中,跳过重复触发", detail: "如需重试请先调用 resetReview 重置状态" });
      return;
    }
    if (!isReviewable(task.state)) throw new Error(`当前状态 ${task.state} 不能运行 review`);
    if (task.state === "implementing") task = this.transitionTo(taskId, "awaiting_review");
    if (task.state === "awaiting_review" || task.state === "review_blocked") task = this.transitionTo(taskId, "reviewing");
    this.store.updateTask(taskId, { reviewStatus: "running" });
    this.sink.addEvent({ taskId, kind: "status", title: "开始 review", detail: `覆盖 ${this.store.listTaskRepositories(taskId).length} 个仓库` });
    let blocked = false;
    try {
      for (const repo of this.store.listTaskRepositories(taskId)) {
        signal?.throwIfAborted();
        const result = await orchestrator.run(task, repo, signal);
        const blocking = result.comments.filter((comment) => orchestrator.isBlockingComment(comment));
        blocked ||= blocking.length > 0;
        this.sink.addEvent({ taskId, kind: "review", title: `${repo.name}: ${result.comments.length} 条评审意见`, detail: blocking.length ? `${blocking.length} 条阻断问题` : "评审通过", payload: result });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack ? `\n${error.stack.split("\n").slice(0, 5).join("\n")}` : "";
      this.sink.addEvent({ taskId, kind: "error", title: "委托模式 Review 执行失败", detail: `${message}${stack}` });
      console.error(`[runReview] ${taskId} failed:`, error);
      this.store.updateTask(taskId, { reviewStatus: "blocked" });
      this.transitionTo(taskId, "review_blocked");
      return;
    }
    this.store.updateTask(taskId, { reviewStatus: blocked ? "blocked" : "passed" });
    const updated = this.store.getTask(taskId);
    if (updated) this.transitionTo(taskId, blocked ? "review_blocked" : "awaiting_commit");
  }

  /**
   * 重置 review 状态(走合法出口 `reviewing -> review_blocked`)。
   * 状态机只允许 reviewing -> [review_blocked, awaiting_commit, implementing, failed],
   * 不允许直接回 awaiting_review。退到 review_blocked 后,前端会出现"重新运行 Review"按钮。
   */
  resetReview(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.state !== "reviewing" && task.reviewStatus !== "running") {
      this.sink.addEvent({ taskId, kind: "status", title: "无需重置,当前不在 review 状态" });
      return;
    }
    this.store.updateTask(taskId, { reviewStatus: "pending" });
    this.transitionTo(taskId, "review_blocked");
    this.sink.addEvent({ taskId, kind: "status", title: "review 状态已重置,可重新运行", detail: "走合法出口 reviewing -> review_blocked; 点击右上的「重新运行 Review」可再次触发" });
  }

  /**
   * 将已完成任务重置为可重新实现状态。
   * 任务和仓库关联保持不变；旧 MR 链接写入事件后清理活动交付字段，
   * 避免新一轮提交误更新已经完成的 MR。
   */
  reimplement(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.state !== "completed") throw new Error("只有已完成任务可以重新实现");

    for (const repo of this.store.listTaskRepositories(taskId)) {
      if (repo.mergeRequestUrl || repo.mergeRequestIid) {
        this.sink.addEvent({
          taskId,
          kind: "status",
          title: `${repo.name} 保留历史 MR`,
          detail: repo.mergeRequestUrl ?? (repo.mergeRequestIid ? `!${repo.mergeRequestIid}` : undefined)
        });
      }
      this.store.updateTaskRepository(repo.id, {
        changeSummary: undefined,
        commitSha: undefined,
        mergeRequestUrl: undefined,
        mergeRequestIid: undefined,
        mergeRequestState: undefined,
        mergeRequestCheckedAt: undefined,
        deliveryStatus: "pending"
      });
    }

    this.store.updateTask(taskId, {
      summary: undefined,
      startMode: undefined,
      planContent: undefined,
      planRevision: undefined,
      failureStage: undefined,
      reviewStatus: "pending",
      reviewFixCount: undefined,
      commitMessage: undefined,
      piSessionPath: undefined,
      sessionUsage: undefined
    });
    const reset = this.transitionTo(taskId, "preparing");
    this.sink.addEvent({ taskId, kind: "status", title: "任务已重置,可重新实现" });
    return reset;
  }

  isReviewEnabled(): boolean { return this.reviewEnabled(); }
  shouldAutoCreateMergeRequests(): boolean { return this.autoCreateMergeRequests(); }
  shouldGenerateTestCasesFromSetting(): boolean { return this.testCasesEnabled(); }
}
