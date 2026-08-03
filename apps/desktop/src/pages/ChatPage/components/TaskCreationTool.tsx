import { ClipboardPlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function TaskCreationTool({
  selected,
  disabled,
  onChange
}: {
  selected: boolean;
  disabled?: boolean;
  onChange(selected: boolean): void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="任务创建"
          aria-pressed={selected}
          disabled={disabled}
          className={cn(
            "h-6 gap-1 px-1.5 font-normal text-muted-foreground hover:text-foreground",
            selected && "bg-primary/12 text-primary hover:bg-primary/16 hover:text-primary"
          )}
          onClick={() => onChange(!selected)}
        >
          <ClipboardPlusIcon size={11} />
          <span>任务创建</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {selected ? "关闭 Jira 任务创建 Agent" : "使用 Jira 任务创建 Agent"}
      </TooltipContent>
    </Tooltip>
  );
}
