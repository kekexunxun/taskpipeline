import { CodeBlock } from "@/components/ai-elements/code-block";
import type { DriverPart } from "@/api";

/**
 * Qoder `qoder.tool-result` part — 通常紧跟 `qoder.tool-use` 后面。
 * 在 PartRenderer 配对成功后,这个 part 不会单独渲染(其内容已并入 tool-use 折叠块);
 * 单独出现时(罕见,如旧的乱序历史消息)用最小 fallback 渲染。
 */
export function QoderToolResultPart({ part }: { part: Extract<DriverPart, { type: "qoder.tool-result" }> }) {
  const output = typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2);
  return (
    <div className="not-prose my-1 w-full rounded border border-border/60 bg-card/30 px-3 py-2 text-xs">
      <div className="mb-1 text-muted-foreground">工具结果 · {part.toolCallId}</div>
      <CodeBlock code={output} language="json" />
    </div>
  );
}
