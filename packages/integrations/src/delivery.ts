import type { SettingResolver, Task, TaskEventSink, TaskRepository, TaskStore } from "@coding-agent/core";
import { transitionTask } from "@coding-agent/core";
import { GitLabService, parseGitLabRemote } from "./gitlab.js";
import { GitService } from "./git.js";

/**
 * 提交 / push / 建 MR 节点的用户确认回调。
 *
 * - desktop 端:由前端 confirm dialog 实现,默认不走 confirm(直接返回 true)。
 * - pi 端:由 Pi ExtensionUI 的 `ctx.ui.confirm` 实现,每步弹一次。
 *
 * 返回 `false` 时,DeliveryService 不会执行对应步骤,直接退到 `awaiting_commit`。
 */
export type DeliveryApprover = (task: Task, kind: "commit" | "push" | "merge_request", context: string) => Promise<boolean>;

export interface DeliveryServiceOptions {
  /**
   * 用户确认回调。
   * 传 undefined 或返回 `true` 的实现 = 跳过 confirm,直接执行(desktop 行为)。
   */
  approver?: DeliveryApprover;
  /** 注入 GitLab service 工厂,便于测试时 mock。 */
  gitlabFactory?: (baseUrl: string, projectId: string | number) => GitLabService;
}

/**
 * 提交 / 推送 / 建 MR 状态机推进器。
 *
 * 关键行为(沿用 desktop 原版):
 * - `git commit --no-verify` 绕开 husky / pre-commit / commit-msg 钩子(worktree 通常缺依赖)。
 * - "nothing to commit" 复用 HEAD 继续走 push,不阻断流程。
 * - `git push` 单独 90s 超时(commit 是本地操作,默认 10 分钟够用),网络错误友好提示。
 * - push 用 token 走 `http.extraHeader=PRIVATE-TOKEN: ...`,绕开 SSH 凭证问题。
 * - MR 已存在(`mergeRequestIid` + `mergeRequestUrl` 都有)走 update 路径,否则 create。
 * - 任何一步失败:
 *   - 单独 try 写入 `error` 事件
 *   - 单独 try 退到 `awaiting_commit`(走合法出口 `delivering -> awaiting_commit`)
 *   - 两者互不影响,任一炸了不影响另一边的 try
 * - 全部成功:`awaiting_commit -> await_merge`。
 *
 * 失败退到 `awaiting_commit` 而非 `failed` 的原因:
 * - failed 在 boardColumnFor 里映射到 in_progress,会把"提交阶段的瞬时错误"误显示成"实现重跑中",
 *   跟实际语义(任务已经实现完,只是 MR 没成功)严重不符。
 * - awaiting_commit 映射到 in_review,符合"任务已完成实现、待再次提交"的真实状态。
 * - 用户从「提交 MR」按钮一键重试,不走 preparing -> implementing 的重跑路径。
 */
export class DeliveryService {
  constructor(
    private readonly store: TaskStore,
    private readonly git: GitService,
    private readonly resolver: SettingResolver,
    private readonly sink: TaskEventSink,
    private readonly options: DeliveryServiceOptions = {}
  ) {}

