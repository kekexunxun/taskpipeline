import { XIcon } from "lucide-react";
import type { Task } from "@coding-agent/core";
import { EditorLauncher } from "./EditorLauncher";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function DetailHeader({
  task,
  onClose,
  onOpenVSCode,
  onOpenQoder
}: {
  task: Task;
  onClose(): void;
  onOpenVSCode(): void;
  onOpenQoder(): void;
}) {
  return (
    <div className="relative shrink-0 border-b pb-9 pl-3.5 pr-9 pt-2.5">
      <div className="min-w-0">
        <span className="font-mono text-[10px] font-semibold text-muted-foreground">
          {task.jiraKey ?? "LOCAL"}
        </span>
        <h2 className="my-0.5 text-[12px] font-semibold leading-5">{task.title}</h2>
        <p className="line-clamp-2 text-xs leading-4 text-muted-foreground">
          {task.summary ?? task.description}
        </p>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭详情"
            className="absolute right-1 top-1"
            onClick={onClose}
          >
            <XIcon size={11} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>关闭详情</TooltipContent>
      </Tooltip>
      <EditorLauncher onLaunchVSCode={onOpenVSCode} onLaunchQoder={onOpenQoder} />
    </div>
  );
}
