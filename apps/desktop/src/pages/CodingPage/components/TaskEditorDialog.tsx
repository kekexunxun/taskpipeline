import { useEffect, useRef, useState } from "react";
import { Loader2Icon, SaveIcon } from "lucide-react";
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
import { mergeRepositoryOptions, RepositoryPicker } from "./RepositoryPicker";

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
        const attached = detail?.repositories ?? [];
        setRepositories(mergeRepositoryOptions(repos, attached));
        const ids = attached.map((item) => item.repositoryId);
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
            <RepositoryPicker repositories={repositories} selectedIds={selectedRepoIds} loading={loading} onToggle={toggleRepo} />
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
