import { CheckIcon, Loader2Icon, PlayIcon, RefreshCcwIcon, SendIcon, SquareIcon } from "lucide-react";
import type { TaskCard } from "@coding-agent/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function DetailActions({
  card,
  running,
  canSubmit,
  merging,
  onStart,
  onAbort,
  onReview,
  onResetReview,
  onResetDelivery,
  onRetryValidation,
  onSubmitMR,
  onManualComplete,
  onReimplement
}: {
  card: TaskCard;
  running: boolean;
  canSubmit: boolean;
  merging: boolean;
  onStart(): void;
  onAbort(): void;
  onReview(): void;
  onResetReview(): void;
  onResetDelivery(): void;
  onRetryValidation(): void;
  onSubmitMR(): void;
  onManualComplete(): void;
  onReimplement(): void;
}) {
  const state = card.state;
  const isDraft = state === "draft";
  const isImplemented = state === "awaiting_review" || state === "reviewing";
  const isReviewBlocked = state === "review_blocked";
  const isAwaitingCommit = state === "awaiting_commit";
  const isDelivering = state === "delivering";
  const isCompleted = state === "completed";
  const isCancelled = state === "cancelled";
  const isFailed = state === "failed";
  const isValidationFailed = state === "validation_failed";
  const hasActions = isDraft || running || isImplemented || isReviewBlocked || isFailed || isValidationFailed || isAwaitingCommit || isDelivering || isCompleted || isCancelled;
  if (!hasActions) return null;

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-1.5 border-b px-4 py-2">
      {isDraft && (
        <Button size="sm" className="gap-1 px-2" onClick={onStart}>
          <PlayIcon size={11} />开始实现
        </Button>
      )}
      {running && (
        <Button size="sm" variant="destructive" className="gap-1 px-2" onClick={onAbort}>
          <SquareIcon size={11} />终止
        </Button>
      )}
      {isImplemented && (
        <Button size="sm" className="gap-1 px-2" onClick={onReview}>
          <RefreshCcwIcon size={11} />重新 Review
        </Button>
      )}
      {isFailed && (
        <Button size="sm" className="gap-1 px-2" onClick={onStart}>
          <RefreshCcwIcon size={11} />重新开始
        </Button>
      )}
      {isReviewBlocked && (
        <Button size="sm" className="gap-1 px-2" onClick={onResetReview}>
          <RefreshCcwIcon size={11} />重置 Review
        </Button>
      )}
      {isValidationFailed && <Button size="sm" className="gap-1 px-2" onClick={onRetryValidation}><RefreshCcwIcon size={11} />重新校验</Button>}
      {(isAwaitingCommit || isDelivering) && (
        <Button size="sm" className="gap-1 px-2" onClick={onResetDelivery}>
          <RefreshCcwIcon size={11} />重置提交
        </Button>
      )}
      {isAwaitingCommit && canSubmit && (
        <Button size="sm" className="gap-1 px-2" disabled={merging} onClick={onSubmitMR}>
          {merging ? (
            <>
              <Loader2Icon className="animate-spin-slow" size={11} />正在提交
            </>
          ) : (
            <>
              <SendIcon size={11} />提交 MR
            </>
          )}
        </Button>
      )}
      {isCompleted && (
        <>
          <Button size="sm" className="gap-1 px-2" onClick={onReimplement}>
            <RefreshCcwIcon size={11} />重新实现
          </Button>
          <Badge variant="success">
            <CheckIcon size={10} />已完成
          </Badge>
        </>
      )}
      {isCancelled && (
        <Badge variant="muted">
          <CheckIcon size={10} />已取消
        </Badge>
      )}
    </div>
  );
}
