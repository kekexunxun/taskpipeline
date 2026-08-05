import { describe, expect, it, vi } from "vitest";
import type { Task, TaskEventSink, TaskStore } from "@coding-agent/core";
import { TaskWorkflow } from "./task-workflow.js";

const waitingTask: Task = {
  id: "task-1",
  source: "local",
  title: "No changes",
  description: "",
  keywords: [],
  acceptanceCriteria: [],
  state: "awaiting_input",
  reviewStatus: "pending",
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z"
};

describe("TaskWorkflow.completeAtUserRequest", () => {
  it("completes a waiting task without starting another implementation turn", () => {
    const updateTask = vi.fn((_id: string, patch: Partial<Task>) => ({ ...waitingTask, ...patch }));
    const updateTaskRepository = vi.fn();
    const store = {
      getTask: () => waitingTask,
      updateTask,
      listTaskRepositories: () => [{ id: "repo-1" }],
      updateTaskRepository
    } as unknown as TaskStore;
    const sink = { addEvent: vi.fn() } as unknown as TaskEventSink;
    const workflow = new TaskWorkflow(store, { get: () => undefined, getSecret: () => undefined }, sink, () => "/tmp/task-1");

    expect(workflow.completeAtUserRequest(waitingTask.id)).toMatchObject({
      state: "completed",
      summary: "用户确认无需修改，任务已完成",
      reviewStatus: "waived"
    });
    expect(sink.addEvent).toHaveBeenCalledWith({
      taskId: waitingTask.id,
      kind: "status",
      title: "用户确认无需修改，任务已完成"
    });
    expect(updateTaskRepository).toHaveBeenCalledWith("repo-1", { deliveryStatus: "unchanged" });
  });
});

describe("TaskWorkflow cancellation", () => {
  it("cancels a running validation command without advancing the task", async () => {
    let current: Task = { ...waitingTask, state: "implementing" };
    const store = {
      getTask: () => current,
      updateTask: (_id: string, patch: Partial<Task>) => (current = { ...current, ...patch }),
      listTaskRepositories: () => [{ id: "repo-1", name: "repo", localPath: "/tmp/repo", baseBranch: "main", worktreePath: "/tmp/repo", testCommand: "test" }]
    } as unknown as TaskStore;
    const sink = { addEvent: vi.fn() } as unknown as TaskEventSink;
    let receivedSignal: AbortSignal | undefined;
    const shell = ((_command: string, options?: { cancelSignal?: AbortSignal }) => new Promise((_resolve, reject) => {
      receivedSignal = options?.cancelSignal;
      options?.cancelSignal?.addEventListener("abort", () => reject(options.cancelSignal?.reason), { once: true });
    })) as any;
    const workflow = new TaskWorkflow(store, { get: () => undefined, getSecret: () => undefined }, sink, () => "/tmp/task-1", undefined, undefined, shell);
    const controller = new AbortController();

    const validation = workflow.runValidation(current.id, controller.signal);
    expect(receivedSignal).toBe(controller.signal);
    controller.abort(new Error("task deleted"));

    await expect(validation).rejects.toThrow("task deleted");
    expect(current.state).toBe("validating");
  });
});

describe("TaskWorkflow test case generation state", () => {
  it("transitions implementing -> generating_tests -> implementing (task level) when begin/finish are called", () => {
    const states: Task["state"][] = [];
    let current: Task = { ...waitingTask, state: "implementing", createTestCasesEnabled: true };
    const store = {
      getTask: () => current,
      updateTask: (_id: string, patch: Partial<Task>) => (current = { ...current, ...patch })
    } as unknown as TaskStore;
    const sink = { addEvent: vi.fn() } as unknown as TaskEventSink;
    const workflow = new TaskWorkflow(store, { get: () => "true", getSecret: () => undefined }, sink, () => "/tmp/task-1");

    expect(workflow.shouldGenerateTestCases(current)).toBe(true);
    states.push(workflow.beginTestCaseGeneration(current.id).state);
    states.push((workflow.finishTestCaseGeneration(current.id, { files: ["src/foo.test.ts"], commitSha: "abc1234", summary: "ok" }).state));
    expect(states).toEqual(["generating_tests", "implementing"]);
    expect(current.testsGenerated).toMatchObject({ files: ["src/foo.test.ts"], commitSha: "abc1234" });
    expect(sink.addEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "status", title: "已生成 1 个测试用例" }));
  });

  it("falls back to system setting when task-level override is undefined", () => {
    const current: Task = { ...waitingTask, state: "implementing" };
    const store = { getTask: () => current, updateTask: vi.fn() } as unknown as TaskStore;
    const sink = { addEvent: vi.fn() } as unknown as TaskEventSink;
    const enabledWorkflow = new TaskWorkflow(store, { get: (key) => key === "createTestCasesEnabled" ? "true" : undefined, getSecret: () => undefined }, sink, () => "/tmp/task-1");
    expect(enabledWorkflow.shouldGenerateTestCases(current)).toBe(true);
    const disabledWorkflow = new TaskWorkflow(store, { get: (key) => key === "createTestCasesEnabled" ? "false" : undefined, getSecret: () => undefined }, sink, () => "/tmp/task-1");
    expect(disabledWorkflow.shouldGenerateTestCases(current)).toBe(false);
  });

  it("task-level explicit override wins over system setting", () => {
    const current: Task = { ...waitingTask, state: "implementing", createTestCasesEnabled: false };
    const store = { getTask: () => current, updateTask: vi.fn() } as unknown as TaskStore;
    const sink = { addEvent: vi.fn() } as unknown as TaskEventSink;
    const workflow = new TaskWorkflow(store, { get: (key) => key === "createTestCasesEnabled" ? "true" : undefined, getSecret: () => undefined }, sink, () => "/tmp/task-1");
    expect(workflow.shouldGenerateTestCases(current)).toBe(false);
  });

  it("rejects beginTestCaseGeneration when not in implementing", () => {
    const current: Task = { ...waitingTask, state: "reviewing" };
    const store = { getTask: () => current, updateTask: vi.fn() } as unknown as TaskStore;
    const sink = { addEvent: vi.fn() } as unknown as TaskEventSink;
    const workflow = new TaskWorkflow(store, { get: () => "true", getSecret: () => undefined }, sink, () => "/tmp/task-1");
    expect(() => workflow.beginTestCaseGeneration(current.id)).toThrow("当前任务不能生成测试用例");
  });
});
