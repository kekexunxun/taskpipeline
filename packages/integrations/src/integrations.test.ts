import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@coding-agent/core";
import { GitService } from "./git.js";
import { parseGitLabRemote } from "./gitlab.js";
import { mapJiraTasks } from "./jira.js";
import { McpClient } from "./mcp.js";
import { OpenCodeReviewService, extractFirstJsonObject } from "./review.js";
import { TaskWorkflow } from "./task-workflow.js";

describe("Jira mapping", () => {
  it("maps internal MCP text content using configurable field paths", () => {
    const response = { content: [{ type: "text", text: JSON.stringify({ data: { tickets: [{ id: "PAY-7", subject: "Fix checkout", body: "Race", tags: ["pay"], state: "Doing" }] } }) }] };
    const tasks = mapJiraTasks(response, { itemsPath: "data.tickets", fields: { key: "id", title: "subject", description: "body", keywords: "tags", status: "state" }, statusMap: { Doing: "implementing" } });
    expect(tasks).toEqual([{ jiraKey: "PAY-7", title: "Fix checkout", description: "Race", keywords: ["pay"], acceptanceCriteria: [], state: "implementing" }]);
  });

  it("maps the simplified issue shape returned by mcp-atlassian", () => {
    const response = { content: [{ type: "text", text: JSON.stringify({ total: 1, issues: [{ key: "OPS-12", summary: "Fix export", description: "Include audit fields", labels: ["audit"], status: { name: "Open" } }] }) }] };
    expect(mapJiraTasks(response)).toEqual([{ jiraKey: "OPS-12", title: "Fix export", description: "Include audit fields", keywords: ["audit"], acceptanceCriteria: [], state: "draft" }]);
  });
});

