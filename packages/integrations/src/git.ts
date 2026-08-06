import { execa } from "execa";
import { randomInt } from "node:crypto";
import { join } from "node:path";

export type GitRunner = (args: string[], cwd: string, timeoutMs?: number, signal?: AbortSignal) => Promise<string>;
export type GitRepositoryInfo = { rootPath: string; currentBranch: string; remoteUrl?: string };
export type GitChangedFile = { path: string; status: string };
export type GitWorktree = { path: string; branch: string };

const RANDOM_BRANCH_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
const REMOTE_OPERATION_TIMEOUT_MS = 60_000;

function randomBranchSuffix(): string {
  return Array.from({ length: 4 }, () => RANDOM_BRANCH_CHARACTERS[randomInt(RANDOM_BRANCH_CHARACTERS.length)]).join("");
}

function hasBranch(refs: Set<string>, branch: string): boolean {
  if (refs.has(`refs/heads/${branch}`)) return true;
  return [...refs].some((ref) => ref.startsWith("refs/remotes/") && ref.endsWith(`/${branch}`));
}

function originBranchRef(baseBranch: string): string {
  const branch = baseBranch.trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^origin\//, "");
  if (!branch) throw new Error("Repository base branch is required");
  return `refs/remotes/origin/${branch}`;
}

function parseNameStatus(value: string): GitChangedFile[] {
  const fields = value.split("\0");
  const files: GitChangedFile[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const renamed = status.startsWith("R") || status.startsWith("C");
    const firstPath = fields[index++];
    const path = renamed ? fields[index++] : firstPath;
    if (path) files.push({ path, status: status[0] ?? "?" });
  }
  return files;
}

function parseWorkingStatus(value: string): GitChangedFile[] {
  const records = value.split("\0");
  const files: GitChangedFile[] = [];
  for (let index = 0; index < records.length;) {
    const record = records[index++];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const renamed = code.includes("R") || code.includes("C");
    const path = record.slice(3);
    if (renamed) index += 1;
    if (path) files.push({ path, status: code.trim() || "?" });
  }
  return files;
}

export class GitService {
  // 默认 runner 给所有 git 命令加 10 分钟超时,特殊命令 (push) 可以传更短的 timeoutMs 覆盖。
  // `execa` 的 reject:true (默认) 会在超时后 reject,上层 submitTaskMergeRequests 的 try/catch
  // 会接住并把状态退到 awaiting_commit,避免任务永远卡在 delivering。
  // 不用 reject:false 是因为我们要拿到 timeout 这个 reason 走统一的错误流。
  constructor(
    private readonly run: GitRunner = async (args, cwd, timeoutMs, signal) => (await execa("git", args, {
      cwd,
      timeout: timeoutMs ?? 10 * 60_000,
      cancelSignal: signal,
      env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
    })).stdout,
    private readonly branchSuffix: () => string = randomBranchSuffix
  ) {}

