import { Code2Icon, FolderOpenIcon, TerminalIcon } from "lucide-react";
import type { TaskRepository } from "@coding-agent/core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

/**
 * 「在编辑器打开」下拉。
 *
 * 设计为 toolbar 友好的 icon-sm 按钮：仅显示一个文件夹图标，hover/聚焦时与
 * 同栏的 merge-back / focused / close 等按钮视觉一致。
 *
 * 包含三类操作：
 * - VS Code / Qoder：交给宿主启动（调用 `api.openTaskEditor`）。
 * - 在系统文件管理器打开：直接打开任务对应的 workspace 目录（所有仓库 worktree 的
 *   父目录），不再按仓库拆分。
 *
 * 注意：父组件 `DetailHeader` 只在 `repositories.length > 0` 时才渲染本组件，
 * 不会出现"无仓库可打开"的空下拉。
 */
export function EditorLauncher({
  repositories,
  onLaunchVSCode,
  onLaunchQoder,
  onRevealWorkspace
}: {
  repositories: TaskRepository[];
  onLaunchVSCode(): void;
  onLaunchQoder(): void;
  onRevealWorkspace(): void;
}) {
  const canReveal = repositories.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="打开文件夹">
          <FolderOpenIcon size={11} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="text-xs">
        <DropdownMenuItem onSelect={onLaunchVSCode} className="text-xs">
          <Code2Icon size={11} />VS Code
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onLaunchQoder} className="text-xs">
          <TerminalIcon size={11} />Qoder
        </DropdownMenuItem>
        {canReveal && <DropdownMenuSeparator />}
        {canReveal && (
          <DropdownMenuItem onSelect={onRevealWorkspace} className="text-xs">
            <FolderOpenIcon size={11} />在系统文件管理器打开
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
