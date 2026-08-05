import { Code2Icon, FolderOpenIcon, TerminalIcon } from "lucide-react";
import type { TaskRepository } from "@coding-agent/core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
 * - 在系统文件管理器打开：按仓库逐个调 `onRevealInFolder`；单仓库时直接调，多仓库时下拉出子菜单。
 *
 * 注意：父组件 `DetailHeader` 只在 `repositories.length > 0` 时才渲染本组件，
 * 不会出现"无仓库可打开"的空下拉。
 */
export function EditorLauncher({
  repositories,
  onLaunchVSCode,
  onLaunchQoder,
  onRevealInFolder
}: {
  repositories: TaskRepository[];
  onLaunchVSCode(): void;
  onLaunchQoder(): void;
  onRevealInFolder(path: string): void;
}) {
  const canReveal = repositories.some((repo) => Boolean(repo.worktreePath || repo.localPath));
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
        {canReveal && repositories.length === 1 && (
          <DropdownMenuItem
            onSelect={() => {
              const path = repositories[0]?.worktreePath ?? repositories[0]?.localPath;
              if (path) onRevealInFolder(path);
            }}
            className="text-xs"
          >
            <FolderOpenIcon size={11} />在系统文件管理器打开
          </DropdownMenuItem>
        )}
        {canReveal && repositories.length > 1 && (
          <>
            <DropdownMenuLabel className="text-[10px] text-muted-foreground">在系统文件管理器打开</DropdownMenuLabel>
            {repositories.map((repo) => {
              const path = repo.worktreePath ?? repo.localPath;
              if (!path) return null;
              return (
                <DropdownMenuItem
                  key={repo.id}
                  onSelect={() => onRevealInFolder(path)}
                  className="text-xs"
                >
                  <FolderOpenIcon size={11} />
                  {repo.name}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
