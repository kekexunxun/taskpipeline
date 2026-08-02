import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskCard } from "@coding-agent/core";
import { TaskCardView } from "./TaskCard";

const task: TaskCard = {
  id: "task-1",
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
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledOnce());
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

    expect(screen.getByText("移除中")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除中" })).toBeDisabled();
    const openButton = document.querySelector(
      `button[aria-label="打开任务 ${task.title}"]`
    );
    expect(openButton).toBeDisabled();

    await act(async () => finish(true));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});
