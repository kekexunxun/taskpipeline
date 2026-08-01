import { PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

export function BoardToolbar({
  search,
  onSearch,
  onNew,
  onFromJira,
  onSyncJira
}: {
  search: string;
  onSearch(value: string): void;
  onNew(): void;
  onFromJira(): void;
  onSyncJira(): void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="relative w-56">
        <SearchIcon
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          size={11}
        />
        <Input
          className="h-7 pl-7 text-xs placeholder:text-xs"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="搜索任务"
        />
      </label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" aria-label="新建任务" className="h-7 w-7">
            <PlusIcon size={13} strokeWidth={2} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-xs">
          <DropdownMenuItem onSelect={onNew} className="text-xs">
            <PlusIcon size={11} />全新创建
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onFromJira} className="text-xs">
            从 Jira Key 创建
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onSyncJira} className="text-xs">
            <RefreshCwIcon size={11} />同步我的 Jira
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
