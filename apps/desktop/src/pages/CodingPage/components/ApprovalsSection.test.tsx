import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Approval } from "@coding-agent/core";
import { ApprovalsSection } from "./ApprovalsSection";

const approvals: Approval[] = [
  { id: "a1", taskId: "t1", kind: "plan", status: "approved", context: "计划内容", createdAt: "2026-08-04T00:00:00.000Z", resolvedAt: "2026-08-04T00:01:00.000Z" },
  { id: "a2", taskId: "t1", kind: "commit", status: "approved", context: "repo-a: commit\nfeat: x", createdAt: "2026-08-04T00:02:00.000Z", resolvedAt: "2026-08-04T00:02:05.000Z" },
  { id: "a3", taskId: "t1", kind: "push", status: "rejected", context: "repo-a: push feature/1", createdAt: "2026-08-04T00:03:00.000Z", resolvedAt: "2026-08-04T00:03:01.000Z" }
];

describe("ApprovalsSection（Phase 1 审批记录）", () => {
  it("renders nothing without approvals", () => {
    const { container } = render(<ApprovalsSection approvals={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists approval kinds with status badges", () => {
    render(<ApprovalsSection approvals={approvals} />);
    expect(screen.getByText("审批记录")).toBeInTheDocument();
    expect(screen.getByText("计划")).toBeInTheDocument();
    expect(screen.getByText("提交代码")).toBeInTheDocument();
    expect(screen.getByText("推送分支")).toBeInTheDocument();
    expect(screen.getAllByText("已批准")).toHaveLength(2);
    expect(screen.getByText("已拒绝")).toBeInTheDocument();
  });

  it("shows approval context as hint text", () => {
    render(<ApprovalsSection approvals={approvals} />);
    expect(screen.getByTitle(/repo-a: commit/)).toBeInTheDocument();
    expect(screen.getByTitle(/repo-a: push feature\/1/)).toBeInTheDocument();
  });
});
