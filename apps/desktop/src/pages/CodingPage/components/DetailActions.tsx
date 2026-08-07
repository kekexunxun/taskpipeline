import { CheckIcon, Loader2Icon, MessageCircleIcon, PauseIcon, PlayIcon, RefreshCcwIcon, SendIcon, SquareIcon } from "lucide-react";
import type { TaskCard } from "@coding-agent/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export function DetailActions({
  card,
  running,
  starting,
  canSubmit,
  merging,
  onStart,
  onAbort,
  onPause,
  onResumePaused,
  onReview,
  onResetReview,
  onResetDelivery,
  onRetryValidation,
  onSubmitMR,
  onManualComplete,
  onReimplement,
  onResume
}: {
  card: TaskCard;
  running: boolean;
  starting: boolean;
  canSubmit: boolean;
  merging: boolean;
  onStart(): void;
  onAbort(): void;
  onPause(): void;
  onResumePaused(): void;
  onReview(): void;
  onResetReview(): void;
  onResetDelivery(): void;
  onRetryValidation(): void;
  onSubmitMR(): void;
  onManualComplete(): void;
  onReimplement(): void;
  onResume(): void;
}) {
  const state = card.state;
  const isDraft = state === "draft";
  const isAwaitingReview = state === "awaiting_review";
  const isReviewing = state === "reviewing";
  const isReviewBlocked = state === "review_blocked";
  const isAwaitingCommit = state === "awaiting_commit";
  const isDelivering = state === "delivering";
  const isAwaitMerge = state === "await_merge";
  const isCompleted = state === "completed";
  const isCancelled = state === "cancelled";
  const isFailed = state === "failed";
  const isValidationFailed = state === "validation_failed";
  const isAwaitingInput = state === "awaiting_input";
  const isPaused = state === "paused";
  const isContinuable = ["confirmed", "preparing", "planning", "implementing"].includes(state);
  const isValidating = state === "validating";
  const isManuallyCompletable = isAwaitingReview || isReviewing || isReviewBlocked || isAwaitingCommit || isAwaitMerge;
  const hasActions = isDraft || running || starting || isContinuable || isAwaitingInput || isPaused || isValidating || isAwaitingReview || isReviewing || isReviewBlocked || isFailed || isValidationFailed || isAwaitingCommit || isDelivering || isAwaitMerge || isCompleted || isCancelled;
  if (!hasActions) return null;

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-1.5 border-b px-4 py-2">
      {starting && (
        <Button size="sm" className="gap-1 px-2" disabled>
          <Loader2Icon className="animate-spin-slow" size={11} />启动中
        </Button>
      )}
      {!starting && isDraft && (
        <Button size="sm" className="gap-1 px-2" onClick={onStart}>
          <PlayIcon size={11} />开始实现
        </Button>
      )}
      {!starting && !running && isContinuable && (
        <Button size="sm" className="gap-1 px-2" onClick={onStart}>
          <PlayIcon size={11} />{state === "planning" ? "继续生成计划" : "继续执行"}
        </Button>
      )}
      {!starting && !running && isAwaitingInput && (
        <Badge variant="warning">
          <MessageCircleIcon size={10} />等待补充
        </Badge>
      )}
      {!starting && !running && isValidating && <Button size="sm" className="gap-1 px-2" onClick={onRetryValidation}><RefreshCcwIcon size={11} />继续校验</Button>}
      {!starting && running && (
        <>
          <Button size="sm" variant="secondary" className="gap-1 px-2" onClick={onPause}>
            <PauseIcon size={11} />暂停
          </Button>
          <Button size="sm" variant="destructive" className="gap-1 px-2" onClick={onAbort}>
            <SquareIcon size={11} />终止
          </Button>
        </>
      )}
      {!starting && !running && isPaused && (
        <Button size="sm" className="gap-1 px-2" onClick={onResumePaused}>
          <PlayIcon size={11} />继续执行
        </Button>
      )}
      {!starting && !running && isAwaitingReview && (
        <Button size="sm" className="gap-1 px-2" onClick={onReview}>
          <RefreshCcwIcon size={11} />开始 Review
        </Button>
      )}
      {!starting && !running && isReviewing && (
        <Button size="sm" className="gap-1 px-2" onClick={onResetReview}>
          <RefreshCcwIcon size={11} />重置 Review
        </Button>
      )}
      {!starting && !running && isFailed && (
        <>
          <Button size="sm" className="gap-1 px-2" onClick={onResume}>
            <PlayIcon size={11} />继续执行
          </Button>
          <Button size="sm" variant="ghost" className="gap-1 px-2" onClick={onStart}>
            <RefreshCcwIcon size={11} />重新开始
          </Button>
        </>
      )}
      {!starting && !running && isReviewBlocked && (
        <Button size="sm" className="gap-1 px-2" onClick={onReview}>
          <RefreshCcwIcon size={11} />重新 Review
        </Button>
      )}
      {!starting && !running && isValidationFailed && <Button size="sm" className="gap-1 px-2" onClick={onRetryValidation}><RefreshCcwIcon size={11} />重新校验</Button>}
      {!starting && !running && isDelivering && (
        <Button size="sm" className="gap-1 px-2" onClick={onResetDelivery}>
          <RefreshCcwIcon size={11} />重置提交
        </Button>
      )}
      {!starting && !running && isAwaitingCommit && (
        <Button size="sm" className="gap-1 px-2" disabled={merging || !canSubmit} onClick={onSubmitMR}>
          {merging ? (
            <>
              <Loader2Icon className="animate-spin-slow" size={11} />正在提交
            </>
          ) : (
            <>
              <SendIcon size={11} />手动提交 MR
            </>
          )}
        </Button>
      )}
      {!starting && !running && isManuallyCompletable && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" className="gap-1 px-2">
              <CheckIcon size={11} />完成任务
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认完成任务？</AlertDialogTitle>
              <AlertDialogDescription>
                完成后任务将进入 Done。尚未执行或尚未结束的 Code Review、MR 提交及合并流程将被跳过。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={onManualComplete}
              >
                确认完成
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {!starting && !running && isCompleted && (
        <>
          <Button size="sm" className="gap-1 px-2" onClick={onReimplement}>
            <RefreshCcwIcon size={11} />重新实现
          </Button>
          <Badge variant="success">
            <CheckIcon size={10} />已完成
          </Badge>
        </>
      )}
      {!starting && !running && isCancelled && (
        <Badge variant="muted">
          <CheckIcon size={10} />已取消
        </Badge>
      )}
    </div>
  );
}
