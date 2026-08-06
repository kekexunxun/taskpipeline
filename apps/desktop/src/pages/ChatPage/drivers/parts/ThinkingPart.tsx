import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DriverPart } from "@/api";

/**
 * 折叠式 thinking / reasoning part。
 *  - Qoder: `type === "qoder.thinking"` (text + 可选 signature)
 *  - 未来其它 driver 可以在 type 上加分支
 *
 * 设计:流式时自动展开(让用户看到推理过程),流结束后自动收起(只保留"已思考 N 秒"
 * 摘要);用户可以手动重新打开。
 */
export function ThinkingPart({
  part,
  isStreaming
}: {
  part: Extract<DriverPart, { type: "qoder.thinking" }>;
  isStreaming?: boolean;
}) {
  const [open, setOpen] = useState(isStreaming ?? false);
  // 文本无变化不强制打开
  const showOpen = isStreaming ?? open;
  return (
    <Collapsible
      open={showOpen}
      onOpenChange={setOpen}
      className={cn("not-prose my-2 w-full rounded-md border bg-muted/30 text-foreground", "border-border/60")}
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <BrainIcon size={12} className="text-muted-foreground" />
          <span className="font-medium">思考中…</span>
        </span>
        <ChevronDownIcon
          size={12}
          className={cn("transition-transform", showOpen ? "rotate-180" : "rotate-0")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border/40 px-3 py-2 text-xs leading-5 text-foreground/80">
        <pre className="whitespace-pre-wrap break-words font-sans">{part.text}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
