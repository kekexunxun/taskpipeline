import { CheckCircle2Icon, Loader2Icon, WrenchIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "@/components/ui/collapsible";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { cn } from "@/lib/utils";
import type { DriverPart } from "@/api";

/**
 * OpenAI `openai.tool-call` part — 工具调用声明(input),与紧随其后的
 * `openai.tool-result` part 配对显示(PartRenderer 维护配对 map)。
 */
export function OpenAIToolCallPart({
  part,
  result
}: {
  part: Extract<DriverPart, { type: "openai.tool-call" }>;
  result?: Extract<DriverPart, { type: "openai.tool-result" }>;
}) {
  const [open, setOpen] = useState(false);
  const status = !result ? "running" : "done";
  const icon = status === "running" ? (
    <Loader2Icon size={12} className="animate-spin-slow text-muted-foreground" />
  ) : (
    <CheckCircle2Icon size={12} className="text-emerald-500" />
  );
  const inputJson = JSON.stringify(part.input, null, 2);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("not-prose my-2 w-full rounded-md border bg-card/40 border-border/60")}
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <WrenchIcon size={12} className="text-muted-foreground" />
          <span className="font-mono font-medium text-foreground/80">{part.name}</span>
        </span>
        {icon}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t border-border/40 px-3 py-2 text-xs">
        <div>
          <div className="mb-1 font-medium text-muted-foreground">输入</div>
          <CodeBlock code={inputJson} language="json" />
        </div>
        {result && (
          <div>
            <div className="mb-1 font-medium text-muted-foreground">输出</div>
            <CodeBlock
              code={typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)}
              language="json"
            />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
