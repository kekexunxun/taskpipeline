import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent, Approval, RepositoryProfile, Task, TaskCard, TaskRepository } from "./types.js";
import { boardColumnFor } from "./types.js";

export class TaskStore {
  readonly db: Database.Database;

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, jira_key TEXT, title TEXT NOT NULL, description TEXT NOT NULL,
        keywords TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, state TEXT NOT NULL,
        summary TEXT, start_mode TEXT, plan_content TEXT, plan_revision INTEGER, failure_stage TEXT,
        review_status TEXT NOT NULL, commit_message TEXT, pi_session_path TEXT, qoder_model TEXT, session_usage TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_repositories (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL, name TEXT NOT NULL, local_path TEXT NOT NULL,
        base_branch TEXT NOT NULL, setup_command TEXT, lint_command TEXT, test_command TEXT, build_command TEXT,
        feature_branch TEXT, worktree_path TEXT, change_summary TEXT,
        commit_sha TEXT, merge_request_url TEXT, merge_request_iid INTEGER, merge_request_state TEXT,
        merge_request_checked_at TEXT, delivery_status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, payload TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, status TEXT NOT NULL, context TEXT NOT NULL, created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS repository_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, local_path TEXT NOT NULL, remote_url TEXT,
        default_branch TEXT NOT NULL, gitlab_project_id TEXT, setup_command TEXT, test_command TEXT, lint_command TEXT, build_command TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_leases (
        task_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    try { this.db.exec("ALTER TABLE repository_profiles ADD COLUMN gitlab_project_id TEXT"); } catch { /* Existing databases may already contain the column. */ }
    for (const statement of [
      "ALTER TABLE tasks ADD COLUMN session_usage TEXT",
      "ALTER TABLE tasks ADD COLUMN qoder_model TEXT",
      "ALTER TABLE tasks ADD COLUMN start_mode TEXT",
      "ALTER TABLE tasks ADD COLUMN plan_content TEXT",
      "ALTER TABLE tasks ADD COLUMN plan_revision INTEGER",
      "ALTER TABLE tasks ADD COLUMN failure_stage TEXT",
      "ALTER TABLE task_repositories ADD COLUMN setup_command TEXT",
      "ALTER TABLE task_repositories ADD COLUMN lint_command TEXT",
      "ALTER TABLE task_repositories ADD COLUMN test_command TEXT",
      "ALTER TABLE task_repositories ADD COLUMN build_command TEXT",
      "ALTER TABLE repository_profiles ADD COLUMN setup_command TEXT",
      "ALTER TABLE task_repositories ADD COLUMN merge_request_iid INTEGER",
      "ALTER TABLE task_repositories ADD COLUMN merge_request_state TEXT",
      "ALTER TABLE task_repositories ADD COLUMN merge_request_checked_at TEXT"
    ]) { try { this.db.exec(statement); } catch { /* Existing databases may already contain the column. */ } }
  }

  close(): void { this.db.close(); }
  private now(): string { return new Date().toISOString(); }

  createTask(input: Pick<Task, "title" | "description"> & Partial<Task>): Task {
    const task: Task = {
      id: input.id ?? randomUUID(), jiraKey: input.jiraKey, title: input.title,
      description: input.description, keywords: input.keywords ?? [], acceptanceCriteria: input.acceptanceCriteria ?? [],
      state: input.state ?? "draft", summary: input.summary, startMode: input.startMode, planContent: input.planContent,
      planRevision: input.planRevision, failureStage: input.failureStage, reviewStatus: input.reviewStatus ?? "pending",
      commitMessage: input.commitMessage, piSessionPath: input.piSessionPath, qoderModel: input.qoderModel, sessionUsage: input.sessionUsage, createdAt: this.now(), updatedAt: this.now()
    };
    this.db.prepare(`INSERT INTO tasks (id,jira_key,title,description,keywords,acceptance_criteria,state,summary,start_mode,plan_content,plan_revision,failure_stage,review_status,commit_message,pi_session_path,qoder_model,session_usage,created_at,updated_at)
      VALUES (@id,@jiraKey,@title,@description,@keywords,@acceptanceCriteria,@state,@summary,@startMode,@planContent,@planRevision,@failureStage,@reviewStatus,@commitMessage,@piSessionPath,@qoderModel,@sessionUsage,@createdAt,@updatedAt)`).run({
      ...task, keywords: JSON.stringify(task.keywords), acceptanceCriteria: JSON.stringify(task.acceptanceCriteria), sessionUsage: task.sessionUsage ? JSON.stringify(task.sessionUsage) : null
    });
    return task;
  }

  updateTask(id: string, patch: Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>): Task {
    const current = this.getTask(id);
    if (!current) throw new Error(`Task not found: ${id}`);
    const next = { ...current, ...patch, updatedAt: this.now() };
    this.db.prepare(`UPDATE tasks SET jira_key=@jiraKey,title=@title,description=@description,keywords=@keywords,acceptance_criteria=@acceptanceCriteria,state=@state,summary=@summary,start_mode=@startMode,plan_content=@planContent,plan_revision=@planRevision,failure_stage=@failureStage,review_status=@reviewStatus,commit_message=@commitMessage,pi_session_path=@piSessionPath,qoder_model=@qoderModel,session_usage=@sessionUsage,updated_at=@updatedAt WHERE id=@id`).run({
      ...next, keywords: JSON.stringify(next.keywords), acceptanceCriteria: JSON.stringify(next.acceptanceCriteria), sessionUsage: next.sessionUsage ? JSON.stringify(next.sessionUsage) : null
    });
    return next;
  }

  deleteTask(id: string): void { this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id); }

