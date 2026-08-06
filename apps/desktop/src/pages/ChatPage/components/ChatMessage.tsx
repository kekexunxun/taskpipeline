import { ArrowRightIcon, BotIcon, Loader2Icon, UserIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ChatDriverId, ChatMessage } from "@/api";
import { QoderMessageView } from "../drivers/QoderMessageView";
import { OpenAIMessageView } from "../drivers/OpenAIMessageView";
import { cn } from "@/lib/utils";

/**
 * 顶层消息视图 —— 共享的元信息 (header / user bubble / task creation action) 在这里;
 * 真正按 part 渲染的内容交给 driver 专属的 `*MessageView` 组件。
 *
 * 路由规则:
 *  - `message.driverId === "qoder"` → `QoderMessageView`
 *  - `message.driverId === "openai"` → `OpenAIMessageView`
 *  - 用户消息 (`role === "user"`) → 不分 driver,统一走文本气泡(对齐右,纯文本)
 */
function ChatMessageImpl({
  message,
  isAnimating,
  onExecuteJira
}: {
  message: ChatMessage;
  isAnimating?: boolean;
  onExecuteJira?(taskKey: string): Promise<void>;
}) {
  const [executing, setExecuting] = useState(false);
  const isUser = message.role === "user";
  const time = useMemo(
    () => formatTime(message.metadata?.createdAt ?? message.createdAt),
    [message.metadata?.createdAt, message.createdAt]
  );
  const metaStatus = message.metadata?.status;
  const isAborted = metaStatus === "aborted";
  const isError = metaStatus === "error";
  const isStreaming = Boolean(isAnimating) && !isAborted && !isError;
  const taskCreation = message.metadata?.taskCreation;
  const taskKey = taskCreation?.externalKey;
  const taskBackend = taskCreation?.backend;
  const containerClass = isUser ? "justify-end" : "justify-start";
  const widthClass = isUser ? "max-w-[78%]" : "max-w-[88%]";
  const alignClass = isUser ? "items-end" : "items-start";

  return (
    <div
      className={cn("flex w-full", containerClass)}
      data-role={message.role}
      data-driver-id={message.driverId}
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
            {isUser ? "你" : driverLabel(message.driverId)}
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
          <UserBubble message={message} />
        ) : (
          <>
            <DriverMessageBody message={message} isAnimating={isStreaming} />
            {taskCreation && taskKey && (
              <div className="flex w-full flex-wrap items-center gap-2 border-l-2 border-primary/50 pl-3 text-xs">
                <span className="font-mono font-semibold text-foreground">{taskKey}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {taskCreation.issueType} · {taskCreation.summary}
                </span>
                {onExecuteJira && taskBackend === "jira" && (
                  <Button
                    size="sm"
                    className="h-6 shrink-0"
                    disabled={executing}
                    onClick={async () => {
                      setExecuting(true);
                      try { await onExecuteJira(taskKey); }
                      catch { /* 全局反馈已展示导入失败原因。 */ }
                      finally { setExecuting(false); }
                    }}
                  >
                    {executing ? <Loader2Icon className="animate-spin-slow" size={11} /> : <ArrowRightIcon size={11} />}
                    立即执行
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 用户消息气泡(纯文本,不分 driver)。从 parts 抽出所有 text 拼起来。
 */
function UserBubble({ message }: { message: ChatMessage }) {
  const text = useMemo(
    () =>
      message.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    [message.parts]
  );
  return (
    <div className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm border border-border/40 bg-secondary px-3.5 py-2 text-sm leading-6 text-foreground">
      {text}
    </div>
  );
}

/**
 * 助手消息正文 —— 按 `driverId` 路由到 driver 专属视图。
 */
function DriverMessageBody({ message, isAnimating }: { message: ChatMessage; isAnimating?: boolean }) {
  if (message.driverId === "qoder") {
    return <QoderMessageView message={message} isAnimating={isAnimating} />;
  }
  if (message.driverId === "openai") {
    return <OpenAIMessageView message={message} isAnimating={isAnimating} />;
  }
  // 未知 driver 兜底:把 parts 走 PartRenderer 的 fallback 分支
  return (
    <div className="rounded border border-dashed border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      未识别的 driver: {message.driverId}
    </div>
  );
}

function driverLabel(id: ChatDriverId): string {
  if (id === "qoder") return "Qoder Agent";
  if (id === "openai") return "OpenAI";
  return "Agent";
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

export const ChatMessageView = memo(ChatMessageImpl);
