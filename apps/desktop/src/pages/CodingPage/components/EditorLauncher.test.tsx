import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskRepository } from "@coding-agent/core";
import { EditorLauncher } from "./EditorLauncher";

function repo(partial: Partial<TaskRepository>): TaskRepository {
  return {
    id: partial.id ?? "r1",
    taskId: partial.taskId ?? "task-1",
    repositoryId: partial.repositoryId ?? "profile-1",
    name: partial.name ?? "payment-service",
    localPath: partial.localPath ?? "/tmp/payment",
    baseBranch: partial.baseBranch ?? "main",
    worktreePath: partial.worktreePath,
    featureBranch: partial.featureBranch,
    changeSummary: partial.changeSummary,
    deliveryStatus: partial.deliveryStatus ?? "pending",
    mergeRequestUrl: partial.mergeRequestUrl
  };
}

/**
 * Radix UI 的 DropdownMenu 用 pointerDown 打开；用 `userEvent` 需要额外 setup，
 * 改用 fireEvent.pointerDown 兼容 happy-dom/jsdom。
 */
async function openMenu(name: string) {
  const trigger = screen.getByRole("button", { name });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeTruthy();
  });
}

describe("EditorLauncher", () => {
  it("renders VS Code / Qoder options in a single dropdown", async () => {
    const onVSCode = vi.fn();
    const onQoder = vi.fn();
    const onReveal = vi.fn();
    render(<EditorLauncher repositories={[repo({ name: "payment-service", worktreePath: "/tmp/payment-worktree" })]} onLaunchVSCode={onVSCode} onLaunchQoder={onQoder} onRevealWorkspace={onReveal} />);
    await openMenu("打开文件夹");
    fireEvent.click(screen.getByText("VS Code"));
    expect(onVSCode).toHaveBeenCalledTimes(1);
  });

  it("reveals the task workspace via a single menu item", async () => {
    const onReveal = vi.fn();
    render(<EditorLauncher repositories={[repo({ worktreePath: "/tmp/payment-worktree" })]} onLaunchVSCode={vi.fn()} onLaunchQoder={vi.fn()} onRevealWorkspace={onReveal} />);
    await openMenu("打开文件夹");
    fireEvent.click(screen.getByText("在系统文件管理器打开"));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("keeps a single reveal item even with multiple repositories", async () => {
    const onReveal = vi.fn();
    render(
      <EditorLauncher
        repositories={[
          repo({ id: "r1", name: "payment", worktreePath: "/tmp/payment-worktree" }),
          repo({ id: "r2", name: "order", worktreePath: "/tmp/order-worktree" })
        ]}
        onLaunchVSCode={vi.fn()}
        onLaunchQoder={vi.fn()}
        onRevealWorkspace={onReveal}
      />
    );
    await openMenu("打开文件夹");
    // 不再按仓库拆分子菜单，只有一条「在系统文件管理器打开」。
    expect(screen.queryByText("payment")).toBeNull();
    expect(screen.queryByText("order")).toBeNull();
    fireEvent.click(screen.getByText("在系统文件管理器打开"));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("renders only an icon button (no text) so it fits the toolbar", () => {
    render(<EditorLauncher repositories={[repo({ worktreePath: "/tmp/payment-worktree" })]} onLaunchVSCode={vi.fn()} onLaunchQoder={vi.fn()} onRevealWorkspace={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "打开文件夹" });
    expect(trigger.querySelector("svg")).not.toBeNull();
    // 触发器应该只有图标，没有 "打开文件夹" 文字。
    expect(trigger.textContent?.trim()).toBe("");
  });
});
