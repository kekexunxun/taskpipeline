import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore, type AgentEvent, type Task, type TaskEventSink, type TaskRepository, type SettingResolver } from "@coding-agent/core";
import { DeliveryService } from "./delivery.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { vi.clearAllMocks(); });

function createStore(): TaskStore {
  const dir = mkdtempSync(join(tmpdir(), "coding-agent-delivery-")); dirs.push(dir);
  return new TaskStore(join(dir, "store.db"));
}

const resolver: SettingResolver = { get: () => undefined, getSecret: () => "test-token" };

const gitMock = { commit: vi.fn().mockResolvedValue("abc123"), push: vi.fn().mockResolvedValue(undefined) };

/** 把事件收集到内存数组，同时写回 store（与 DesktopEventSink 行为一致）。 */
function createSink(store: TaskStore): { sink: TaskEventSink; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    sink: { addEvent: (input) => { const event = store.addEvent(input); events.push(event); return event; }, emitChanged: () => undefined },
    events
  };
}

function setupAwaitingCommitTask(store: TaskStore): { task: Task; repo: TaskRepository } {
  store.saveRepositoryProfile({ id: "repo-a", name: "repo-a", localPath: "/tmp/repo-a", remoteUrl: "git@gitlab.example.com:group/repo-a.git", defaultBranch: "main" });
  const task = store.createTask({ title: "Delivery task", description: "test" });
  store.updateTask(task.id, { state: "awaiting_commit", commitMessage: "feat: delivery" });
  const repo = store.attachRepository(task.id, "repo-a");
  store.updateTaskRepository(repo.id, { worktreePath: "/tmp/repo-a", featureBranch: "feature/1", baseBranch: "main" });
  return { task, repo };
}

describe("DeliveryService 交付确认点（Phase 1 HITL）", () => {
  it("未注入 approver 时默认直接执行（常规可行，等价于 deliveryConfirm 关闭）", async () => {
    const store = createStore();
    const { sink } = createSink(store);
    const { task } = setupAwaitingCommitTask(store);
    const service = new DeliveryService(store, gitMock as never, resolver, sink, {
      gitlabFactory: () => ({ createMergeRequest: vi.fn().mockResolvedValue({ web_url: "https://gitlab.example.com/mr/1", iid: 1 }) }) as never
    });
    await service.submitMergeRequests(task.id);
    expect(gitMock.commit).toHaveBeenCalledTimes(1);
    expect(gitMock.push).toHaveBeenCalledTimes(1);
    expect(store.getTask(task.id)?.state).toBe("await_merge");
    // 无 approver 时不产生任何 permission 事件
    expect(store.listEvents(task.id).some((event) => event.kind === "permission")).toBe(false);
  });

  it("approver 返回 false 时拒绝 commit 并退回 awaiting_commit，不执行 git 操作", async () => {
    const store = createStore();
    const { sink, events } = createSink(store);
    const { task } = setupAwaitingCommitTask(store);
    const service = new DeliveryService(store, gitMock as never, resolver, sink, {
      approver: async () => false,
      gitlabFactory: () => ({ createMergeRequest: vi.fn() }) as never
    });
    await service.submitMergeRequests(task.id);
    expect(gitMock.commit).not.toHaveBeenCalled();
    expect(gitMock.push).not.toHaveBeenCalled();
    expect(store.getTask(task.id)?.state).toBe("awaiting_commit");
    expect(events.some((event) => event.kind === "permission" && event.title.includes("已拒绝 commit"))).toBe(true);
  });

  it("approver 接收 commit/push/merge_request 三种确认，全部允许后走到 await_merge", async () => {
    const store = createStore();
    const { sink } = createSink(store);
    const { task } = setupAwaitingCommitTask(store);
    const kinds: string[] = [];
    const service = new DeliveryService(store, gitMock as never, resolver, sink, {
      approver: async (_t, kind) => { kinds.push(kind); return true; },
      gitlabFactory: () => ({ createMergeRequest: vi.fn().mockResolvedValue({ web_url: "https://gitlab.example.com/mr/1", iid: 1 }) }) as never
    });
    await service.submitMergeRequests(task.id);
    expect(kinds).toEqual(["commit", "push", "merge_request"]);
    expect(gitMock.commit).toHaveBeenCalledTimes(1);
    expect(gitMock.push).toHaveBeenCalledTimes(1);
    expect(store.getTask(task.id)?.state).toBe("await_merge");
  });

  it("approver 在 push 前拒绝时退回 awaiting_commit 且不执行 push", async () => {
    const store = createStore();
    const { sink } = createSink(store);
    const { task } = setupAwaitingCommitTask(store);
    let pushDenied = false;
    const service = new DeliveryService(store, gitMock as never, resolver, sink, {
      approver: async (_t, kind) => {
        if (kind === "push") { pushDenied = true; return false; }
        return true;
      },
      gitlabFactory: () => ({ createMergeRequest: vi.fn() }) as never
    });
    await service.submitMergeRequests(task.id);
    expect(pushDenied).toBe(true);
    expect(gitMock.commit).toHaveBeenCalledTimes(1);
    expect(gitMock.push).not.toHaveBeenCalled();
    expect(store.getTask(task.id)?.state).toBe("awaiting_commit");
  });
});
