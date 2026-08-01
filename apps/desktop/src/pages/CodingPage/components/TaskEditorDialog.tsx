import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, GitBranchIcon, Loader2Icon, SaveIcon, XIcon } from "lucide-react";
import type { RepositoryProfile, Task } from "@coding-agent/core";
import { api } from "@/api";
import { useFeedback } from "@/hooks/useGlobalFeedback";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * 任务编辑器（新建/编辑）。
 * - 仓库选择以卡片形式呈现，与设置页仓库列表风格一致。
 * - 编辑模式：进入弹窗时自动调用 `api.getTask(taskId)` 加载关联仓库列表。
 * - 保存：先 createTask / updateTask，再对关联仓库做 attach/detach diff。
 */
export function TaskEditorDialog({
  task,
  open,
  onOpenChange,
  onSaved
}: {
  task?: Task;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved(task: Task): void | Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [keywords, setKeywords] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [repositories, setRepositories] = useState<RepositoryProfile[]>([]);
  const [initialRepoIds, setInitialRepoIds] = useState<string[]>([]);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const { showError, showSuccess } = useFeedback();
  const initialIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    setKeywords(task?.keywords.join(", ") ?? "");
    setAcceptance(task?.acceptanceCriteria.join("\n") ?? "");
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.listRepositories().catch((reason) => {
        showError(reason instanceof Error ? reason.message : String(reason));
        return [] as RepositoryProfile[];
      }),
      task ? api.getTask(task.id).catch(() => undefined) : Promise.resolve(undefined)
    ])
      .then(([repos, detail]) => {
        if (cancelled) return;
        setRepositories(repos);
        const ids = (detail?.repositories ?? []).map((item) => item.repositoryId);
        initialIdsRef.current = ids;
        setInitialRepoIds(ids);
        setSelectedRepoIds(new Set(ids));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  const creating = !task;
  const toggleRepo = (id: string, checked: boolean) => {
    setSelectedRepoIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const save = async () => {
    const input = {
      title: title.trim(),
      description: description.trim(),
      keywords: keywords
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      acceptanceCriteria: acceptance
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
    };
    setSaving(true);
    try {
      const saved = task
        ? await api.updateTask(task.id, input)
        : await api.createTask(input);
      const desired = new Set(selectedRepoIds);
      const current = new Set(initialIdsRef.current);
      const toAttach = [...desired].filter((id) => !current.has(id));
      const toDetach = [...current].filter((id) => !desired.has(id));
      for (const repoId of toAttach) {
        await api.attachRepository(saved.id, repoId);
      }
      for (const repoId of toDetach) {
        await api.detachRepository(saved.id, repoId);
      }
      await onSaved(saved);
      showSuccess(creating ? "任务已创建" : "任务已更新");
      onOpenChange(false);
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const selectedRepos = useMemo(
    () => repositories.filter((repo) => selectedRepoIds.has(repo.id)),
    [repositories, selectedRepoIds]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(680px,calc(100vw-48px))]">
        <DialogHeader>
          <DialogTitle>{creating ? "新建任务" : "编辑任务"}</DialogTitle>
          <DialogDescription>
            {creating
              ? "创建本地任务，并选择要关联的仓库。"
              : "调整标题、描述、关键词、验收标准与仓库关联。"}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="grid-cols-1 gap-3 overflow-y-auto px-1 py-1">
          <Field label="标题">
            <Input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="描述">
            <Textarea
              value={description}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field label="关键词（逗号分隔）">
            <Input
              value={keywords}
              onChange={(event) => setKeywords(event.target.value)}
            />
          </Field>
          <Field label="验收标准（每行一条）">
            <Textarea
              value={acceptance}
              rows={2}
              onChange={(event) => setAcceptance(event.target.value)}
            />
          </Field>
          <Field
            label={
              <span className="flex items-center justify-between gap-2">
                <span>关联仓库</span>
                <small className="text-xs font-normal text-muted-foreground">
                  已选 {selectedRepoIds.size} / {repositories.length}
                </small>
              </span>
            }
          >
            {repositories.length === 0 && !loading ? (
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                还没有可关联的仓库。请到设置 → 仓库 中添加。
              </div>
            ) : (
              <div className="thin-scrollbar max-h-44 space-y-1.5 overflow-y-auto rounded-md border bg-card/60 p-1.5">
                {repositories.map((repo) => {
                  const checked = selectedRepoIds.has(repo.id);
                  return (
                    <button
                      type="button"
                      key={repo.id}
                      onClick={() => toggleRepo(repo.id, !checked)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md border bg-card p-2 text-left transition-colors hover:border-border hover:bg-accent/40",
                        checked && "border-ring bg-accent/70"
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-[3px] border",
                          checked
                            ? "border-foreground bg-foreground text-background"
                            : "border-border bg-background"
                        )}
                      >
                        {checked && <CheckIcon size={9} strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-semibold text-white">
                            {repo.name}
                          </span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <GitBranchIcon size={9} className="shrink-0" />
                          {repo.defaultBranch || "main"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="sm" disabled={saving}>
              取消
            </Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={!title.trim() || saving || loading}
            onClick={() => void save()}
          >
            {saving ? (
              <Loader2Icon className="animate-spin-slow" size={12} />
            ) : (
              <SaveIcon size={12} />
            )}
            {creating ? "创建" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
