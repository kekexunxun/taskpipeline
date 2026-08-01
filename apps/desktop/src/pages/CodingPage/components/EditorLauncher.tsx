import { Code2Icon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

export function EditorLauncher({
  onLaunchVSCode,
  onLaunchQoder
}: {
  onLaunchVSCode(): void;
  onLaunchQoder(): void;
}) {
  return (
    <div className="absolute bottom-3 right-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" className="h-6 gap-1 px-2">
            <Code2Icon size={11} />
            使用编辑器打开
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-xs">
          <DropdownMenuItem onSelect={onLaunchVSCode} className="text-xs">
            <Code2Icon size={11} />VS Code
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onLaunchQoder} className="text-xs">
            <TerminalIcon size={11} />Qoder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
