import type { SettingResolver, TaskEventSink, TaskStore } from "@coding-agent/core";
import { transitionTask } from "@coding-agent/core";
import { GitLabService, parseGitLabRemote } from "./gitlab.js";

/**
 * 单个仓库 MR 的状态。
 * - `state: "error"` 表示查询失败(网络 / 权限 / MR 被删等),`error` 字段附原始错误信息。
 */
export type MergeRepoStatus = {
  repoId: string;
  repoName: string;
  mergeRequestIid: number;
  mergeRequestUrl?: string;
  state: "opened" | "merged" | "closed" | "error";
  error?: string;
};

export type MergeStatusSummary = {
  taskId: string;
  taskTitle: string;
  repos: MergeRepoStatus[];
  allMerged: boolean;
  taskCompleted: boolean;
};

export interface MergeStatusRefresherOptions {
  /** 注入 GitLab service 工厂,便于测试时 mock;默认按 profile.remoteUrl + projectId 构造。 */
  gitlabFactory?: (baseUrl: string, projectId: string) => GitLabService;
}

/**
 * MR 状态轮询器。
 *
 * 行为(沿用 desktop 原版):
 * - 仅处理 `state === "await_merge"` 的 task。
 * - 每个仓库调 GitLab API 查 MR 状态,持久化到 `mergeRequestState` / `mergeRequestCheckedAt`。
 * - 状态变化才发事件,避免 timeline 刷屏:
 *   - opened -> closed: error 事件(MR 被关闭,严重信号)
 *   - closed -> merged: status 事件(异常路径,正常应 reopened 再 merged)
 *   - closed -> opened: status 事件(重新打开,中性)
 *   - opened -> merged: 不发单独事件,走"全部 merged"分支自动 completed
 * - 全部仓库 merged:发 status 事件"所有 MR 已合并,任务自动完成",走合法出口 `await_merge -> completed`。
 * - 单个仓库查询失败:继续处理其他仓库,失败项以 `state: "error"` 写入结果。
 */
export class MergeStatusRefresher {
  constructor(
    private readonly store: TaskStore,
    private readonly resolver: SettingResolver,
    private readonly sink: TaskEventSink,
    private readonly options: MergeStatusRefresherOptions = {}
  ) {}

  async refresh(): Promise<MergeStatusSummary[]> {
    const token = this.resolver.getSecret("gitlabToken");
    if (!token) return [];
    const profiles = new Map(this.store.listRepositoryProfiles().map((profile) => [profile.id, profile]));
    const factory = this.options.gitlabFactory ?? ((baseUrl, projectId) => new GitLabService({ baseUrl, token, projectId }));
    const results: MergeStatusSummary[] = [];
    for (const task of this.store.listTasks().filter((item) => item.state === "await_merge")) {
      const repos = this.store.listTaskRepositories(task.id);
      if (repos.length === 0) continue;
      const repoStatuses: MergeRepoStatus[] = [];
      let allMerged = true;
      for (const repo of repos) {
        const remoteUrl = profiles.get(repo.repositoryId)?.remoteUrl;
        const remote = remoteUrl && parseGitLabRemote(remoteUrl);
        if (!remote || !repo.mergeRequestIid) {
          allMerged = false;
          repoStatuses.push({ repoId: repo.id, repoName: repo.name, mergeRequestIid: 0, state: "error", error: "缺少 GitLab remote 地址或 MR ID" });
          continue;
        }
        try {
          const mr = await factory(remote.baseUrl, remote.projectId).getMergeRequest(repo.mergeRequestIid);
          const state = mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "opened";
          const previousState = repo.mergeRequestState;
          this.store.updateTaskRepository(repo.id, { mergeRequestState: state, mergeRequestCheckedAt: new Date().toISOString() });
          if (previousState !== state) {
            if (state === "closed") this.sink.addEvent({ taskId: task.id, kind: "error", title: `${repo.name} MR 已被关闭`, detail: repo.mergeRequestUrl ?? "" });
            else if (state === "merged") this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name} MR 已合并`, detail: repo.mergeRequestUrl ?? "" });
            else if (state === "opened" && previousState === "closed") this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name} MR 重新打开`, detail: repo.mergeRequestUrl ?? "" });
          }
          repoStatuses.push({ repoId: repo.id, repoName: repo.name, mergeRequestIid: repo.mergeRequestIid, mergeRequestUrl: repo.mergeRequestUrl ?? undefined, state });
          allMerged &&= state === "merged";
        } catch (error) {
          allMerged = false;
          const message = error instanceof Error ? error.message : String(error);
          this.sink.addEvent({ taskId: task.id, kind: "error", title: `${repo.name} MR 状态检查失败`, detail: message });
          repoStatuses.push({ repoId: repo.id, repoName: repo.name, mergeRequestIid: repo.mergeRequestIid, mergeRequestUrl: repo.mergeRequestUrl ?? undefined, state: "error", error: message });
        }
      }
      const taskCompleted = allMerged && repoStatuses.length > 0 && repoStatuses.every((r) => r.state === "merged");
      if (taskCompleted) {
        // 自动 completed:状态机走合法出口 await_merge -> completed,同时发一个 status 事件让用户在 timeline 看到触发点。
        // 不发就只剩"任务突然从等待合并列消失"这种隐性副作用,用户不知道是哪个动作触发的。
        this.sink.addEvent({ taskId: task.id, kind: "status", title: "所有 MR 已合并,任务自动完成" });
        const current = this.store.getTask(task.id);
        if (current && current.state === "await_merge") {
          transitionTask(current.state, "completed");
          this.store.updateTask(task.id, { state: "completed" });
        }
      }
      results.push({ taskId: task.id, taskTitle: task.title, repos: repoStatuses, allMerged: taskCompleted, taskCompleted });
    }
    return results;
  }
}

/**
 * 任务手动结束器。
 *
 * 适用场景:某些 repo 的 MR 在 GitLab 单独处理(cherry-pick / 重提 / 走 hotfix),
 * 任务从应用视角已交付,不希望被某个未合并的 MR 阻塞整个 task。
 * MR 在 GitLab 继续存在,应用不再追踪。
 */
export class TaskCompleter {
  constructor(private readonly store: TaskStore, private readonly sink: TaskEventSink) {}

  manualComplete(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.state !== "await_merge") throw new Error(`当前状态 ${task.state} 不支持手动结束,仅 await_merge 可手动结束`);
    // 先记一笔 status 事件,记录手动结束时的 MR 状态快照,便于用户日后回溯。
    const repos = this.store.listTaskRepositories(taskId);
    const summary = repos.map((repo) => `${repo.name} ${repo.mergeRequestState ?? "未知"}`).join(" · ");
    this.sink.addEvent({ taskId, kind: "status", title: `任务已手动结束(跳过未合并 MR: ${summary || "无"})`, detail: "MR 在 GitLab 继续存在,应用不再追踪其状态" });
    transitionTask(task.state, "completed");
    this.store.updateTask(taskId, { state: "completed" });
  }
}
