import { useState } from "react";
import { CircleDotIcon, FileTextIcon, FolderXIcon, GitBranchIcon, Loader2Icon, PencilIcon, ShieldIcon, Trash2Icon } from "lucide-react";
import type { TaskCard } from "@coding-agent/core";
import type { TaskRemovalMode } from "@/api";
import {
  AlertDialog,
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
    : ["planning", "awaiting_plan_approval", "implementing", "awaiting_input", "validating"].includes(state) || state === "reviewing"
    ? "warning"
    : state === "completed" || state === "await_merge"
    ? "success"
    : state === "cancelled"
    ? "muted"
    : "secondary";

const reviewStates = new Set([
  "awaiting_review",
  "reviewing",
  "review_blocked",
  "awaiting_commit",
  "delivering",
  "await_merge"
]);

const reviewLabels: Record<TaskCard["reviewStatus"], string> = {
  pending: "待 Review",
  running: "Review 中",
  passed: "Review 通过",
  blocked: "Review 阻断",
  waived: "Review 已跳过"
};

type RepositoryDeliveryStatus = TaskCard["repositories"][number]["deliveryStatus"];

const repositoryStatusLabels: Record<RepositoryDeliveryStatus, string> = {
  pending: "等待修改",
  unchanged: "无需修改",
  changed: "已有修改",
  committed: "已提交",
  pushed: "已推送",
  mr_created: "MR 已提交",
  workspace_removed: "工作区已清理",
  failed: "交付失败"
};

const deliveredRepositoryStatuses = new Set<RepositoryDeliveryStatus>(["committed", "pushed", "mr_created", "workspace_removed", "failed"]);

const repositoryStatus = (task: TaskCard, repo: TaskCard["repositories"][number]): RepositoryDeliveryStatus => {
  if (repo.changedFileCount !== undefined) {
    if (deliveredRepositoryStatuses.has(repo.deliveryStatus)) return repo.deliveryStatus;
    if (repo.changedFileCount > 0) return "changed";
    if (task.state === "completed" && (repo.deliveryStatus === "unchanged" || task.summary?.includes("无需修改"))) return "unchanged";
    return "pending";
  }
  return repo.deliveryStatus === "pending" && task.state === "completed" && task.summary?.includes("无需修改")
    ? "unchanged"
    : repo.deliveryStatus;
};

const repositoryStatusLabel = (status: RepositoryDeliveryStatus, repo: TaskCard["repositories"][number]) =>
  status === "changed"
    ? repo.changedFileCount
      ? `${repo.changedFileCount} 个文件`
      : repo.changeSummary ?? repositoryStatusLabels.changed
    : repositoryStatusLabels[status];

const repositoryStatusTone = (status: RepositoryDeliveryStatus) =>
  status === "failed"
    ? "destructive"
    : status === "unchanged" || status === "pushed" || status === "mr_created"
    ? "success"
    : status === "pending" || status === "workspace_removed"
    ? "muted"
    : "secondary";

export function TaskCardView({
  task,
  active,
  removing,
  onOpen,
  onEdit,
  onRemove
}: {
  task: TaskCard;
  active: boolean;
  removing: boolean;
  onOpen(): void;
  onEdit?(): void;
  onRemove?(mode: TaskRemovalMode): Promise<boolean>;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<TaskRemovalMode>();
  const isRemoving = removing || Boolean(pendingMode);
  const showReviewStatus = task.reviewStatus !== "pending" || reviewStates.has(task.state);

  const confirmRemove = async (mode: TaskRemovalMode) => {
    if (!onRemove || isRemoving) return;
    setPendingMode(mode);
    try {
      if (await onRemove(mode)) setRemoveOpen(false);
    } finally {
      setPendingMode(undefined);
    }
  };

  const pendingLabel = pendingMode === "workspace" ? "清理中" : "删除中";

  return (
    <article
      className={cn(
        "group relative w-full rounded-md border bg-card p-3 transition-colors hover:border-border hover:bg-accent/40 focus-within:border-ring",
        active && "border-ring bg-accent",
        isRemoving && "opacity-70"
      )}
      aria-busy={isRemoving}
    >
      <button
        className="absolute inset-0 z-0 rounded-md focus-visible:outline-none"
        aria-label={`打开任务 ${task.title}`}
        disabled={isRemoving}
        onClick={onOpen}
      />
      <div className="pointer-events-none relative z-10 mb-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-semibold text-muted-foreground" title={task.taskKey ?? "LOCAL"}>
          {task.taskKey ?? "LOCAL"}
        </span>
        <Badge className="shrink-0 whitespace-nowrap" variant={isRemoving ? "muted" : stateTone(task.state)}>
          {isRemoving ? <Loader2Icon className="animate-spin-slow" size={9} /> : <CircleDotIcon size={9} />}
          {isRemoving ? pendingLabel : statusLabels[task.state]}
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
            {task.repositories.map((repo) => {
              const status = repositoryStatus(task, repo);
              return (
                <div className="flex min-w-0 items-center justify-between gap-2" key={repo.id}>
                  <span className="min-w-0 truncate">{repo.name}</span>
                  <Badge variant={repositoryStatusTone(status)} className="shrink-0">
                    {repositoryStatusLabel(status, repo)}
                  </Badge>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {(showReviewStatus || onEdit || onRemove) && (
        <footer className="pointer-events-none relative z-10 mt-2 flex min-h-6 items-center justify-between border-t pt-1.5 text-xs text-muted-foreground">
          {showReviewStatus && (
            <span className="inline-flex items-center gap-1">
              <ShieldIcon size={10} />
              {reviewLabels[task.reviewStatus]}
            </span>
          )}
          {(onEdit || onRemove) && (
            <span className="pointer-events-auto ml-auto flex shrink-0 items-center gap-0.5">
              {onEdit && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="编辑任务"
                  disabled={isRemoving}
                  onClick={onEdit}
                >
                  <PencilIcon size={11} />
                </Button>
              )}
              {onRemove && (
                <AlertDialog open={removeOpen} onOpenChange={(open) => { if (!isRemoving) setRemoveOpen(open); }}>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="移除任务"
                      disabled={isRemoving}
                    >
                      <Trash2Icon size={11} />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>删除或清理任务？</AlertDialogTitle>
                      <AlertDialogDescription>
                        两种操作都会先停止“{task.title}”正在执行的任务。仅清理 Worktree 会释放本地空间并保留任务、计划和执行记录；全部删除会同时永久删除所有任务数据。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={isRemoving}>取消</AlertDialogCancel>
                      <Button variant="outline" size="sm" disabled={isRemoving} onClick={() => void confirmRemove("workspace")}>
                        {pendingMode === "workspace" ? <Loader2Icon className="animate-spin-slow" size={11} /> : <FolderXIcon size={11} />}
                        {pendingMode === "workspace" ? "清理中" : "仅清理 Worktree"}
                      </Button>
                      <Button variant="destructive" size="sm" disabled={isRemoving} onClick={() => void confirmRemove("all")}>
                        {pendingMode === "all" ? <Loader2Icon className="animate-spin-slow" size={11} /> : <Trash2Icon size={11} />}
                        {pendingMode === "all" ? "删除中" : "全部删除"}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </span>
          )}
        </footer>
      )}
    </article>
  );
}
