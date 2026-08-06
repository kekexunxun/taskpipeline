import { CodeBlock } from "@/components/ai-elements/code-block";
import { XCircleIcon } from "lucide-react";
import type { DriverPart } from "@/api";

/**
 * OpenAI `openai.tool-result` part — 通常与 `openai.tool-call` 配对显示。
 * 单独出现时(罕见,历史乱序)用最小 fallback 渲染。
 */
export function OpenAIToolResultPart({ part }: { part: Extract<DriverPart, { type: "openai.tool-result" }> }) {
  const output = typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2);
  return (
    <div className="not-prose my-1 w-full rounded border border-border/60 bg-card/30 px-3 py-2 text-xs">
      <div className="mb-1 inline-flex items-center gap-1 text-muted-foreground">
        <XCircleIcon size={10} className="rotate-45 text-muted-foreground" />
        工具结果 · {part.toolCallId}
      </div>
      <CodeBlock code={output} language="json" />
    </div>
  );
}
