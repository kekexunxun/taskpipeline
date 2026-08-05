import { useMemo } from "react";
import { FileTextIcon, LoaderCircleIcon, MessageSquareTextIcon } from "lucide-react";
import type { Task } from "@coding-agent/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { formatTime } from "@/utils/format";
import { normalizeTimelineItems, type TimelineItem } from "./Timeline";

export function readablePlanContent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const content = value.trim();
  if (!content || content === "[object Object]") return undefined;
  return content;
}

export function PlanSection({
  task,
  compact = false,
  events = []
}: {
  task: Task;
  compact?: boolean;
  events?: TimelineItem[];
}) {
  const planFeedback = useMemo(
    () => normalizeTimelineItems(events).filter((item) => item.title.trim() === "计划调整意见"),
    [events]
  );
  const revision = task.planRevision ?? 0;
  const isRevising = task.state === "planning" && Boolean(task.planContent);
  const planContent = readablePlanContent(task.planContent);
  if (!task.planContent && !["planning", "awaiting_plan_approval"].includes(task.state)) return null;

  return <section className={cn("thin-scrollbar min-h-0 flex-1 overflow-y-auto", compact ? "px-4 py-3" : "px-6 py-5")}>
    <div className="mx-auto w-full max-w-4xl">
      <div className={cn("mb-3 flex items-center justify-between font-semibold", compact ? "text-xs" : "text-sm")}>
        <span className="flex items-center gap-1.5"><FileTextIcon size={compact ? 12 : 14} />实施计划</span>
        <span className="text-xs text-muted-foreground">{isRevising ? `正在生成第 ${revision + 1} 版` : `第 ${revision} 版`}</span>
      </div>
      {planFeedback.length > 0 && (
        <div className={cn("mb-4 border-l-2 border-border", compact ? "pl-3" : "pl-4")}>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <MessageSquareTextIcon size={12} />计划调整记录
          </div>
          <div className="space-y-2">
            {planFeedback.map((item, index) => (
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs" key={item.id}>
                <div className="min-w-0">
                  <span className="mr-2 font-medium text-foreground">第 {index + 1} 次调整</span>
                  <span className="whitespace-pre-wrap break-words text-muted-foreground">{item.detail}</span>
                </div>
                <time className="text-muted-foreground">{formatTime(item.createdAt)}</time>
              </div>
            ))}
          </div>
        </div>
      )}
      {isRevising && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="shrink-0 animate-spin-slow" size={13} />
          正在根据最近的调整意见生成新计划，当前仍展示第 {revision} 版供参考
        </div>
      )}
      {planContent ? (
        <div className={cn("rounded-md border bg-background text-xs leading-5", compact ? "p-3" : "p-5")}>
          <MessageResponse>{planContent}</MessageResponse>
        </div>
      ) : task.planContent ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 text-xs leading-5 text-amber-200">
          当前版本的计划内容格式异常，无法恢复原文。请在下方填写调整意见并重新生成计划。
        </div>
      ) : (
        <div className="rounded-md border border-dashed p-8 text-center text-xs text-muted-foreground">正在生成计划</div>
      )}
    </div>
  </section>;
}
