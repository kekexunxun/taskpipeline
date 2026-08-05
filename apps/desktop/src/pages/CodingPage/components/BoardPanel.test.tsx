import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskCard } from "@coding-agent/core";
import { BoardPanel } from "./BoardPanel";

function task(id: string, state: TaskCard["state"], boardColumn: TaskCard["boardColumn"]): TaskCard {
  return {
    id,
    source: "local",
    title: `Task ${id}`,
    description: "",
    keywords: [],
    acceptanceCriteria: [],
    state,
    reviewStatus: "pending",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    boardColumn,
    repositories: []
  };
}

describe("BoardPanel", () => {
  it("offers removal for tasks in every board state", () => {
    render(
      <BoardPanel
        tasks={[
          task("todo", "draft", "todo"),
          task("running", "implementing", "in_progress"),
          task("review", "reviewing", "in_review"),
          task("done", "completed", "done")
        ]}
        search=""
        onSearch={vi.fn()}
        removingTaskIds={new Set()}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn().mockResolvedValue(true)}
        onCreate={vi.fn()}
        onFromJira={vi.fn()}
        onSyncJira={vi.fn()}
      />
    );

    expect(screen.getAllByRole("button", { name: "移除任务" })).toHaveLength(4);
  });

  it("keeps every board column at the card layout width", () => {
    const { container } = render(
      <BoardPanel
        tasks={[task("running", "implementing", "in_progress")]}
        search=""
        onSearch={vi.fn()}
        removingTaskIds={new Set()}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn().mockResolvedValue(true)}
        onCreate={vi.fn()}
        onFromJira={vi.fn()}
        onSyncJira={vi.fn()}
      />
    );

    const sections = Array.from(container.querySelectorAll("section > div + div > section"));
    expect(sections).toHaveLength(4);
    expect(sections.every((section) => section.className.includes("min-w-[320px]"))).toBe(true);
  });
});
