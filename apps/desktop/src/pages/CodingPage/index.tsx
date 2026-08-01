import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTasks } from "./hooks/useTasks";
import { useQoderStatusContext } from "../../hooks/useQoderStatusContext";
import { useFeedback } from "../../hooks/useGlobalFeedback";
import { api } from "../../api";
import { BoardPanel } from "./components/BoardPanel";
import { DetailPanel } from "./components/DetailPanel";
import { TaskEditorDialog } from "./components/TaskEditorDialog";
import { JiraDialog } from "./components/JiraDialog";
import { JiraSyncDialog } from "./components/JiraSyncDialog";
import { UiRequestDialog } from "./components/UiRequestDialog";
import { TaskStartDialog } from "./components/TaskStartDialog";

export default function CodingPage() {
  const navigate = useNavigate();
  const { taskId } = useParams();
  const qoder = useQoderStatusContext();
  const { showError, showSuccess } = useFeedback();
  const tasks = useTasks();
  const [editingTask, setEditingTask] = useState<string | "new">();
  const [jiraOpen, setJiraOpen] = useState(false);
  const [jiraSyncOpen, setJiraSyncOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [reimplementing, setReimplementing] = useState(false);

  // URL ↔ state 同步
  useEffect(() => {
    if (taskId && taskId !== tasks.selectedId) tasks.setSelectedId(taskId);
    if (!taskId && tasks.selectedId) tasks.setSelectedId(undefined);
  }, [taskId, tasks.selectedId, tasks.setSelectedId]);

  // 监听全局仓库变更事件
  useEffect(() => {
    const onChanged = () => {
      void tasks.refresh();
      if (tasks.selectedId) void tasks.loadDetail(tasks.selectedId);
    };
    window.addEventListener("app:repositories-changed", onChanged);
    return () => window.removeEventListener("app:repositories-changed", onChanged);
  }, [tasks.refresh, tasks.loadDetail, tasks.selectedId]);

  const onOpenTask = useCallback((id: string) => {
    tasks.setSelectedId(id);
    navigate(`/coding/${id}`);
  }, [navigate, tasks]);

  const onCloseDetail = useCallback(() => {
    navigate("/coding");
  }, [navigate]);

  const onRemove = useCallback((id: string) => {
    api.deleteTask(id).then(() => tasks.refresh()).catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)));
  }, [showError, tasks]);

  const runAction = useCallback((action: () => Promise<unknown>) => {
    return tasks.run(action).catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)));
  }, [showError, tasks]);

  const editing = editingTask === "new" ? undefined : tasks.tasks.find((task) => task.id === editingTask);
  const showDetail = Boolean(tasks.selectedId && tasks.detail);

  return (
    <>
      <div className={`grid h-full min-h-0 min-w-0 ${showDetail ? "grid-cols-[minmax(0,1fr)_clamp(400px,34vw,520px)]" : "grid-cols-1"}`}>
        <BoardPanel
          tasks={tasks.tasks}
          search={tasks.search}
          onSearch={tasks.setSearch}
          selectedId={tasks.selectedId}
          onOpen={onOpenTask}
          onEdit={(id) => setEditingTask(id)}
          onRemove={onRemove}
          onCreate={() => setEditingTask("new")}
          onFromJira={() => setJiraOpen(true)}
          onSyncJira={() => setJiraSyncOpen(true)}
        />
        {showDetail && (
          <DetailPanel
            card={tasks.tasks.find((t) => t.id === tasks.selectedId)}
            detail={tasks.detail}
            liveEvents={tasks.liveEvents}
            qoder={qoder.status}
            prompt={tasks.prompt}
            running={tasks.running}
            merging={merging}
            onClose={onCloseDetail}
            onOpenVSCode={() => { if (tasks.selectedId) api.openTaskEditor(tasks.selectedId, "vscode").catch((reason) => showError(reason instanceof Error ? reason.message : String(reason))); }}
            onOpenQoder={() => { if (tasks.selectedId) api.openTaskEditor(tasks.selectedId, "qoder").catch((reason) => showError(reason instanceof Error ? reason.message : String(reason))); }}
            onChangeModel={(value) => {
              if (!tasks.selectedId) return;
              api.updateTask(tasks.selectedId, { qoderModel: value }).then(async () => {
                await tasks.refresh();
                if (tasks.selectedId) await tasks.loadDetail(tasks.selectedId);
              }).catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)));
            }}
            onStart={() => { setStartOpen(true); }}
            onAbort={() => runAction(() => api.abortTask())}
            onReview={() => { if (tasks.selectedId) runAction(() => api.runReview(tasks.selectedId!)); }}
            onResetReview={() => { if (tasks.selectedId) runAction(() => api.resetReview(tasks.selectedId!)); }}
            onResetDelivery={() => { if (tasks.selectedId) runAction(() => api.resetDelivery(tasks.selectedId!)); }}
            onRetryValidation={() => { if (tasks.selectedId) runAction(() => api.retryTaskValidation(tasks.selectedId!)); }}
            onApprovePlan={() => { if (tasks.selectedId) runAction(() => api.approveTaskPlan(tasks.selectedId!)); }}
            onRevisePlan={(feedback) => { if (tasks.selectedId) runAction(() => api.reviseTaskPlan(tasks.selectedId!, feedback)); }}
            onSubmitMR={() => {
              if (!tasks.selectedId) return;
              setMerging(true);
              api.submitMergeRequests(tasks.selectedId).then(() => {
                showSuccess("MR 提交完成");
                return tasks.refresh();
              }).then(() => api.refreshMergeStatus()).then((summaries) => {
                for (const summary of summaries) {
                  if (summary.taskId === tasks.selectedId) {
                    for (const repo of summary.repos) {
                      if (repo.state === "error") showError(`${repo.repoName} 提交失败：${repo.error ?? "未知错误"}`);
                      else if (repo.state === "merged") showSuccess(`${repo.repoName} 已合并`);
                      else if (repo.state === "closed") showError(`${repo.repoName} MR 已关闭`);
                    }
                  }
                }
              }).catch((reason) => showError(reason instanceof Error ? reason.message : String(reason))).finally(() => setMerging(false));
            }}
            onManualComplete={() => { if (tasks.selectedId) runAction(() => api.manualComplete(tasks.selectedId!)); }}
            onReimplement={() => { setReimplementing(true); setStartOpen(true); }}
            onPrompt={tasks.setPrompt}
            onSend={() => tasks.send()}
            onOpenUrl={(url) => api.openExternal(url).catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)))}
          />
        )}
      </div>
      <TaskEditorDialog
        open={Boolean(editingTask)}
        task={editing}
        onOpenChange={(open) => { if (!open) setEditingTask(undefined); }}
        onSaved={async (saved) => { await tasks.refresh(); await tasks.loadDetail(saved.id); if (editingTask === "new") onOpenTask(saved.id); }}
      />
      <JiraDialog open={jiraOpen} onOpenChange={setJiraOpen} onImported={tasks.refresh} />
      <JiraSyncDialog open={jiraSyncOpen} onOpenChange={setJiraSyncOpen} onImported={tasks.refresh} />
      <UiRequestDialog />
      <TaskStartDialog
        open={startOpen}
        taskId={tasks.selectedId}
        reimplement={reimplementing}
        onOpenChange={(open) => { setStartOpen(open); if (!open) setReimplementing(false); }}
        onStarted={async () => { setReimplementing(false); await tasks.refresh(); if (tasks.selectedId) await tasks.loadDetail(tasks.selectedId); }}
      />
    </>
  );
}