  private async fetchRemote(cwd: string, signal?: AbortSignal): Promise<string> {
    try {
      return await this.run(["fetch", "--all", "--prune"], cwd, REMOTE_OPERATION_TIMEOUT_MS, signal);
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string; timedOut?: boolean };
      const detail = [failure.stderr, failure.stdout, failure.message].filter(Boolean).join("\n");
      const remoteUrl = (await this.run(["config", "--get", "remote.origin.url"], cwd).catch(() => "")).trim();
      const remote = remoteUrl ? ` (${remoteUrl})` : "";
      if (failure.timedOut || /timed out|Could not resolve host|Failed to connect|Connection refused|Network is unreachable|No route to host|ssh: connect to host/i.test(detail)) {
        throw new Error(`Git 拉取超时，无法连接远程仓库${remote}。请检查网络或 VPN 后重试。`);
      }
      if (/Authentication failed|Access denied|Permission denied|could not read Username|terminal prompts disabled/i.test(detail)) {
        throw new Error(`Git 远程仓库认证失败${remote}。请检查本机 Git 凭据或 SSH Key 后重试。`);
      }
      throw new Error(`Git 远程同步失败${remote}：${detail || "未知错误"}`);
    }
  }

  status(cwd: string): Promise<string> { return this.run(["status", "--short"], cwd); }
  diff(cwd: string): Promise<string> { return this.run(["diff", "HEAD"], cwd); }
  diffRange(cwd: string, range: string, paths?: string[], signal?: AbortSignal): Promise<string> {
    const args = ["diff", "--no-color", range];
    if (paths?.length) args.push("--", ...paths);
    return this.run(args, cwd, undefined, signal);
  }
  showCommit(cwd: string, commit: string, paths?: string[]): Promise<string> {
    const args = ["show", "--no-color", "--format=", commit];
    if (paths?.length) args.push("--", ...paths);
    return this.run(args, cwd);
  }
  /**
   * 选择 diff 基准 ref:
   * worktree 是基于 `origin/<base>` 创建的。若本地 `base` 分支与远程分叉(本地领先或落后),
   * 用本地分支名做 `git diff <base>...HEAD` 会算出一堆"本地分支独有提交"的假差异,
   * 导致初始化项目就显示大量变更文件。优先用远程 ref(与 worktree 创建基准一致),
   * 无远程(纯本地仓库)时回退本地分支名。
   */
  private async resolveDiffBase(cwd: string, baseBranch: string, signal?: AbortSignal): Promise<string> {
    const normalized = baseBranch.trim()
      .replace(/^refs\/heads\//, "")
      .replace(/^refs\/remotes\/origin\//, "")
      .replace(/^origin\//, "");
    const remoteRef = `refs/remotes/origin/${normalized}`;
    try {
      await this.run(["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`], cwd, undefined, signal);
      return remoteRef;
    } catch {
      return normalized;
    }
  }

  async changedFiles(cwd: string, baseBranch: string, signal?: AbortSignal): Promise<GitChangedFile[]> {
    const baseRef = await this.resolveDiffBase(cwd, baseBranch, signal);
    const files = new Map<string, GitChangedFile>();
    try {
      for (const file of parseNameStatus(await this.run(["diff", "--name-status", "-z", `${baseRef}...HEAD`], cwd, undefined, signal))) files.set(file.path, file);
    } catch { /* The worktree may not have a resolvable base branch yet. */ }
    for (const file of parseWorkingStatus(await this.run(["status", "--short", "-z"], cwd, undefined, signal))) files.set(file.path, file);
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  currentBranch(cwd: string): Promise<string> { return this.run(["branch", "--show-current"], cwd); }
  async inspectRepository(cwd: string): Promise<GitRepositoryInfo> {
    const isRepository = (await this.run(["rev-parse", "--is-inside-work-tree"], cwd)).trim() === "true";
    if (!isRepository) throw new Error("The selected directory is not a Git repository");
    const rootPath = (await this.run(["rev-parse", "--show-toplevel"], cwd)).trim();
    const currentBranch = (await this.currentBranch(cwd)).trim();
    if (!currentBranch) throw new Error("The selected repository is not on a branch");
    let remoteUrl: string | undefined;
    try { remoteUrl = (await this.run(["config", "--get", "remote.origin.url"], cwd)).trim() || undefined; } catch { /* A local-only repository may not have an origin. */ }
    return { rootPath, currentBranch, remoteUrl };
  }
  async ensureWorktree(repoPath: string, worktreeRoot: string, branch: string, baseBranch: string, directoryName?: string): Promise<string> {
    const path = join(worktreeRoot, directoryName ?? branch.replaceAll("/", "-"));
    await this.fetchRemote(repoPath);
    await this.run(["worktree", "add", "-B", branch, path, baseBranch], repoPath);
    return path;
  }
  async createTaskWorktree(repoPath: string, worktreeRoot: string, preferredBranch: string, baseBranch: string, directoryName?: string, signal?: AbortSignal): Promise<GitWorktree> {
    const normalizedBranch = preferredBranch.trim();
    if (!normalizedBranch) throw new Error("Task branch name is required");
    const path = join(worktreeRoot, directoryName ?? normalizedBranch.replaceAll("/", "-"));
    await this.fetchRemote(repoPath, signal);
    const refs = new Set((await this.run(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], repoPath, undefined, signal)).split(/\r?\n/).filter(Boolean));
    const baseRef = originBranchRef(baseBranch);
    if (!refs.has(baseRef)) throw new Error(`Configured remote base branch does not exist: ${baseRef}`);
    let branch = normalizedBranch;
    for (let attempt = 0; hasBranch(refs, branch); attempt += 1) {
      if (attempt >= 100) throw new Error(`Unable to find an available branch name for ${normalizedBranch}`);
      branch = `${normalizedBranch}-${this.branchSuffix()}`;
    }
    await this.run(["worktree", "add", "-b", branch, path, baseRef], repoPath, undefined, signal);
    return { path, branch };
  }
  // 桌面应用是在临时 worktree 里替用户做自动提交,不是开发者在本地提交,
  // 所以必须绕开 pre-commit / commit-msg 等本地 hook (例如 worktree clone
  // 通常没有 `.husky/_/husky.sh` 或 `node_modules`,hook 一启动就报错)。
  async commit(cwd: string, message: string, signal?: AbortSignal): Promise<string> {
    await this.run(["add", "-A"], cwd, undefined, signal);
    try {
      await this.run(["commit", "--no-verify", "-m", message], cwd, undefined, signal);
    } catch (error) {
      // 二次提交场景:上一次 commit 已经成功 (只是 push 失败 / 进程崩溃 / hook 卡死),
      // worktree 已经是 clean 的,`git commit` 报 "nothing to commit, working tree clean"
      // 是 exitCode 1 + stdout 包含 "nothing to commit",属于无害失败。
      // 复用现有 HEAD 继续走 push,而不是把整个流程炸掉,让用户必须去 worktree 手动处理。
      const execaError = error as { exitCode?: number; stdout?: string };
      if (execaError.exitCode === 1 && /nothing to commit/.test(execaError.stdout ?? "")) {
        return this.run(["rev-parse", "HEAD"], cwd, undefined, signal);
      }
      throw error;
    }
    return this.run(["rev-parse", "HEAD"], cwd, undefined, signal);
  }
  // push 需要单独 timeout:commit 是本地操作,默认 10 分钟足够,但 push 涉及网络 + 数据上传,
  // 公司内网 GitLab (192.168.x.x) 在沙盒里经常不可达,git 默认无 timeout 会无限挂起,让用户干等。
  // 90 秒对正常 push 足够 (除非仓库几十 MB),够用且能尽快把网络问题暴露给用户。
  // 同时把网络错误 (Connection timed out / Could not resolve host 等) 包装成"无法连接到 GitLab: {url}"的友好信息,
  // 避免把原始 git stderr 抛回去让用户猜。
  async push(cwd: string, branch: string, token?: string, signal?: AbortSignal): Promise<string> {
    try {
      return await this.run([...(token ? ["-c", `http.extraHeader=PRIVATE-TOKEN: ${token}`] : []), "push", "--set-upstream", "origin", branch], cwd, 90_000, signal);
    } catch (error) {
      const execaError = error as { stdout?: string; stderr?: string; message?: string };
      const combined = `${execaError.stdout ?? ""}\n${execaError.stderr ?? ""}\n${execaError.message ?? ""}`;
      // 常见网络错误关键词,任一命中都说明是网络问题而不是代码问题
      if (/Connection timed out|Could not resolve host|Failed to connect|Connection refused|Network is unreachable|fatal: unable to access/.test(combined)) {
        const remoteUrl = await this.run(["config", "--get", "remote.origin.url"], cwd).catch(() => "<unknown>");
        throw new Error(`无法连接到 GitLab (${remoteUrl.trim()}): 网络不通或地址不可达,请检查网络 / VPN。\n\n原始错误: ${execaError.message ?? combined}`);
      }
      throw error;
    }
  }
  removeWorktree(repoPath: string, worktreePath: string): Promise<string> { return this.run(["worktree", "remove", "--force", worktreePath], repoPath); }
  pruneWorktrees(repoPath: string): Promise<string> { return this.run(["worktree", "prune"], repoPath); }

  /**
   * 在 `cwd` 中执行 `git checkout <targetBranch>`。
   * 用于「合并到 base 分支」工作流：先把 worktree 切到 base branch。
   */
  checkout(cwd: string, targetBranch: string, signal?: AbortSignal): Promise<string> {
    return this.run(["checkout", targetBranch], cwd, undefined, signal);
  }

  /**
   * 在 `cwd` 中执行 `git merge --no-ff <featureBranch> -m <message>`。
   * 用于「合并到 base 分支」工作流：保留合并记录，便于审计。
   */
  mergeNoFF(cwd: string, featureBranch: string, message: string, signal?: AbortSignal): Promise<string> {
    return this.run(["merge", "--no-ff", featureBranch, "-m", message], cwd, undefined, signal);
  }
}