  async submitMergeRequests(taskId: string, signal?: AbortSignal): Promise<void> {
    let task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.state !== "awaiting_commit") throw new Error("任务尚未通过 Review 或尚未准备提交");
    const token = this.resolver.getSecret("gitlabToken");
    if (!token) throw new Error("请先在代码仓库设置中配置 GitLab Token");
    transitionTask(task.state, "delivering");
    this.store.updateTask(taskId, { state: "delivering" });
    task = this.store.getTask(taskId)!;
    const profiles = new Map(this.store.listRepositoryProfiles().map((profile) => [profile.id, profile]));
    const factory = this.options.gitlabFactory ?? ((baseUrl, projectId) => new GitLabService({ baseUrl, token, projectId }));
    const message = task.commitMessage ?? `feat: ${task.taskKey ? `${task.taskKey} ` : ""}${task.title}`;
    try {
      for (const repo of this.store.listTaskRepositories(taskId)) {
        signal?.throwIfAborted();
        const profile = profiles.get(repo.repositoryId);
        const remote = profile?.remoteUrl && parseGitLabRemote(profile.remoteUrl);
        if (!remote || !repo.worktreePath || !repo.featureBranch) throw new Error(`仓库 ${repo.name} 缺少 GitLab 地址或 worktree`);
        if (this.options.approver) {
          const ok = await this.options.approver(task, "commit", `${repo.name}: commit\n${message}`);
          if (!ok) { this.sink.addEvent({ taskId, kind: "permission", title: "已拒绝 commit", detail: `${repo.name}: 用户拒绝 commit` }); this.fallbackToAwaitingCommit(taskId); return; }
        }
        this.sink.addEvent({ taskId, kind: "status", title: `${repo.name}: git add + commit (--no-verify)` });
        const sha = await this.git.commit(repo.worktreePath, message, signal);
        this.sink.addEvent({ taskId, kind: "status", title: `${repo.name}: commit ${sha.slice(0, 8)} 已就绪,正在 push` });
        if (this.options.approver) {
          const ok = await this.options.approver(task, "push", `${repo.name}: push ${repo.featureBranch}`);
          if (!ok) { this.sink.addEvent({ taskId, kind: "permission", title: "已拒绝 push", detail: `${repo.name}: 用户拒绝 push` }); this.fallbackToAwaitingCommit(taskId); return; }
        }
        await this.git.push(repo.worktreePath, repo.featureBranch, token, signal);
        this.sink.addEvent({ taskId, kind: "status", title: `${repo.name}: push 完成,处理 MR` });
        if (this.options.approver) {
          const ok = await this.options.approver(task, "merge_request", `${repo.name}: 创建 GitLab Merge Request`);
          if (!ok) { this.sink.addEvent({ taskId, kind: "permission", title: "已拒绝创建 MR", detail: `${repo.name}: 用户拒绝创建 MR` }); this.fallbackToAwaitingCommit(taskId); return; }
        }
        if (repo.mergeRequestIid && repo.mergeRequestUrl) {
          this.store.updateTaskRepository(repo.id, { commitSha: sha, mergeRequestState: "opened", deliveryStatus: "mr_created" });
          this.sink.addEvent({ taskId, kind: "command", title: `${repo.name} 已更新 MR`, detail: repo.mergeRequestUrl });
        } else {
          const mr = await factory(remote.baseUrl, remote.projectId).createMergeRequest({ sourceBranch: repo.featureBranch, targetBranch: repo.baseBranch, title: `${task.taskKey ? `${task.taskKey} ` : ""}${task.title}`, description: `Automated implementation for ${task.taskKey ?? taskId}.` }, signal);
          this.store.updateTaskRepository(repo.id, { commitSha: sha, mergeRequestUrl: mr.web_url, mergeRequestIid: mr.iid, mergeRequestState: "opened", deliveryStatus: "mr_created" });
          this.sink.addEvent({ taskId, kind: "command", title: `${repo.name} 已创建 MR`, detail: mr.web_url });
        }
      }
    } catch (error) {
      // event 写入和状态更新各自单独 try,互不影响:
      // - 即使 addTaskEvent / store / TaskStore 任一环节炸了,fallbackToAwaitingCommit 仍要尝试把任务从 delivering 退到 awaiting_commit。
      // - 反过来,状态机抛 invalid transition (理论上不会) 也不能阻断 error event 的记录。
      const message = error instanceof Error ? error.message : String(error);
      let eventError: unknown;
      try { this.sink.addEvent({ taskId, kind: "error", title: "提交 MR 失败,可重新提交", detail: message }); }
      catch (err) { eventError = err; console.error("[DeliveryService] failed to record error event:", err); }
      let stateError: unknown;
      try { this.fallbackToAwaitingCommit(taskId); }
      catch (err) { stateError = err; console.error("[DeliveryService] failed to transition state to awaiting_commit:", err); }
      if (eventError || stateError) throw eventError ?? stateError;
      throw error;
    }
    task = this.store.getTask(taskId)!;
    transitionTask(task.state, "await_merge");
    this.store.updateTask(taskId, { state: "await_merge" });
  }

  /**
   * 重置 delivering → awaiting_commit,清理 commitSha 与 mergeRequest 状态。
   *
   * 行为(沿用 desktop 原版):
   * - commitSha 清空:下次 commit 会拿到新 SHA,避免重复提交时把旧 SHA 当成新提交。
   * - mergeRequestIid / mergeRequestUrl 保留:走「更新 MR」分支,不会重复建 MR。
   * - mergeRequestState / mergeRequestCheckedAt 清空:避免显示过期的合并状态。
   * - deliveryStatus 设回 "pending"(列是 NOT NULL,传 undefined 会被 better-sqlite3 当 NULL 写入被约束拦下)。
   */
  resetDelivery(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.state !== "delivering") {
      this.sink.addEvent({ taskId, kind: "status", title: "无需重置,当前不在「提交 MR 中」状态" });
      return;
    }
    for (const repo of this.store.listTaskRepositories(taskId)) {
      this.store.updateTaskRepository(repo.id, { commitSha: undefined, mergeRequestState: undefined, mergeRequestCheckedAt: undefined, deliveryStatus: "pending" });
    }
    transitionTask(task.state, "awaiting_commit");
    this.store.updateTask(taskId, { state: "awaiting_commit" });
    this.sink.addEvent({ taskId, kind: "status", title: "提交状态已重置,可重新提交 MR", detail: "走合法出口 delivering -> awaiting_commit; worktree 里若已有 commit,重新提交会创建一个新 commit 覆盖" });
  }

  private fallbackToAwaitingCommit(taskId: string): void {
    const current = this.store.getTask(taskId);
    if (current && current.state === "delivering") {
      transitionTask(current.state, "awaiting_commit");
      this.store.updateTask(taskId, { state: "awaiting_commit" });
    }
  }
}
