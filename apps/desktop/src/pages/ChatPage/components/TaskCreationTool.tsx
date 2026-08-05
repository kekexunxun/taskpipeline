import { ClipboardPlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * 「任务创建 Agent」开关。
 *
 * 文案/aria 全部使用通用术语，避免在 UI 上把产品钉死到 Jira。
 * 当前后端显示名通过 `backendLabel` 传入（默认空字符串时退回到"任务创建"），后端切换后
 * Tooltip 文案会跟着变，演示多 backend 选择时不会让用户以为产品只能做一件事。
 */
export function TaskCreationTool({
  selected,
  disabled,
  onChange,
  backendLabel
}: {
  selected: boolean;
  disabled?: boolean;
  onChange(selected: boolean): void;
  backendLabel?: string;
}) {
  const backend = backendLabel?.trim() || "任务创建";
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
        {selected ? `关闭 ${backend} Agent` : `使用 ${backend} Agent`}
      </TooltipContent>
    </Tooltip>
  );
}
