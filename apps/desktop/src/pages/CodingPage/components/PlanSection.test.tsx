import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@coding-agent/core";
import { PlanSection } from "./PlanSection";

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => <div>{children}</div>
}));

const task: Task = {
  id: "task-1",
  source: "local",
  title: "Long plan",
  description: "test",
  keywords: [],
  acceptanceCriteria: [],
  state: "awaiting_plan_approval",
  planContent: "# Implementation\n\nA long implementation plan",
  planRevision: 2,
  reviewStatus: "pending",
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z"
};

describe("PlanSection", () => {
  it("shows the complete plan in the side panel without an artificial height limit", () => {
    const { container } = render(
      <PlanSection task={task} compact />
    );

    expect(container).toHaveTextContent("A long implementation plan");
    expect(container.querySelector("[class*='max-h-']")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("填写计划调整意见")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看并确认计划" })).not.toBeInTheDocument();
  });

  it("uses the available detail height as a scroll region", () => {
    const { container } = render(<PlanSection task={task} />);
    expect(container.querySelector("section.overflow-y-auto")).toBeInTheDocument();
  });

  it("keeps revision feedback beside the previous plan while generating the next version", () => {
    render(
      <PlanSection
        task={{ ...task, state: "planning", planRevision: 1 }}
        events={[
          {
            id: "feedback-1",
            taskId: task.id,
            kind: "message",
            title: "计划调整意见",
            detail: "补充移动端回归测试",
            createdAt: "2026-08-04T08:30:00.000Z"
          }
        ]}
      />
    );

    expect(screen.getByText("计划调整记录")).toBeInTheDocument();
    expect(screen.getByText("补充移动端回归测试")).toBeInTheDocument();
    expect(screen.getByText("正在生成第 2 版")).toBeInTheDocument();
    expect(screen.getByText(/当前仍展示第 1 版供参考/)).toBeInTheDocument();
  });

  it("shows a recoverable error instead of rendering a coerced object", () => {
    render(<PlanSection task={{ ...task, planContent: "[object Object]" }} />);
    expect(screen.getByText(/计划内容格式异常/)).toBeInTheDocument();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
  });
});
