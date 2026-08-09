import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskRepository } from "@task-pipeline/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DetailHeader } from "./DetailHeader";

vi.mock("@/api", () => ({
  api: { openExternal: vi.fn().mockResolvedValue(undefined) }
}));

vi.mock("./EditorLauncher", () => ({
  EditorLauncher: () => <button type="button" aria-label="打开文件夹">📁</button>
}));

const baseTask: Task = {
  id: "task-1",
  source: "local",
  title: "为 CodingPage 增加 hover 提示",
  description: "短描述",
  keywords: ["ui", "tooltip"],
  acceptanceCriteria: ["悬停 200ms 显示提示", "键盘可达", "可见性通过 a11y 检查"],
  state: "draft",
  reviewStatus: "pending",
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z"
};

const noop = () => undefined;

const renderHeader = (task: Task, repositories: TaskRepository[] = []) => render(
  <TooltipProvider delayDuration={0}>
    <DetailHeader
      task={task}
      repositories={repositories}
      focused={false}
      onFocusedChange={noop}
      onClose={noop}
      onOpenVSCode={noop}
      onOpenQoder={noop}
      onRevealWorkspace={noop}
      onMergeBackToBase={noop}
    />
  </TooltipProvider>
);

describe("DetailHeader", () => {
  it("shows the full task description inside a clamped dark-inset container when not expanded", () => {
    const long = "需求背景：".concat("细节 ".repeat(80));
    const { container } = renderHeader({ ...baseTask, description: long });
    const block = container.querySelector("[data-description-block]") as HTMLElement | null;
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("需求背景：");
    expect(block?.className).toContain("max-h-[5.5rem]");
    expect(block?.className).toContain("overflow-hidden");
    expect(block?.className).toContain("mask-fade-bottom-soft");
    // 折叠按钮是纯图标的角落按钮，文字已隐藏。
    const toggle = screen.getByRole("button", { name: /展开完整描述/ });
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(toggle.textContent?.trim()).toBe("");
  });

  it("expands a long description with its own scroll area and rotates the chevron", async () => {
    const long = "完整描述 ".repeat(60);
    const user = userEvent.setup();
    const { container } = renderHeader({ ...baseTask, description: long });
    const button = screen.getByRole("button", { name: /展开完整描述/ });
    await user.click(button);
    const block = container.querySelector("[data-description-block]") as HTMLElement | null;
    expect(block?.className).not.toContain("overflow-hidden");
    expect(block?.className).not.toContain("mask-fade-bottom-soft");
    expect(block?.className).toContain("max-h-72");
    expect(block?.className).toContain("overflow-y-auto");
    const chevron = button.querySelector("svg") as SVGElement | null;
    expect(chevron?.className.baseVal).toContain("rotate-180");
    expect(screen.getByRole("button", { name: /收起描述/ })).toBeInTheDocument();
  });

  it("renders every acceptance criterion as a checklist item", () => {
    const { container } = renderHeader({
      ...baseTask,
      acceptanceCriteria: ["标准 1", "标准 2", "标准 3", "标准 4", "标准 5"]
    });
    const items = container.querySelectorAll("ul li");
    expect(items).toHaveLength(5);
    expect(screen.getByText("标准 3")).toBeInTheDocument();
  });

  it("collapses acceptance criteria when the list exceeds the threshold with an icon-only toggle", async () => {
    const user = userEvent.setup();
    const { container } = renderHeader({
      ...baseTask,
      acceptanceCriteria: ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]
    });
    const collapsedList = container.querySelector("[data-criteria-list]") as HTMLElement | null;
    expect(collapsedList?.className).toContain("overflow-hidden");
    expect(collapsedList?.className).toContain("mask-fade-bottom-soft");
    expect(container.querySelectorAll("[data-criteria-list] li")).toHaveLength(5);
    expect(screen.queryByText("c6")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /展开剩余/ });
    expect(toggle.textContent?.trim()).toBe("");
    expect(toggle.querySelector("svg")).not.toBeNull();
    await user.click(toggle);
    const expandedList = container.querySelector("[data-criteria-list]") as HTMLElement | null;
    expect(expandedList?.className).toContain("overflow-y-auto");
    expect(expandedList?.className).not.toContain("mask-fade-bottom-soft");
    expect(container.querySelectorAll("[data-criteria-list] li")).toHaveLength(7);
    expect(screen.getByText("c6")).toBeInTheDocument();
  });

  it("renders the criteria count beside the header label", () => {
    renderHeader({ ...baseTask, acceptanceCriteria: ["a", "b", "c"] });
    expect(screen.getByText(/验收标准/)).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders keyword chips and the commit message when present", () => {
    renderHeader({ ...baseTask, keywords: ["ui", "tooltip", "a11y"], commitMessage: "feat: 添加提示" });
    expect(screen.getByText("ui")).toBeInTheDocument();
    expect(screen.getByText("tooltip")).toBeInTheDocument();
    expect(screen.getByText(/最近 commit/)).toBeInTheDocument();
    expect(screen.getByText("feat: 添加提示")).toBeInTheDocument();
  });

  it("shows the local source badge by default", () => {
    renderHeader(baseTask);
    expect(screen.getByText(/本地 · LOCAL/)).toBeInTheDocument();
  });

  it("renders the title in the new larger style", () => {
    renderHeader({ ...baseTask, title: "测试任务标题" });
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("测试任务标题");
    expect(heading?.className).toContain("text-[14px]");
    expect(heading?.className).toContain("tracking-tight");
  });

  it("groups the action buttons inside a top toolbar (not absolute floating)", () => {
    const { container } = renderHeader(baseTask);
    const closeButton = screen.getByRole("button", { name: "关闭详情" });
    // 顶部工具条内的按钮：没有 absolute 定位（被替换成 flex 行内布局）。
    expect(closeButton.className).not.toContain("absolute");
  });

  it("renders the open-folder dropdown inside the top toolbar when repositories exist", () => {
    const repo = { id: "r1", taskId: "task-1", repositoryId: "profile-1", name: "payment", localPath: "/tmp/p", baseBranch: "main", deliveryStatus: "pending" as const };
    renderHeader(baseTask, [repo]);
    const folderButton = screen.getByRole("button", { name: "打开文件夹" });
    const mergeButton = screen.getByRole("button", { name: "合并到 base 分支" });
    // 两者都应当存在并且位于同一个工具条容器内（同一个 <div> 直接子节点）。
    expect(folderButton).toBeInTheDocument();
    expect(mergeButton).toBeInTheDocument();
    expect(folderButton.parentElement).toBe(mergeButton.parentElement);
  });

  it("does not render the open-folder dropdown when there are no repositories", () => {
    renderHeader(baseTask, []);
    expect(screen.queryByRole("button", { name: "打开文件夹" })).not.toBeInTheDocument();
  });

  it("does not show the created/updated metadata grid (removed per UX feedback)", () => {
    renderHeader({ ...baseTask, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z" });
    expect(screen.queryByText("创建")).not.toBeInTheDocument();
    expect(screen.queryByText("更新")).not.toBeInTheDocument();
  });

  it("exposes a Jira shortcut that opens the source url", async () => {
    const user = userEvent.setup();
    const apiModule = await import("@/api");
    const jiraTask: Task = {
      ...baseTask,
      source: "jira",
      taskKey: "BSADAPT-100",
      sourceUrl: "https://jira.example.com/browse/BSADAPT-100"
    };
    renderHeader(jiraTask);
    // Jira 快捷入口是 span + onClick（TooltipTrigger asChild 包裹），无 button role。
    const badge = screen.getByText("Jira · BSADAPT-100");
    await user.click(badge);
    expect(apiModule.api.openExternal).toHaveBeenCalledWith(jiraTask.sourceUrl);
  });

  it("falls back to the task summary when description is empty", () => {
    renderHeader({ ...baseTask, description: "", summary: "无需修改" });
    expect(screen.getByText("无需修改")).toBeInTheDocument();
  });

  it("hides the description block entirely when both description and summary are empty", () => {
    const { container } = renderHeader({ ...baseTask, description: "", summary: undefined });
    expect(container.querySelector("p")).toBeNull();
  });

  it("triggers onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <TooltipProvider delayDuration={0}>
        <DetailHeader
          task={baseTask}
          repositories={[]}
          focused={false}
          onFocusedChange={noop}
          onClose={onClose}
          onOpenVSCode={noop}
          onOpenQoder={noop}
          onRevealWorkspace={noop}
          onMergeBackToBase={noop}
        />
      </TooltipProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
