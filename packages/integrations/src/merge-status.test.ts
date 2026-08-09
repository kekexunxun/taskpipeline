import { describe, expect, it, vi } from "vitest";
import type { Task, TaskEventSink, TaskStore } from "@task-pipeline/core";
import { TaskCompleter } from "./merge-status.js";

const task: Task = {
  id: "task-1",
  source: "local",
  title: "Manual completion",
  description: "test",
  keywords: [],
  acceptanceCriteria: [],
  state: "awaiting_review",
  reviewStatus: "pending",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z"
};

describe("TaskCompleter", () => {
  it("marks Review as waived when a task is completed before Review passes", () => {
    const updateTask = vi.fn();
    const store = {
      getTask: () => task,
      listTaskRepositories: () => [],
      updateTask
    } as unknown as TaskStore;
    const sink = { addEvent: vi.fn() } as unknown as TaskEventSink;

    new TaskCompleter(store, sink).manualComplete(task.id);

    expect(updateTask).toHaveBeenCalledWith(task.id, {
      state: "completed",
      reviewStatus: "waived"
    });
  });

  it("preserves a passed Review when completing after Review", () => {
    const updateTask = vi.fn();
    const store = {
      getTask: () => ({ ...task, state: "awaiting_commit", reviewStatus: "passed" }),
      listTaskRepositories: () => [],
      updateTask
    } as unknown as TaskStore;
    const sink = { addEvent: vi.fn() } as unknown as TaskEventSink;

    new TaskCompleter(store, sink).manualComplete(task.id);

    expect(updateTask).toHaveBeenCalledWith(task.id, {
      state: "completed",
      reviewStatus: "passed"
    });
  });
});
