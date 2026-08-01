import { NavLink } from "react-router-dom";
import { MessageSquareTextIcon, Code2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 极左侧的功能切换栏（类 VSCode Activity Bar）。
 * - 按钮较大，激活态使用左侧 2px 强调条 + 高亮背景双重指示。
 */
export function ActionBar() {
  return (
    <nav className="flex w-12 shrink-0 flex-col items-stretch gap-1 border-r bg-card/60 py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <NavLink
            to="/chat"
            aria-label="对话"
            className={({ isActive }) =>
              cn(
                "group relative flex h-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                isActive && "bg-accent text-foreground"
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    "absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-foreground/80 transition-opacity",
                    isActive ? "opacity-100" : "opacity-0"
                  )}
                />
                <MessageSquareTextIcon size={20} strokeWidth={1.75} />
              </>
            )}
          </NavLink>
        </TooltipTrigger>
        <TooltipContent side="right">对话</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <NavLink
            to="/coding"
            aria-label="编码"
            className={({ isActive }) =>
              cn(
                "group relative flex h-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                isActive && "bg-accent text-foreground"
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    "absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-foreground/80 transition-opacity",
                    isActive ? "opacity-100" : "opacity-0"
                  )}
                />
                <Code2Icon size={20} strokeWidth={1.75} />
              </>
            )}
          </NavLink>
        </TooltipTrigger>
        <TooltipContent side="right">编码</TooltipContent>
      </Tooltip>
    </nav>
  );
}
