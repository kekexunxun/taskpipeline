import { BotIcon, UserIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ChatMessage as ChatMessageType } from "@/api";
import { cn } from "@/lib/utils";

function extractText(message: ChatMessageType): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function formatTime(value: string | number | Date | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

/**
 * 视觉规则：
 * - 用户消息：右对齐圆角气泡，纯文本（不走 markdown），保证中文/换行渲染稳定。
 * - 助手消息：左侧 avatar + 元信息，正文走 Streamdown。
 */
function ChatMessageImpl({
  message,
  isAnimating
}: {
  message: ChatMessageType;
  isAnimating?: boolean;
}) {
  const isUser = message.role === "user";
  const text = useMemo(() => extractText(message), [message]);
  const time = useMemo(
    () => formatTime(message.metadata?.createdAt),
    [message.metadata?.createdAt]
  );
  const metaStatus = message.metadata?.status;
  const isAborted = metaStatus === "aborted";
  const isError = metaStatus === "error";
  const isStreaming = Boolean(isAnimating) && !isAborted && !isError;
  const containerClass = isUser ? "justify-end" : "justify-start";
  const widthClass = isUser ? "max-w-[78%]" : "max-w-[88%]";
  const alignClass = isUser ? "items-end" : "items-start";
  return (
    <div
      className={cn("flex w-full", containerClass)}
      data-role={message.role}
    >
      <div className={cn("flex min-w-0 flex-col gap-1.5", alignClass, widthClass)}>
        <div
          className={cn(
            "flex items-center gap-1.5 text-[11px] text-muted-foreground",
            isUser ? "flex-row-reverse" : "flex-row"
          )}
        >
          {!isUser && (
            <span
              aria-hidden
              className="grid size-4 place-items-center rounded-md bg-muted text-muted-foreground"
            >
              <BotIcon size={10} />
            </span>
          )}
          <strong className="font-semibold text-foreground/80">
            {isUser ? "你" : "Agent"}
          </strong>
          {time && <time className="font-mono text-[10px]">{time}</time>}
          {isAborted && <Badge variant="muted">已停止</Badge>}
          {isError && <Badge variant="destructive">失败</Badge>}
          {isUser && (
            <span
              aria-hidden
              className="grid size-4 place-items-center rounded-md bg-primary/15 text-primary"
            >
              <UserIcon size={10} />
            </span>
          )}
        </div>
        {isUser ? (
          <div className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm border border-border/40 bg-secondary px-3.5 py-2 text-sm leading-6 text-foreground">
            {text}
          </div>
        ) : (
          <div
            className={cn(
              "min-w-0 max-w-full text-sm leading-6 text-foreground",
              isStreaming && "animate-pulse"
            )}
          >
            <MessageResponse>{text}</MessageResponse>
          </div>
        )}
      </div>
    </div>
  );
}

export const ChatMessageView = memo(ChatMessageImpl);
