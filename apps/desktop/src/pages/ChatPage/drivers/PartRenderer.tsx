import { Fragment, useMemo } from "react";
import type { DriverPart } from "@/api";
import { TextPart } from "./parts/TextPart";
import { ThinkingPart } from "./parts/ThinkingPart";
import { QoderToolUsePart } from "./parts/QoderToolUsePart";
import { QoderToolResultPart } from "./parts/QoderToolResultPart";
import { QoderSessionPart } from "./parts/QoderSessionPart";
import { OpenAIToolCallPart } from "./parts/OpenAIToolCallPart";
import { OpenAIToolResultPart } from "./parts/OpenAIToolResultPart";

/**
 * 按 `DriverPart.type` 路由到具体 part 渲染器。
 *
 * 设计要点:
 *  - `qoder.tool-use` / `openai.tool-call` 与紧随其后的 tool-result 配对:同一个
 *    `toolCallId` 合并显示在 tool-use 折叠块里;单独出现时 fallback 渲染对应 result part。
 *  - 不识别的 part 类型(例如来自旧 driverId)用最小 fallback 渲染 `JSON.stringify`,避免
 *    整条消息崩溃。
 *  - `text` part 由 `TextPart` 渲染(`MessageResponse` 流式 markdown),共用同一份组件,
 *    不区分 driver。
 */
export function PartRenderer({
  parts,
  isStreaming
}: {
  parts: DriverPart[];
  isStreaming?: boolean;
}) {
  const resultByCallId = useMemo(() => {
    const map = new Map<string, DriverPart>();
    for (const part of parts) {
      if (part.type === "qoder.tool-result") map.set(part.toolCallId, part);
      if (part.type === "openai.tool-result") map.set(part.toolCallId, part);
    }
    return map;
  }, [parts]);

  return (
    <>
      {parts.map((part, index) => {
        const key = `${part.type}-${index}`;
        if (part.type === "text") {
          return <TextPart key={key} part={part} isAnimating={isStreaming} />;
        }
        if (part.type === "qoder.thinking") {
          return <ThinkingPart key={key} part={part} isStreaming={isStreaming} />;
        }
        if (part.type === "qoder.tool-use") {
          const result = resultByCallId.get(part.toolCallId);
          if (result && result.type === "qoder.tool-result") {
            return (
              <Fragment key={key}>
                <QoderToolUsePart part={part} result={result} />
                {/* placeholder; 不会显示; 标记 result 已配对成功 */}
                <span hidden data-paired-tool-call-id={part.toolCallId} />
              </Fragment>
            );
          }
          return <QoderToolUsePart key={key} part={part} />;
        }
        if (part.type === "qoder.tool-result") {
          // 仅当找不到对应 tool-use 时显示 fallback
          if (parts.some((p) => p.type === "qoder.tool-use" && p.toolCallId === part.toolCallId)) {
            return null;
          }
          return <QoderToolResultPart key={key} part={part} />;
        }
        if (part.type === "qoder.session") {
          return <QoderSessionPart key={key} part={part} />;
        }
        if (part.type === "openai.tool-call") {
          const result = resultByCallId.get(part.toolCallId);
          if (result && result.type === "openai.tool-result") {
            return <OpenAIToolCallPart key={key} part={part} result={result} />;
          }
          return <OpenAIToolCallPart key={key} part={part} />;
        }
        if (part.type === "openai.tool-result") {
          if (parts.some((p) => p.type === "openai.tool-call" && p.toolCallId === part.toolCallId)) {
            return null;
          }
          return <OpenAIToolResultPart key={key} part={part} />;
        }
        return (
          <div key={key} className="rounded border border-dashed border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
            未识别的 part: {JSON.stringify(part)}
          </div>
        );
      })}
    </>
  );
}
