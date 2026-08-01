import { Code2Icon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function TopBar({ onOpenSettings }: { onOpenSettings(): void }) {
  return (
    <header className="window-drag flex items-center justify-between border-b bg-card/80 px-3 pl-[60px]">
      <div className="flex items-center gap-2 text-xs">
        <span className="grid size-6 place-items-center rounded-md border border-border bg-muted text-foreground">
          <Code2Icon size={13} />
        </span>
        <strong className="font-semibold">Forge Agent</strong>
      </div>
      <div className="window-no-drag">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="设置" onClick={onOpenSettings}>
              <SettingsIcon size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>设置</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
