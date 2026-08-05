import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Timeline, compactTimelineItems, normalizeTimelineItems, type TimelineItem } from "./Timeline";

function item(id: string, kind: TimelineItem["kind"], title: string, detail?: string): TimelineItem {
  return { id, taskId: "task-1", kind, title, detail, createdAt: `2026-08-01T00:00:0${id}.000Z` };
}

describe("compactTimelineItems", () => {
  it("hides protocol statuses and collapses cumulative Qoder output", () => {
    const result = compactTimelineItems([
      item("1", "status", "Qoder init", "raw payload"),
      item("2", "message", "Qoder Agent", "正在检查"),
      item("3", "message", "Qoder Agent", "正在检查代码"),
      item("4", "status", "状态更新为 validating")
    ]);

    expect(result.hiddenCount).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.detail).toBe("正在检查代码");
    expect(result.items[1]?.title).toBe("状态更新为 validating");
  });

  it("merges separate OpenAI responses but keeps user turns as boundaries", () => {
    const result = compactTimelineItems([
      item("1", "message", "AI", "先分析代码"),
      item("2", "message", "AI", "再完成修改"),
      item("3", "message", "你", "请补测试"),
      item("4", "message", "OpenAI Agent", "测试已补充")
    ]);

    expect(result.hiddenCount).toBe(1);
    expect(result.items.map((event) => event.detail)).toEqual([
      "先分析代码\n\n再完成修改",
      "请补测试",
      "测试已补充"
    ]);
  });

  it("preserves business statuses and errors", () => {
    const events = [
      item("1", "status", "状态更新为 implementing"),
      item("2", "error", "Qoder 执行失败", "timeout")
    ];

    expect(compactTimelineItems(events)).toEqual({ items: events, hiddenCount: 0 });
  });

  it("does not repeat an agent response in the following status detail", () => {
    const result = compactTimelineItems([
      item("1", "message", "Qoder Agent", "请补充验收标准"),
      item("2", "status", "等待补充任务信息", "请补充验收标准")
    ]);

    expect(result.items[1]?.detail).toBeUndefined();
  });
});

describe("normalizeTimelineItems", () => {
  it("sorts live events with persisted events and removes optimistic duplicates", () => {
    const persisted = { ...item("1", "message", "你", "直接完成"), createdAt: "2026-08-01T00:00:05.100Z" };
    const localCopy = { ...item("2", "message", "你", "直接完成"), createdAt: "2026-08-01T00:00:05.000Z" };
    const reply = { ...item("3", "message", "Qoder Agent", "已处理"), createdAt: "2026-08-01T00:00:07.000Z" };

    expect(normalizeTimelineItems([reply, persisted, localCopy]).map((event) => event.detail)).toEqual(["直接完成", "已处理"]);
  });

  it("removes internal outcome markers from displayed content", () => {
    expect(normalizeTimelineItems([
      item("1", "message", "Qoder Agent", "请补充信息\n<!-- coding-agent-outcome:needs_input -->")
    ])[0]?.detail).toBe("请补充信息");
  });
});

describe("Timeline", () => {
  it("defaults to the compact view and can reveal every stored event", () => {
    render(<Timeline items={[
      item("1", "status", "Qoder init", "raw payload"),
      item("2", "message", "Qoder Agent", "结果")
    ]} />);

    expect(screen.queryByText("raw payload")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示全部（2）" }));
    expect(screen.getByText("raw payload")).toBeInTheDocument();
  });

  it("explains when every stored event is an internal protocol record", () => {
    render(<Timeline items={[
      item("1", "status", "Qoder init", "raw init"),
      item("2", "status", "Qoder hook", "raw hook")
    ]} />);

    expect(screen.getByText("暂无执行摘要")).toBeInTheDocument();
    expect(screen.getByText(/已折叠 2 条内部运行记录/)).toBeInTheDocument();
    expect(screen.queryByText("raw init")).not.toBeInTheDocument();
  });
});