describe("MCP", () => {
  it("initializes Streamable HTTP and forwards an environment token", async () => {
    const calls: any[] = [];
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ body, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(body.id ? { jsonrpc: "2.0", id: body.id, result: body.method === "tools/call" ? { content: [] } : {} } : {}), { headers: { "content-type": "application/json" } });
    };
    const client = new McpClient({ id: "jira", name: "jira", transport: "streamable-http", url: "https://jira-mcp.internal", tokenEnv: "TEST_MCP_TOKEN", tools: { search: "search" } }, { TEST_MCP_TOKEN: "token-value" }, fetcher as typeof fetch);
    await client.callTool("search", { query: "mine" }); client.close();
    expect(calls.some((call) => call.body.method === "tools/call")).toBe(true);
    expect(calls[0].authorization).toBe("Bearer token-value");
  });

  it("connects to a legacy SSE endpoint and receives tool responses", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const posts: Array<{ url: string; body: any; authorization: string | null }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      if (!init?.method) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
          }
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      const body = JSON.parse(String(init.body));
      posts.push({ url: String(input), body, authorization: new Headers(init.headers).get("authorization") });
      if (body.id) {
        const result = body.method === "tools/call" ? { content: [{ type: "text", text: "ok" }] } : {};
        queueMicrotask(() => streamController?.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`)));
      }
      return new Response(null, { status: 202 });
    };
    const client = new McpClient({ id: "jira", name: "jira", transport: "sse", url: "https://jira-mcp.internal/sse", tokenEnv: "TEST_MCP_TOKEN", tools: { search: "search" } }, { TEST_MCP_TOKEN: "token-value" }, fetcher as typeof fetch);
    await expect(client.callTool("search", { query: "mine" })).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    client.close();
    expect(posts.some((call) => call.url === "https://jira-mcp.internal/messages" && call.body.method === "tools/call")).toBe(true);
    expect(posts.every((call) => call.authorization === "Bearer token-value")).toBe(true);
  });
});

describe("process integrations", () => {
  it("parses Open Code Review JSON through an injected runner", async () => {
    const review = new OpenCodeReviewService("ocr", async () => ({ stdout: JSON.stringify({ status: "completed", comments: [{ severity: "high" }] }), stderr: "", exitCode: 0 }));
    await expect(review.review(process.cwd())).resolves.toMatchObject({ status: "completed", comments: [{ severity: "high" }] });
  });

  it("returns raw markdown from ocr delegate rule without parsing", async () => {
    const service = new OpenCodeReviewService("ocr", async (_binary, args) => {
      expect(args.slice(0, 2)).toEqual(["delegate", "rule"]);
      return { stdout: "### Rule Group 1\n\nApplies to:\n- src/a.ts", stderr: "", exitCode: 0 };
    });
    const markdown = await service.rule("/repo", ["src/a.ts", "src/b.ts"]);
    expect(markdown).toBe("### Rule Group 1\n\nApplies to:\n- src/a.ts");
  });

  it("includes execa failure reason when ocr cannot be launched", async () => {
    const service = new OpenCodeReviewService("ocr-missing", async () => ({ stdout: "", stderr: "", exitCode: 1, failed: true, reason: "ENOENT", shortMessage: "Command failed with ENOENT" }));
    await expect(service.review("/repo")).rejects.toThrow(/exit.*1.*reason=ENOENT/);
  });

  it("exposes stderr when ocr exits non-zero with empty stdout", async () => {
    const service = new OpenCodeReviewService("ocr", async () => ({ stdout: "", stderr: "no rule.json", exitCode: 2 }));
    await expect(service.review("/repo")).rejects.toThrow(/stderr: no rule\.json/);
  });

  it("skips the rule subprocess when there are no paths", async () => {
    let called = false;
    const service = new OpenCodeReviewService("ocr", async () => { called = true; return { stdout: "", stderr: "", exitCode: 0 }; });
    const rules = await service.rule("/repo", []);
    expect(called).toBe(false);
    expect(rules).toBe("");
  });

  it("creates a branch worktree with the expected Git sequence", async () => {
    const calls: string[][] = [];
    const git = new GitService(async (args) => { calls.push(args); return ""; });
    const path = await git.ensureWorktree("/repo", "/worktrees", "agent/ABC-1-fix", "main");
    expect(path).toBe("/worktrees/agent-ABC-1-fix");
    expect(calls).toEqual([["fetch", "--all", "--prune"], ["worktree", "add", "-B", "agent/ABC-1-fix", "/worktrees/agent-ABC-1-fix", "main"]]);
  });

  it("uses a repository-specific folder inside a shared task workspace", async () => {
    const calls: string[][] = [];
    const git = new GitService(async (args) => { calls.push(args); return ""; });
    const path = await git.ensureWorktree("/repo", "/workspaces/task-1", "agent/ABC-1-fix", "main", "payment-service");
    expect(path).toBe("/workspaces/task-1/payment-service");
    expect(calls[1]).toEqual(["worktree", "add", "-B", "agent/ABC-1-fix", "/workspaces/task-1/payment-service", "main"]);
  });

  it("creates a task branch named after its Jira key from the configured base branch", async () => {
    const calls: string[][] = [];
    const git = new GitService(async (args) => {
      calls.push(args);
      return args[0] === "for-each-ref" ? "refs/heads/release/next\nrefs/remotes/origin/release/next\n" : "";
    });
    const worktree = await git.createTaskWorktree("/repo", "/workspaces/task-1", "ABC-123", "release/next", "payment-service");
    expect(worktree).toEqual({ path: "/workspaces/task-1/payment-service", branch: "ABC-123" });
    expect(calls).toEqual([
      ["fetch", "--all", "--prune"],
      ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
      ["worktree", "add", "-b", "ABC-123", "/workspaces/task-1/payment-service", "refs/remotes/origin/release/next"]
    ]);
  });

  it("adds a four-character random suffix when the Jira branch already exists locally or remotely", async () => {
    const suffixes = ["asda", "b7c9"];
    const git = new GitService(async (args) => {
      if (args[0] === "for-each-ref") return "refs/heads/ABC-123\nrefs/remotes/origin/ABC-123-asda\nrefs/remotes/origin/main\n";
      return "";
    }, () => suffixes.shift()!);
    await expect(git.createTaskWorktree("/repo", "/workspaces/task-1", "ABC-123", "main")).resolves.toEqual({
      path: "/workspaces/task-1/ABC-123",
      branch: "ABC-123-b7c9"
    });
  });

  it("fails instead of falling back to a local branch when the configured remote base is missing", async () => {
    const calls: string[][] = [];
    const git = new GitService(async (args) => {
      calls.push(args);
      return args[0] === "for-each-ref" ? "refs/heads/main\n" : "";
    });
    await expect(git.createTaskWorktree("/repo", "/workspaces/task-1", "ABC-123", "main")).rejects.toThrow("refs/remotes/origin/main");
    expect(calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  it("reads repository metadata from the selected folder", async () => {
    const git = new GitService(async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[0] === "branch") return "feature/settings\n";
      if (args[0] === "config") return "git@gitlab.example.com:group/repo.git\n";
      return "";
    });
    await expect(git.inspectRepository("/repo")).resolves.toEqual({
      rootPath: "/repo",
      currentBranch: "feature/settings",
      remoteUrl: "git@gitlab.example.com:group/repo.git"
    });
  });

  it("rejects a selected folder that is not a Git repository", async () => {
    const git = new GitService(async () => "false\n");
    await expect(git.inspectRepository("/folder")).rejects.toThrow("not a Git repository");
  });

  it("reads a diff between arbitrary refs with optional pathspecs", async () => {
    const calls: string[][] = [];
    const git = new GitService(async (args) => { calls.push(args); return "diff text"; });
    expect(await git.diffRange("/repo", "main..feature", ["src/a.ts", "src/b.ts"])).toBe("diff text");
    expect(calls[0]).toEqual(["diff", "--no-color", "main..feature", "--", "src/a.ts", "src/b.ts"]);
  });

  it("reads a single commit diff via git show with empty format", async () => {
    const calls: string[][] = [];
    const git = new GitService(async (args) => { calls.push(args); return "patch"; });
    expect(await git.showCommit("/repo", "abc123", ["src/a.ts"])).toBe("patch");
    expect(calls[0]).toEqual(["show", "--no-color", "--format=", "abc123", "--", "src/a.ts"]);
  });

  it("combines committed and working-tree changed files", async () => {
    const git = new GitService(async (args) => {
      if (args[0] === "diff") return "M\0src/changed.ts\0R100\0src/old.ts\0src/renamed.ts\0";
      if (args[0] === "status") return " M src/changed.ts\0?? src/new.ts\0";
      return "";
    });
    await expect(git.changedFiles("/repo", "main")).resolves.toEqual([
      { path: "src/changed.ts", status: "M" },
      { path: "src/new.ts", status: "??" },
      { path: "src/renamed.ts", status: "R" }
    ]);
  });

  it("bypasses local pre-commit / commit-msg hooks when staging, committing and reading HEAD", async () => {
    const calls: string[][] = [];
    const git = new GitService(async (args) => { calls.push(args); return args[0] === "rev-parse" ? "abc123\n" : ""; });
    const sha = await git.commit("/repo", "feat: skip husky");
    expect(sha).toBe("abc123\n");
    expect(calls).toEqual([
      ["add", "-A"],
      ["commit", "--no-verify", "-m", "feat: skip husky"],
      ["rev-parse", "HEAD"]
    ]);
  });

  it("reuses the existing HEAD when worktree is already clean (retry after commit-succeeded-but-push-failed)", async () => {
    const calls: string[][] = [];
    const execaError = Object.assign(new Error("Command failed with exit code 1: git commit --no-verify -m '...'"), { exitCode: 1, stdout: "On branch agent/bsadapt344-36488-adaptor\nnothing to commit, working tree clean\n", stderr: "" });
    const git = new GitService(async (args) => {
      calls.push(args);
      if (args[0] === "commit") throw execaError;
      return args[0] === "rev-parse" ? "deadbeef\n" : "";
    });
    const sha = await git.commit("/repo", "feat: retry");
    expect(sha).toBe("deadbeef\n");
    // 关键:没有 throw 出去,而是直接走到 rev-parse HEAD 复用上一次的 commit
    expect(calls).toEqual([
      ["add", "-A"],
      ["commit", "--no-verify", "-m", "feat: retry"],
      ["rev-parse", "HEAD"]
    ]);
  });

  it("still throws on real commit failures (e.g. husky rejects the commit message)", async () => {
    // 不是 "nothing to commit" 的失败要原样抛出去,不能让 nothing-to-commit 兜底逻辑把真实错误吞掉。
    const execaError = Object.assign(new Error("Command failed with exit code 1: git commit --no-verify -m '...'"), { exitCode: 1, stdout: "husky > commit-msg hook failed", stderr: "" });
    const git = new GitService(async (args) => { if (args[0] === "commit") throw execaError; return ""; });
    await expect(git.commit("/repo", "feat: bad")).rejects.toBe(execaError);
  });

  it("wraps push network failures with a friendly \"cannot reach GitLab\" message", async () => {
    // 沙盒/公司内网常见场景:内网 GitLab (192.168.x.x) 不可达,git push 报 Connection timed out。
    // 默认要等满 10 分钟才能被 execa timeout 接住,体验很差。push 自己识别网络错误立刻抛友好错误。
    let configGetCalled = false;
    const git = new GitService(async (args) => {
      // push 命令的第一个参数是 "-c" (带 token 时),不是 "push"。
      if (args.includes("push")) {
        const err = Object.assign(new Error("Command failed: git push"), { exitCode: 128, stdout: "", stderr: "fatal: unable to access 'http://192.168.175.129:90/adaptor/adaptor-suit-front.git/': Failed to connect to 192.168.175.129 port 90: Connection timed out" });
        throw err;
      }
      if (args[0] === "config") { configGetCalled = true; return "http://192.168.175.129:90/adaptor/adaptor-suit-front.git\n"; }
      return "";
    });
    await expect(git.push("/repo", "feature/x", "glpat-xxx")).rejects.toThrow(/无法连接到 GitLab/);
    await expect(git.push("/repo", "feature/x", "glpat-xxx")).rejects.toThrow(/192\.168\.175\.129/);
    expect(configGetCalled).toBe(true);
  });

  it("leaves non-network push errors untouched (e.g. auth rejected)", async () => {
    // 401 / 403 / "Authentication failed" 这类不是网络问题,要原样抛出去,不要被网络识别误判吞掉。
    const git = new GitService(async (args) => {
      if (!args.includes("push")) return "";
      const err = Object.assign(new Error("Command failed: git push"), { exitCode: 128, stdout: "", stderr: "remote: HTTP Basic: Access denied. The provided password or token is incorrect." });
      throw err;
    });
    await expect(git.push("/repo", "feature/x", "wrong-token")).rejects.toBeInstanceOf(Error);
  });
});

describe("task command workflow", () => {
  it("restarts a failed setup and lets a task override clear the repository default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coding-agent-workflow-"));
    try {
      const store = new TaskStore(join(dir, "store.db"));
      store.saveRepositoryProfile({ id: "repo", name: "repo", localPath: dir, defaultBranch: "main", setupCommand: "install" });
      const task = store.createTask({ title: "Retry setup", description: "test", state: "failed" });
      const taskRepo = store.addTaskRepository({ taskId: task.id, repositoryId: "repo", name: "repo", localPath: dir, baseBranch: "main", setupCommand: "install", deliveryStatus: "pending" });
      const calls: string[] = [];
      const workflow = new TaskWorkflow(store, { get: () => undefined, getSecret: () => undefined }, { addEvent: (event) => store.addEvent(event), emitChanged: () => undefined }, () => dir, undefined, undefined, (async (command: string) => { calls.push(command); return { stdout: "", stderr: "", command, exitCode: 0 }; }) as any);

      await expect(workflow.begin(task.id, "direct", { repo: { setupCommand: "" } })).resolves.toMatchObject({ state: "implementing" });

      expect(calls).toEqual([]);
      expect(store.listTaskRepositories(task.id).find((repo) => repo.id === taskRepo.id)?.setupCommand).toBe("");
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("completes a planning task when the repository already satisfies the request", () => {
    const dir = mkdtempSync(join(tmpdir(), "coding-agent-workflow-"));
    try {
      const store = new TaskStore(join(dir, "store.db"));
      const task = store.createTask({ title: "Already done", description: "test", state: "planning" });
      const workflow = new TaskWorkflow(store, { get: () => undefined, getSecret: () => undefined }, { addEvent: (event) => store.addEvent(event), emitChanged: () => undefined }, () => dir);

      const completed = workflow.completeWithoutChanges(task.id, "现有实现已经满足验收条件。无需修改代码。");

      expect(completed).toMatchObject({
        state: "completed",
        planContent: "现有实现已经满足验收条件。无需修改代码。",
        planRevision: 1,
        summary: "代码已满足任务要求，无需修改"
      });
      expect(store.listEvents(task.id).some((event) => event.title === "代码已满足要求，任务自动完成")).toBe(true);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs validation commands in the configured order and records failure state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coding-agent-workflow-"));
    try {
      const store = new TaskStore(join(dir, "store.db"));
      const task = store.createTask({ title: "Validate", description: "test", state: "implementing" });
      store.addTaskRepository({ taskId: task.id, repositoryId: "repo", name: "repo", localPath: dir, baseBranch: "main", worktreePath: dir, lintCommand: "lint", testCommand: "test", buildCommand: "build", deliveryStatus: "pending" });
      const calls: string[] = [];
      const workflow = new TaskWorkflow(store, { get: () => undefined, getSecret: () => undefined }, { addEvent: (event) => store.addEvent(event), emitChanged: () => undefined }, () => dir, undefined, undefined, (async (command: string) => { calls.push(command); return { stdout: "", stderr: "", command, exitCode: 0 }; }) as any);
      await expect(workflow.runValidation(task.id)).resolves.toMatchObject({ state: "awaiting_review" });
      expect(calls).toEqual(["lint", "test", "build"]);
      expect(store.listEvents(task.id).some((event) => event.title.includes("Build 通过"))).toBe(true);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("GitLab remote parsing", () => {
  it("derives API host and project path from HTTPS and SSH remotes", () => {
    expect(parseGitLabRemote("https://gitlab.example.com/group/service.git")).toEqual({ baseUrl: "https://gitlab.example.com", projectId: "group/service" });
    expect(parseGitLabRemote("git@gitlab.example.com:group/service.git")).toEqual({ baseUrl: "https://gitlab.example.com", projectId: "group/service" });
  });
});

describe("extractFirstJsonObject", () => {
  it("extracts JSON wrapped in a markdown code fence", () => {
    const text = "```json\n{\"status\":\"completed\",\"comments\":[]}\n```";
    expect(extractFirstJsonObject(text)).toBe("{\"status\":\"completed\",\"comments\":[]}");
  });

  it("returns only the first JSON when the LLM streams the same response twice", () => {
    const json = "{\"status\":\"completed\",\"comments\":[{\"path\":\"a.ts\",\"line\":1,\"severity\":\"low\",\"message\":\"x\"}]}";
    const text = `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``;
    const extracted = extractFirstJsonObject(text);
    expect(JSON.parse(extracted)).toEqual(JSON.parse(json));
  });

  it("does not treat braces inside string literals as structural", () => {
    const text = '{"message":"contains { and } inside","ok":true}';
    expect(extractFirstJsonObject(text)).toBe(text);
  });

  it("handles escaped quotes inside string literals", () => {
    const text = '{"message":"he said \\"hi\\" {not json}","ok":true}';
    expect(extractFirstJsonObject(text)).toBe(text);
  });

  it("throws when no opening brace exists", () => {
    expect(() => extractFirstJsonObject("no json here")).toThrow(/no '\{' found/);
  });

  it("throws when braces are unbalanced", () => {
    expect(() => extractFirstJsonObject('{"a":1')).toThrow(/unbalanced/);
  });
});
