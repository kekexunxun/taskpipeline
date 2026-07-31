import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SettingResolver, Task, TaskEventSink, TaskState, TaskStore } from "@coding-agent/core";
import { isReviewable, transitionTask } from "@coding-agent/core";
import { GitService } from "./git.js";
import type { ReviewOrchestrator } from "./review-orchestrator.js";

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
    private readonly autoCreateMergeRequests: () => boolean = () => this.resolver.get("autoCreateMergeRequests") === "true"
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

  /**
   * 准备任务环境(创建 worktree、feature branch)。
   * 行为兼容 desktop 原 `prepareTask`:
   * - `failed -> implementing`(允许从失败恢复)
   * - `draft -> confirmed -> preparing`
   * - `preparing` 创建 worktree,然后到 `implementing`
   * - 其他状态直接返回当前 task
   */
  async prepare(taskId: string): Promise<Task> {
    let task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.state === "failed") task = this.transitionTo(taskId, "implementing");
    if (task.state === "draft") task = this.transitionTo(taskId, "confirmed");
    if (task.state === "confirmed") task = this.transitionTo(taskId, "preparing");
    if (task.state === "preparing") {
      const root = this.worktreeRootFor(taskId);
      if (!existsSync(root)) mkdirSync(root, { recursive: true });
      const git = new GitService();
      const usedEntries = new Set<string>();
      for (const repo of this.store.listTaskRepositories(taskId)) {
        const base = repo.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "repository";
        const entry = usedEntries.has(base) ? `${base}-${repo.repositoryId.slice(0, 8)}` : base;
        usedEntries.add(entry);
        if (repo.worktreePath && repo.featureBranch) continue;
        const preferredBranch = task.jiraKey?.trim() || task.id.slice(0, 8);
        const { path: worktreePath, branch } = await git.createTaskWorktree(repo.localPath, root, preferredBranch, repo.baseBranch, entry);
        this.store.updateTaskRepository(repo.id, { featureBranch: branch, worktreePath });
      }
      task = this.transitionTo(taskId, "implementing");
    }
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
  async runReview(taskId: string, orchestrator: ReviewOrchestrator): Promise<void> {
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
        const result = await orchestrator.run(task, repo);
        const blocking = result.comments.filter((comment) => orchestrator.isBlockingComment(comment));
        blocked ||= blocking.length > 0;
        this.sink.addEvent({ taskId, kind: "review", title: `${repo.name}: ${result.comments.length} 条评审意见`, detail: blocking.length ? `${blocking.length} 条阻断问题` : "评审通过", payload: result });
      }
    } catch (error) {
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

  isReviewEnabled(): boolean { return this.reviewEnabled(); }
  shouldAutoCreateMergeRequests(): boolean { return this.autoCreateMergeRequests(); }
}
