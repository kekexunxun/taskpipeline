import { useMemo } from "react";
import type { Task, TaskCard } from "@coding-agent/core";
import type { ChatModelGroup, QoderStatus, TaskDetail, ChangedFile } from "../../../api";
import { DetailHeader } from "./DetailHeader";
import { UsageSection } from "./UsageSection";
import { ChangedFilesSection } from "./ChangedFilesSection";
import { MergeRequestsSection } from "./MergeRequestsSection";
import { DetailActions } from "./DetailActions";
import { Timeline, type TimelineItem } from "./Timeline";
import { TaskComposer } from "./Composer";
import { PlanSection } from "./PlanSection";
import { inReviewStates } from "../../../utils/status";

type Props = {
  card?: TaskCard;
  detail?: TaskDetail;
  liveEvents: TimelineItem[];
  qoder?: QoderStatus;
  prompt: string;
  running: boolean;
  starting: boolean;
  merging: boolean;
  onClose(): void;
  onOpenVSCode(): void;
  onOpenQoder(): void;
  onChangeModel(value: string | undefined): void;
  onStart(): void;
  onAbort(): void;
  onReview(): void;
  onResetReview(): void;
  onResetDelivery(): void;
  onRetryValidation(): void;
  onApprovePlan(): void;
  onRevisePlan(feedback: string): void;
  onSubmitMR(): void;
  onManualComplete(): void;
  onReimplement(): void;
  onPrompt(value: string): void;
  onSend(): void;
  onOpenUrl(url: string): void;
};

export function DetailPanel({
  card,
  detail,
  liveEvents,
  qoder,
  prompt,
  running,
  starting,
  merging,
  onClose,
  onOpenVSCode,
  onOpenQoder,
  onChangeModel,
  onStart,
  onAbort,
  onReview,
  onResetReview,
  onResetDelivery,
  onRetryValidation,
  onApprovePlan,
  onRevisePlan,
  onSubmitMR,
  onManualComplete,
  onReimplement,
  onPrompt,
  onSend,
  onOpenUrl
}: Props) {
  const task = detail?.task;
  const groups = useMemo(() => {
    const byRepo = new Map<string, { repositoryId: string; repositoryName: string; files: ChangedFile[] }>();
    for (const file of detail?.changedFiles ?? []) {
      const key = file.repositoryId;
      const current = byRepo.get(key) ?? { repositoryId: key, repositoryName: file.repositoryName, files: [] };
      current.files.push(file);
      byRepo.set(key, current);
    }
    return [...byRepo.values()];
  }, [detail?.changedFiles]);
  if (!task || !card) return null;
  const totalFiles = detail?.changedFiles.length ?? 0;
  const canChat = inReviewStates.has(task.state) || ["failed", "validation_failed"].includes(task.state) || running;
  const modelGroups: ChatModelGroup[] = qoder?.enabled && qoder.connected && qoder.models.length > 0
    ? [{ provider: "qoder", displayName: "Qoder Agent SDK", models: qoder.models }]
    : [];
  const hasModelSelector = modelGroups.length > 0;
  const showUsage = hasModelSelector || running || Boolean(task.sessionUsage || card.sessionUsage);
  const showChangedFiles =
    inReviewStates.has(task.state) ||
    ["completed", "failed", "validation_failed", "cancelled"].includes(task.state);
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l bg-card/50">
      <DetailHeader
        task={task}
        onClose={onClose}
        onOpenVSCode={onOpenVSCode}
        onOpenQoder={onOpenQoder}
      />
      <DetailActions
        card={card}
        running={running}
        starting={starting}
        canSubmit={card.repositories.length > 0}
        merging={merging}
        onStart={onStart}
        onAbort={onAbort}
        onReview={onReview}
        onResetReview={onResetReview}
        onResetDelivery={onResetDelivery}
        onRetryValidation={onRetryValidation}
        onSubmitMR={onSubmitMR}
        onManualComplete={onManualComplete}
        onReimplement={onReimplement}
      />
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
        <PlanSection task={task} running={running} onApprove={onApprovePlan} onRevise={onRevisePlan} />
        {showUsage && (
          <UsageSection
            task={task}
            card={card}
            model={task.qoderModel}
            onChangeModel={onChangeModel}
            modelGroups={modelGroups}
            running={running || starting}
            hasModelSelector={hasModelSelector}
          />
        )}
        {showChangedFiles && <ChangedFilesSection groups={groups} total={totalFiles} />}
        <MergeRequestsSection repos={detail?.repositories ?? []} onOpen={onOpenUrl} />
        <Timeline items={[...(detail?.events ?? []), ...liveEvents]} />
      </div>
      {canChat && (
        <div className="shrink-0 border-t bg-background/95 px-3 pb-2 pt-1.5">
          <TaskComposer
            value={prompt}
            onChange={onPrompt}
            onSend={onSend}
            disabled={
              running ||
              starting ||
              (!running &&
                task.state !== "failed" &&
                task.state !== "validation_failed" &&
                task.state !== "draft" &&
                !inReviewStates.has(task.state))
            }
          />
        </div>
      )}
    </section>
  );
}
