import { CircleDotIcon, FileTextIcon, GitBranchIcon, PencilIcon, ShieldIcon, Trash2Icon } from "lucide-react";
import type { TaskCard } from "@coding-agent/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { statusLabels } from "@/utils/status";

const stateTone = (state: string) =>
  state === "failed" || state === "validation_failed" || state === "review_blocked"
    ? "destructive"
    : ["planning", "awaiting_plan_approval", "implementing", "validating"].includes(state) || state === "reviewing"
    ? "warning"
    : state === "completed" || state === "await_merge"
    ? "success"
    : state === "cancelled"
    ? "muted"
    : "secondary";

export function TaskCardView({
  task,
  active,
  onOpen,
  onEdit,
  onRemove
}: {
  task: TaskCard;
  active: boolean;
  onOpen(): void;
  onEdit?(): void;
  onRemove?(): void;
}) {
  return (
    <article
      className={cn(
        "group relative rounded-md border bg-card p-3 transition-colors hover:border-border hover:bg-accent/40 focus-within:border-ring",
        active && "border-ring bg-accent"
      )}
    >
      <button
        className="absolute inset-0 z-0 rounded-md focus-visible:outline-none"
        aria-label={`打开任务 ${task.title}`}
        onClick={onOpen}
      />
      <div className="pointer-events-none relative z-10 mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-muted-foreground">
          {task.jiraKey ?? "LOCAL"}
        </span>
        <Badge variant={stateTone(task.state)}>
          <CircleDotIcon size={9} />
          {statusLabels[task.state]}
        </Badge>
      </div>
      <strong className="pointer-events-none relative z-10 block text-xs font-semibold leading-5 text-foreground/90">
        {task.title}
      </strong>
      {task.keywords.length > 0 && (
        <div className="pointer-events-none relative z-10 mt-1.5 flex flex-wrap gap-1">
          {task.keywords.slice(0, 3).map((item) => (
            <Badge variant="outline" key={item}>
              {item}
            </Badge>
          ))}
        </div>
      )}
      {task.planContent && <div className="pointer-events-none relative z-10 mt-1.5"><Badge variant="secondary"><FileTextIcon size={9} />计划 v{task.planRevision ?? 1}</Badge></div>}
      {task.repositories.length > 0 && (
        <div className="pointer-events-none relative z-10 mt-2 rounded border-t pt-1.5 text-xs text-muted-foreground">
          <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
            <span className="inline-flex items-center gap-1"><GitBranchIcon size={10} />仓库</span>
            <span>{task.repositories.length}</span>
          </div>
          <div className="space-y-1">
            {task.repositories.map((repo) => (
              <div className="flex min-w-0 items-center justify-between gap-2" key={repo.id}>
                <span className="min-w-0 truncate">{repo.name}</span>
                <Badge
                  variant={
                    repo.deliveryStatus === "mr_created"
                      ? "success"
                      : repo.changeSummary
                      ? "secondary"
                      : "muted"
                  }
                  className="shrink-0"
                >
                  {repo.deliveryStatus === "mr_created"
                    ? "MR 已提交"
                    : repo.changeSummary ?? "等待修改"}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="pointer-events-none relative z-10 mt-2 flex min-h-6 items-center justify-between border-t pt-1.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <ShieldIcon size={10} />
          {task.reviewStatus === "passed"
            ? "Review 通过"
            : task.reviewStatus === "blocked"
            ? "Review 阻断"
            : "待 Review"}
        </span>
        <span className="pointer-events-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          {onEdit && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="编辑任务"
              onClick={onEdit}
            >
              <PencilIcon size={11} />
            </Button>
          )}
          {onRemove && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="移除任务"
                >
                  <Trash2Icon size={11} />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>移除任务？</AlertDialogTitle>
                  <AlertDialogDescription>
                    "{task.title}"及其本地工作区信息将被删除，此操作无法撤销。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={onRemove}>移除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </span>
      </div>
    </article>
  );
}