  getTask(id: string): Task | undefined { return this.parseTask(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id)); }
  getTaskByJiraKey(jiraKey: string): Task | undefined { return this.parseTask(this.db.prepare("SELECT * FROM tasks WHERE jira_key = ?").get(jiraKey)); }
  upsertJiraTask(input: Pick<Task, "jiraKey" | "title" | "description"> & Partial<Task>): Task {
    // jiraKey 命中已存在任务时,只能同步 Jira 上的内容字段(title/description/keywords/acceptanceCriteria),
    // 不能把整个 patch 透传给 updateTask,否则:
    // - state / reviewStatus 会被强制写回 draft / pending,把已 completed 的任务回退成 todo,
    //   用户的整条 Review、commit、MR 流程在 UI 上就凭空消失。
    // - commitMessage / qoderModel / piSessionPath / sessionUsage / summary 也属于"工作流或运行期"字段,
    //   一旦被 Jira 同步的默认值(state: "draft" + reviewStatus: "pending" 那一坨)覆盖,用户配置和 AI 用量统计都丢了。
    // 解决方式:更新路径里只放 Jira 内容字段,工作流/运行期字段全部保留 current 的值。
    if (input.jiraKey) {
      const current = this.getTaskByJiraKey(input.jiraKey);
      if (current) {
        return this.updateTask(current.id, {
          jiraKey: input.jiraKey,
          title: input.title,
          description: input.description,
          keywords: input.keywords ?? current.keywords,
          acceptanceCriteria: input.acceptanceCriteria ?? current.acceptanceCriteria
        });
      }
    }
    return this.createTask(input);
  }
  listTasks(): Task[] { return (this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all() as unknown[]).map((row) => this.parseTask(row)!); }
  listCards(): TaskCard[] { return this.listTasks().map((task) => ({ ...task, boardColumn: boardColumnFor(task.state), repositories: this.listTaskRepositories(task.id).map(({ id, name, changeSummary, mergeRequestUrl, deliveryStatus }) => ({ id, name, changeSummary, mergeRequestUrl, deliveryStatus })) })); }
  private parseTask(row: unknown): Task | undefined {
    if (!row) return undefined;
    const r = row as Record<string, unknown>;
    return { id: String(r.id), jiraKey: r.jira_key ? String(r.jira_key) : undefined, title: String(r.title), description: String(r.description), keywords: JSON.parse(String(r.keywords)), acceptanceCriteria: JSON.parse(String(r.acceptance_criteria)), state: r.state as Task["state"], summary: r.summary ? String(r.summary) : undefined, startMode: r.start_mode as Task["startMode"] || undefined, planContent: r.plan_content ? String(r.plan_content) : undefined, planRevision: r.plan_revision == null ? undefined : Number(r.plan_revision), failureStage: r.failure_stage as Task["failureStage"] || undefined, reviewStatus: r.review_status as Task["reviewStatus"], commitMessage: r.commit_message ? String(r.commit_message) : undefined, piSessionPath: r.pi_session_path ? String(r.pi_session_path) : undefined, qoderModel: r.qoder_model ? String(r.qoder_model) : undefined, sessionUsage: r.session_usage ? JSON.parse(String(r.session_usage)) as Task["sessionUsage"] : undefined, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }

  addTaskRepository(repo: Omit<TaskRepository, "id">): TaskRepository { const item = { setupCommand: undefined, lintCommand: undefined, testCommand: undefined, buildCommand: undefined, featureBranch: undefined, worktreePath: undefined, changeSummary: undefined, commitSha: undefined, mergeRequestUrl: undefined, mergeRequestIid: undefined, mergeRequestState: undefined, mergeRequestCheckedAt: undefined, ...repo, id: randomUUID() }; this.db.prepare(`INSERT INTO task_repositories (id,task_id,repository_id,name,local_path,base_branch,setup_command,lint_command,test_command,build_command,feature_branch,worktree_path,change_summary,commit_sha,merge_request_url,merge_request_iid,merge_request_state,merge_request_checked_at,delivery_status) VALUES (@id,@taskId,@repositoryId,@name,@localPath,@baseBranch,@setupCommand,@lintCommand,@testCommand,@buildCommand,@featureBranch,@worktreePath,@changeSummary,@commitSha,@mergeRequestUrl,@mergeRequestIid,@mergeRequestState,@mergeRequestCheckedAt,@deliveryStatus)`).run(item); return item; }
  updateTaskRepository(id: string, patch: Partial<Omit<TaskRepository, "id" | "taskId">>): TaskRepository {
    const current = this.db.prepare("SELECT id,task_id as taskId,repository_id as repositoryId,name,local_path as localPath,base_branch as baseBranch,setup_command as setupCommand,lint_command as lintCommand,test_command as testCommand,build_command as buildCommand,feature_branch as featureBranch,worktree_path as worktreePath,change_summary as changeSummary,commit_sha as commitSha,merge_request_url as mergeRequestUrl,merge_request_iid as mergeRequestIid,merge_request_state as mergeRequestState,merge_request_checked_at as mergeRequestCheckedAt,delivery_status as deliveryStatus FROM task_repositories WHERE id = ?").get(id) as TaskRepository | undefined;
    if (!current) throw new Error(`Task repository not found: ${id}`);
    const next = { ...current, ...patch };
    this.db.prepare(`UPDATE task_repositories SET repository_id=@repositoryId,name=@name,local_path=@localPath,base_branch=@baseBranch,setup_command=@setupCommand,lint_command=@lintCommand,test_command=@testCommand,build_command=@buildCommand,feature_branch=@featureBranch,worktree_path=@worktreePath,change_summary=@changeSummary,commit_sha=@commitSha,merge_request_url=@mergeRequestUrl,merge_request_iid=@mergeRequestIid,merge_request_state=@mergeRequestState,merge_request_checked_at=@mergeRequestCheckedAt,delivery_status=@deliveryStatus WHERE id=@id`).run(next);
    return next;
  }
  listTaskRepositories(taskId: string): TaskRepository[] { return this.db.prepare("SELECT id,task_id as taskId,repository_id as repositoryId,name,local_path as localPath,base_branch as baseBranch,setup_command as setupCommand,lint_command as lintCommand,test_command as testCommand,build_command as buildCommand,feature_branch as featureBranch,worktree_path as worktreePath,change_summary as changeSummary,commit_sha as commitSha,merge_request_url as mergeRequestUrl,merge_request_iid as mergeRequestIid,merge_request_state as mergeRequestState,merge_request_checked_at as mergeRequestCheckedAt,delivery_status as deliveryStatus FROM task_repositories WHERE task_id = ?").all(taskId) as TaskRepository[]; }
  attachRepository(taskId: string, repositoryId: string): TaskRepository {
    const existing = this.listTaskRepositories(taskId).find((repo) => repo.repositoryId === repositoryId);
    if (existing) return existing;
    const profile = this.db.prepare("SELECT id,name,local_path as localPath,default_branch as defaultBranch,setup_command as setupCommand,lint_command as lintCommand,test_command as testCommand,build_command as buildCommand FROM repository_profiles WHERE id = ?").get(repositoryId) as Pick<RepositoryProfile, "id" | "name" | "localPath" | "defaultBranch" | "setupCommand" | "lintCommand" | "testCommand" | "buildCommand"> | undefined;
    if (!profile) throw new Error(`Repository profile not found: ${repositoryId}`);
    return this.addTaskRepository({ taskId, repositoryId: profile.id, name: profile.name, localPath: profile.localPath, baseBranch: profile.defaultBranch, setupCommand: profile.setupCommand, lintCommand: profile.lintCommand, testCommand: profile.testCommand, buildCommand: profile.buildCommand, deliveryStatus: "pending" });
  }
  detachRepository(taskId: string, repositoryId: string): void {
    const repo = this.listTaskRepositories(taskId).find((item) => item.repositoryId === repositoryId);
    if (repo?.worktreePath) throw new Error("Cannot detach a repository after its worktree has been created");
    this.db.prepare("DELETE FROM task_repositories WHERE task_id = ? AND repository_id = ?").run(taskId, repositoryId);
  }
  deleteRepositoryProfile(id: string): void { this.db.prepare("DELETE FROM repository_profiles WHERE id = ?").run(id); }
  addEvent(event: Omit<AgentEvent, "id" | "createdAt">): AgentEvent { const item = { detail: undefined, payload: undefined, ...event, id: randomUUID(), createdAt: this.now() }; this.db.prepare("INSERT INTO events (id,task_id,kind,title,detail,payload,created_at) VALUES (@id,@taskId,@kind,@title,@detail,@payload,@createdAt)").run({ ...item, payload: item.payload === undefined ? undefined : JSON.stringify(item.payload) }); return item; }
  listEvents(taskId: string): AgentEvent[] { return (this.db.prepare("SELECT id,task_id as taskId,kind,title,detail,payload,created_at as createdAt FROM events WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Record<string, unknown>[]).map((r) => ({ ...r, id: String(r.id), taskId: String(r.taskId), kind: r.kind as AgentEvent["kind"], title: String(r.title), detail: r.detail ? String(r.detail) : undefined, payload: r.payload ? JSON.parse(String(r.payload)) : undefined, createdAt: String(r.createdAt) })); }
  addApproval(input: Omit<Approval, "id" | "createdAt" | "status">): Approval { const item = { ...input, id: randomUUID(), status: "pending" as const, createdAt: this.now() }; this.db.prepare("INSERT INTO approvals (id,task_id,kind,status,context,created_at) VALUES (@id,@taskId,@kind,@status,@context,@createdAt)").run(item); return item; }
  listApprovals(taskId: string): Approval[] { return this.db.prepare("SELECT id,task_id as taskId,kind,status,context,created_at as createdAt,resolved_at as resolvedAt FROM approvals WHERE task_id = ? ORDER BY created_at DESC").all(taskId) as Approval[]; }
  resolveApproval(id: string, status: "approved" | "rejected"): void { this.db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?").run(status, this.now(), id); }
  saveRepositoryProfile(profile: RepositoryProfile): void { this.db.prepare("INSERT OR REPLACE INTO repository_profiles (id,name,local_path,remote_url,default_branch,gitlab_project_id,setup_command,test_command,lint_command,build_command) VALUES (@id,@name,@localPath,@remoteUrl,@defaultBranch,@gitlabProjectId,@setupCommand,@testCommand,@lintCommand,@buildCommand)").run({ gitlabProjectId: undefined, setupCommand: undefined, testCommand: undefined, lintCommand: undefined, buildCommand: undefined, remoteUrl: undefined, ...profile, localPath: profile.localPath }); }
  listRepositoryProfiles(): RepositoryProfile[] { return this.db.prepare("SELECT id,name,local_path as localPath,remote_url as remoteUrl,default_branch as defaultBranch,gitlab_project_id as gitlabProjectId,setup_command as setupCommand,test_command as testCommand,lint_command as lintCommand,build_command as buildCommand FROM repository_profiles ORDER BY name").all() as RepositoryProfile[]; }
  setSetting(key: string, value: string): void { this.db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(key, value); }
  getSetting(key: string): string | undefined { const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined; return row?.value; }
  acquireLease(taskId: string, owner: string, ttlMs = 30_000): boolean { const now = Date.now(); const tx = this.db.transaction(() => { this.db.prepare("DELETE FROM task_leases WHERE expires_at < ?").run(now); const existing = this.db.prepare("SELECT owner FROM task_leases WHERE task_id = ?").get(taskId) as { owner?: string } | undefined; if (existing && existing.owner !== owner) return false; this.db.prepare("INSERT OR REPLACE INTO task_leases (task_id,owner,expires_at) VALUES (?,?,?)").run(taskId, owner, now + ttlMs); return true; }); return tx(); }
  releaseLease(taskId: string, owner: string): void { this.db.prepare("DELETE FROM task_leases WHERE task_id = ? AND owner = ?").run(taskId, owner); }
}
