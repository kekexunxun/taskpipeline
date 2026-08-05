import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCard } from "@coding-agent/core";
import { DetailActions } from "./DetailActions";

const card: TaskCard = {
  id: "task-1",
  source: "local",
  title: "Resume task",
  description: "test",
  keywords: [],
  acceptanceCriteria: [],
  state: "preparing",
  reviewStatus: "pending",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  boardColumn: "in_progress",
  repositories: []
};

function cardWithState(state: TaskCard["state"]): TaskCard {
  return { ...card, state };
}

const callbacks = {
  onStart: vi.fn(),
  onAbort: vi.fn(),
  onReview: vi.fn(),
  onResetReview: vi.fn(),
  onResetDelivery: vi.fn(),
  onRetryValidation: vi.fn(),
  onSubmitMR: vi.fn(),
  onManualComplete: vi.fn(),
  onReimplement: vi.fn(),
  onResume: vi.fn()
};

describe("DetailActions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hides continue while a start request is preparing the task", () => {
    const { rerender } = render(<DetailActions card={card} running={false} starting canSubmit={false} merging={false} {...callbacks} />);

    expect(screen.getByRole("button", { name: "启动中" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "继续执行" })).not.toBeInTheDocument();

    rerender(<DetailActions card={card} running={false} starting={false} canSubmit={false} merging={false} {...callbacks} />);
    expect(screen.getByRole("button", { name: "继续执行" })).toBeEnabled();
  });

  it("shows the manual MR submission action while awaiting commit", () => {
    render(<DetailActions card={cardWithState("awaiting_commit")} running={false} starting={false} canSubmit merging={false} {...callbacks} />);

    expect(screen.getByRole("button", { name: "手动提交 MR" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "完成任务" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "重置提交" })).not.toBeInTheDocument();
  });

  it("shows manual completion while waiting for merge", () => {
    render(<DetailActions card={cardWithState("await_merge")} running={false} starting={false} canSubmit={false} merging={false} {...callbacks} />);

    expect(screen.getByRole("button", { name: "完成任务" })).toBeEnabled();
  });

  it("offers manual completion before optional review or MR submission", () => {
    render(<DetailActions card={cardWithState("awaiting_review")} running={false} starting={false} canSubmit={false} merging={false} {...callbacks} />);

    expect(screen.getByRole("button", { name: "开始 Review" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "完成任务" })).toBeEnabled();
  });

  it("requires confirmation before manually completing", () => {
    render(<DetailActions card={cardWithState("awaiting_commit")} running={false} starting={false} canSubmit merging={false} {...callbacks} />);

    fireEvent.click(screen.getByRole("button", { name: "完成任务" }));
    expect(callbacks.onManualComplete).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认完成" }));
    expect(callbacks.onManualComplete).toHaveBeenCalledOnce();
  });

  it("only shows terminate while the agent is running", () => {
    render(<DetailActions card={cardWithState("implementing")} running starting={false} canSubmit={false} merging={false} {...callbacks} />);

    expect(screen.getByRole("button", { name: "终止" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "继续执行" })).not.toBeInTheDocument();
  });

  it("shows a waiting status instead of a continue action while waiting for input", () => {
    render(<DetailActions card={cardWithState("awaiting_input")} running={false} starting={false} canSubmit={false} merging={false} {...callbacks} />);

    expect(screen.getByText("等待补充")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续执行" })).not.toBeInTheDocument();
  });

  it("re-runs review after a blocked review", () => {
    render(<DetailActions card={cardWithState("review_blocked")} running={false} starting={false} canSubmit={false} merging={false} {...callbacks} />);

    expect(screen.getByRole("button", { name: "重新 Review" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "重置 Review" })).not.toBeInTheDocument();
  });

  it("offers resume and restart after a failed task", () => {
    render(<DetailActions card={cardWithState("failed")} running={false} starting={false} canSubmit={false} merging={false} {...callbacks} />);

    const resume = screen.getByRole("button", { name: "继续执行" });
    const restart = screen.getByRole("button", { name: "重新开始" });
    expect(resume).toBeEnabled();
    expect(restart).toBeEnabled();

    fireEvent.click(resume);
    expect(callbacks.onResume).toHaveBeenCalledOnce();
    expect(callbacks.onStart).not.toHaveBeenCalled();

    fireEvent.click(restart);
    expect(callbacks.onStart).toHaveBeenCalledOnce();
  });
});
