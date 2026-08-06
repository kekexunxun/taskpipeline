import { MessageResponse } from "@/components/ai-elements/message";
import type { DriverPart } from "@/api";

/**
 * 渲染 driver 推上来的 text part(流式 markdown)。
 *
 * 设计:即使 part 的 driverId 是 "qoder" / "openai",只要 type === "text" 都可以走
 * `MessageResponse` (Streamdown) 流式 markdown。这样 Qoder 助手文本和 OpenAI 助手
 * 文本用同一份渲染器,UI 一致。
 */
export function TextPart({ part, isAnimating }: { part: Extract<DriverPart, { type: "text" }>; isAnimating?: boolean }) {
  return (
    <div className={isAnimating ? "animate-pulse" : undefined}>
      <MessageResponse>{part.text}</MessageResponse>
    </div>
  );
}
