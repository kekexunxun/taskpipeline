import { Check, Loader2, Play, RefreshCcw, Send, Square } from "lucide-react";
import type { TaskCard } from "@coding-agent/core";

export function DetailActions({ card, running, canSubmit, merging, onStart, onAbort, onReview, onResetReview, onResetDelivery, onSubmitMR, onManualComplete }: {
  card: TaskCard;
  running: boolean;
  canSubmit: boolean;
  merging: boolean;
  onStart(): void;
  onAbort(): void;
  onReview(): void;
  onResetReview(): void;
  onResetDelivery(): void;
  onSubmitMR(): void;
  onManualComplete(): void;
}) {
  const state = card.state;
  const isDraft = state === "draft";
  const isImplemented = state === "awaiting_review" || state === "reviewing";
  const isReviewBlocked = state === "review_blocked";
  const isAwaitingCommit = state === "awaiting_commit";
  const isDelivering = state === "delivering";
  const isCompleted = state === "completed" || state === "cancelled";
  const isFailed = state === "failed";
  return (
    <div className="action-row">
      {isDraft && <button className="primary" onClick={onStart}><Play size={14} />开始实现</button>}
      {running && <button className="primary" onClick={onAbort}><Square size={14} />终止</button>}
      {isImplemented && <button className="primary" onClick={onReview}><RefreshCcw size={14} />重新 Review</button>}
      {(isReviewBlocked || isFailed) && <button className="primary" onClick={onResetReview}><RefreshCcw size={14} />重置 Review</button>}
      {(isAwaitingCommit || isDelivering) && <button className="primary" onClick={onResetDelivery}><RefreshCcw size={14} />重置提交</button>}
      {isAwaitingCommit && canSubmit && <button className="primary" onClick={onSubmitMR}>{merging ? <><Loader2 className="spinning" size={14} />正在提交…</> : <><Send size={14} />提交 MR</>}</button>}
      {isCompleted && <span className="state-badge terminal completed"><Check size={12} />{state === "completed" ? "已完成" : "已取消"}</span>}
      {isCompleted && <button className="secondary" onClick={onManualComplete}><Check size={12} />手动结束</button>}
    </div>
  );
}
