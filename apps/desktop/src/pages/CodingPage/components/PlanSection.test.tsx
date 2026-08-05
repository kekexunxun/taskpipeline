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

  it("shows a shimmer placeholder with dynamic dots before the first plan arrives", () => {
    const { container } = render(
      <PlanSection
        task={{ ...task, planContent: undefined, state: "planning" }}
        events={[]}
      />
    );

    expect(screen.getByText("正在生成计划")).toBeInTheDocument();
    expect(container.querySelector(".plan-shimmer-overlay")).toBeInTheDocument();
    expect(container.querySelectorAll(".plan-dot")).toHaveLength(3);
  });

  it("applies staggered entry animation to plan adjustment records", () => {
    const { container } = render(
      <PlanSection
        task={{ ...task, state: "planning", planRevision: 1 }}
        events={[
          { id: "fb-1", taskId: task.id, kind: "message", title: "计划调整意见", detail: "第一条", createdAt: "2026-08-04T08:30:00.000Z" },
          { id: "fb-2", taskId: task.id, kind: "message", title: "计划调整意见", detail: "第二条", createdAt: "2026-08-04T08:31:00.000Z" },
          { id: "fb-3", taskId: task.id, kind: "message", title: "计划调整意见", detail: "第三条", createdAt: "2026-08-04T08:32:00.000Z" }
        ]}
      />
    );

    const items = container.querySelectorAll("[data-plan-feedback] .animate-plan-fade-up");
    expect(items).toHaveLength(3);
    // JSDOM 会把 0ms 折叠为 ""，因此用 getAttribute 读取原始串；只要第 2、3 条都带递增 delay 即可。
    const delays = Array.from(items).map((node) => (node as HTMLElement).getAttribute("style") ?? "");
    expect(delays[0]?.includes("0ms") || delays[0] === "").toBe(true);
    expect(delays[1]).toContain("60ms");
    expect(delays[2]).toContain("120ms");
  });

  it("shows a recoverable error instead of rendering a coerced object", () => {
    render(<PlanSection task={{ ...task, planContent: "[object Object]" }} />);
    expect(screen.getByText(/计划内容格式异常/)).toBeInTheDocument();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
  });
});
