import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskCard } from "@coding-agent/core";
import { TaskCardView } from "./TaskCard";

const task: TaskCard = {
  id: "task-1",
  source: "local",
  title: "Remove task",
  description: "test",
  keywords: [],
  acceptanceCriteria: [],
  state: "completed",
  reviewStatus: "passed",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  boardColumn: "done",
  repositories: []
};

describe("TaskCardView", () => {
  it("does not show a Review status before a Todo task enters the Review flow", () => {
    render(
      <TaskCardView
        task={{ ...task, state: "draft", reviewStatus: "pending", boardColumn: "todo" }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );

    expect(screen.queryByText("待 Review")).not.toBeInTheDocument();
  });

  it("does not render an empty footer for an InProgress task without actions", () => {
    const { container } = render(
      <TaskCardView
        task={{ ...task, state: "implementing", reviewStatus: "pending", boardColumn: "in_progress" }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );

    expect(container.querySelector("article footer")).not.toBeInTheDocument();
  });

  it("shows a distinct status while waiting for user input", () => {
    render(
      <TaskCardView
        task={{ ...task, state: "awaiting_input", reviewStatus: "pending", boardColumn: "in_progress" }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("等待补充")).toBeInTheDocument();
    expect(screen.queryByText("实现中")).not.toBeInTheDocument();
  });

  it("shows no changes for a completed legacy task whose repository is still pending", () => {
    render(
      <TaskCardView
        task={{
          ...task,
          summary: "用户确认无需修改，任务已完成",
          repositories: [{ id: "repo-1", name: "repo", deliveryStatus: "pending" }]
        }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("无需修改")).toBeInTheDocument();
    expect(screen.queryByText("等待修改")).not.toBeInTheDocument();
  });

  it("renders the explicit unchanged repository status", () => {
    render(
      <TaskCardView
        task={{
          ...task,
          repositories: [{ id: "repo-1", name: "repo", deliveryStatus: "unchanged" }]
        }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("无需修改")).toBeInTheDocument();
  });

  it("prefers current file changes over a completed no-change summary", () => {
    render(
      <TaskCardView
        task={{
          ...task,
          summary: "代码已满足任务要求，无需修改",
          repositories: [{ id: "repo-1", name: "repo", deliveryStatus: "unchanged", changeSummary: "旧摘要", changedFileCount: 1 }]
        }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("1 个文件")).toBeInTheDocument();
    expect(screen.queryByText("无需修改")).not.toBeInTheDocument();
    expect(screen.queryByText("旧摘要")).not.toBeInTheDocument();
  });

  it("does not keep a stale changed status when an active task has no current changes", () => {
    render(
      <TaskCardView
        task={{
          ...task,
          state: "implementing",
          repositories: [{ id: "repo-1", name: "repo", deliveryStatus: "changed", changedFileCount: 0 }]
        }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("等待修改")).toBeInTheDocument();
    expect(screen.queryByText("已有修改")).not.toBeInTheDocument();
  });

  it("keeps delivery progress after changes have been committed", () => {
    render(
      <TaskCardView
        task={{
          ...task,
          state: "await_merge",
          repositories: [{ id: "repo-1", name: "repo", deliveryStatus: "mr_created", changedFileCount: 2 }]
        }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("MR 已提交")).toBeInTheDocument();
    expect(screen.queryByText("2 个文件")).not.toBeInTheDocument();
  });

  it("keeps the workspace removed status even when a stale file count exists", () => {
    render(
      <TaskCardView
        task={{
          ...task,
          repositories: [{ id: "repo-1", name: "repo", deliveryStatus: "workspace_removed", changedFileCount: 2 }]
        }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("工作区已清理")).toBeInTheDocument();
    expect(screen.queryByText("2 个文件")).not.toBeInTheDocument();
  });

  it("shows the Review status once the task enters the Review flow", () => {
    const { rerender } = render(
      <TaskCardView
        task={{ ...task, state: "awaiting_review", reviewStatus: "pending", boardColumn: "in_review" }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("待 Review")).toBeInTheDocument();
    rerender(
      <TaskCardView
        task={{ ...task, reviewStatus: "waived" }}
        active={false}
        removing={false}
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByText("Review 已跳过")).toBeInTheDocument();
  });

  it("requires confirmation before removing a task", async () => {
    const onRemove = vi.fn().mockResolvedValue(true);
    render(
      <TaskCardView
        task={task}
        active={false}
        removing={false}
        onOpen={vi.fn()}
        onRemove={onRemove}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "移除任务" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "全部删除" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("all"));
  });

  it("can clean only the Worktree while preserving the task", async () => {
    const onRemove = vi.fn().mockResolvedValue(true);
    render(
      <TaskCardView
        task={task}
        active={false}
        removing={false}
        onOpen={vi.fn()}
        onRemove={onRemove}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "移除任务" }));
    fireEvent.click(screen.getByRole("button", { name: "仅清理 Worktree" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("workspace"));
  });

  it("locks all card actions while removal is pending", () => {
    render(
      <TaskCardView
        task={task}
        active={false}
        removing
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn().mockResolvedValue(true)}
      />
    );

    expect(screen.getByText("删除中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `打开任务 ${task.title}`, hidden: true })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑任务" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除任务" })).toBeDisabled();
  });

  it("keeps the confirmation open until asynchronous removal finishes", async () => {
    let finish!: (value: boolean) => void;
    const onRemove = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(
      <TaskCardView
        task={task}
        active={false}
        removing={false}
        onOpen={vi.fn()}
        onRemove={onRemove}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "移除任务" }));
    fireEvent.click(screen.getByRole("button", { name: "全部删除" }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除中" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "仅清理 Worktree" })).toBeDisabled();
    const openButton = document.querySelector(
      `button[aria-label="打开任务 ${task.title}"]`
    );
    expect(openButton).toBeDisabled();

    await act(async () => finish(true));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});
