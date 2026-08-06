import type { ChatMessage } from "@/api";
import { PartRenderer } from "./PartRenderer";

/**
 * OpenAI 专属消息视图。
 *
 * 设计:
 *  - 走 `PartRenderer` 同样的路由,但 OpenAI 主要产出 `text` (markdown) +
 *    偶发 `openai.tool-call` / `openai.tool-result` (任务创建后端场景)。
 *  - 没有 thinking / session 之类的 Qoder 专属 part,所以视觉上比 Qoder 简洁。
 */
export function OpenAIMessageView({
  message,
  isAnimating
}: {
  message: ChatMessage;
  isAnimating?: boolean;
}) {
  return <PartRenderer parts={message.parts} isStreaming={isAnimating} />;
}
