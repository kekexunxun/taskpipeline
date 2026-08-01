import { useEffect, useRef, useState } from "react";
import type { RepositoryProfile, TaskRepository, TaskStartMode } from "@coding-agent/core";
import { api, type RepositoryCommands, type StartTaskOptions } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { mergeRepositoryOptions, RepositoryPicker } from "./RepositoryPicker";
import { useFeedback } from "@/hooks/useGlobalFeedback";

export function TaskStartDialog({ open, taskId, onOpenChange, onStarted }: { open: boolean; taskId?: string; onOpenChange(open: boolean): void; onStarted(): Promise<void> }) {
  const { showError } = useFeedback();
  const [mode, setMode] = useState<TaskStartMode>("direct");
  const [repositories, setRepositories] = useState<RepositoryProfile[]>([]);
  const [taskRepositories, setTaskRepositories] = useState<TaskRepository[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [commands, setCommands] = useState<Record<string, RepositoryCommands>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const initialIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open || !taskId) return;
    let cancelled = false;
    setMode("direct");
    setLoading(true);
    Promise.all([api.listRepositories(), api.getTask(taskId)]).then(([profiles, detail]) => {
      if (cancelled) return;
      const attached = detail.repositories;
      const options = mergeRepositoryOptions(profiles, attached);
      const ids = new Set(attached.map((repo) => repo.repositoryId));
      const attachedByProfile = new Map(attached.map((repo) => [repo.repositoryId, repo]));
      setRepositories(options);
      setTaskRepositories(attached);
      setSelectedIds(ids);
      initialIds.current = ids;
      setCommands(Object.fromEntries(options.map((profile) => {
        const repo = attachedByProfile.get(profile.id);
        return [profile.id, {
          setupCommand: repo?.setupCommand ?? profile.setupCommand,
          lintCommand: repo?.lintCommand ?? profile.lintCommand,
          testCommand: repo?.testCommand ?? profile.testCommand,
          buildCommand: repo?.buildCommand ?? profile.buildCommand
        }];
      })));
    }).catch((reason) => showError(reason instanceof Error ? reason.message : String(reason))).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, taskId, showError]);

  const toggleRepository = (id: string, selected: boolean) => setSelectedIds((current) => {
    const next = new Set(current);
    if (selected) next.add(id); else next.delete(id);
    return next;
  });
  const update = (id: string, key: keyof RepositoryCommands, value: string) => setCommands((current) => ({ ...current, [id]: { ...current[id], [key]: value } }));
  const submit = async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      for (const id of selectedIds) if (!initialIds.current.has(id)) await api.attachRepository(taskId, id);
      for (const id of initialIds.current) if (!selectedIds.has(id)) await api.detachRepository(taskId, id);
      const repositoryCommands = Object.fromEntries([...selectedIds].map((id) => [id, commands[id] ?? {}]));
      await api.startTask(taskId, { mode, repositoryCommands });
      await onStarted();
      onOpenChange(false);
    } catch (reason) { showError(reason instanceof Error ? reason.message : String(reason)); } finally { setSaving(false); }
  };

  const selectedProfiles = repositories.filter((repo) => selectedIds.has(repo.id));
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="w-[min(720px,calc(100vw-32px))]">
      <DialogHeader><DialogTitle>开始任务</DialogTitle><DialogDescription>选择关联仓库和启动方式。这里的仓库关联与任务编辑保持一致。</DialogDescription></DialogHeader>
      <div className="flex gap-1 rounded-md border p-1"><Button type="button" variant={mode === "direct" ? "default" : "ghost"} className="flex-1 text-xs!" onClick={() => setMode("direct")}>直接开始</Button><Button type="button" variant={mode === "plan" ? "default" : "ghost"} className="flex-1 text-xs!" onClick={() => setMode("plan")}>先生成计划</Button></div>
      <div className="thin-scrollbar max-h-[58vh] space-y-4 overflow-y-auto pr-1">
        <Field label={<span className="flex items-center justify-between gap-2"><span>关联仓库</span><small className="text-xs font-normal text-muted-foreground">已选 {selectedIds.size} / {repositories.length}</small></span>}><RepositoryPicker repositories={repositories} selectedIds={selectedIds} loading={loading} onToggle={toggleRepository} /></Field>
        {selectedProfiles.map((profile) => {
          const taskRepo = taskRepositories.find((repo) => repo.repositoryId === profile.id);
          return <section key={profile.id} className="space-y-2 rounded-md border p-3"><div className="text-xs font-semibold">{profile.name}{taskRepo ? "" : " · 新关联"}</div><FieldGroup className="grid-cols-2 gap-2"><Field className="col-span-2" label="准备命令"><Textarea value={commands[profile.id]?.setupCommand ?? ""} onChange={(event) => update(profile.id, "setupCommand", event.target.value)} placeholder="可选，例如 npm install" /></Field><Field label="Lint"><Input value={commands[profile.id]?.lintCommand ?? ""} onChange={(event) => update(profile.id, "lintCommand", event.target.value)} /></Field><Field label="Test"><Input value={commands[profile.id]?.testCommand ?? ""} onChange={(event) => update(profile.id, "testCommand", event.target.value)} /></Field><Field className="col-span-2" label="Build"><Input value={commands[profile.id]?.buildCommand ?? ""} onChange={(event) => update(profile.id, "buildCommand", event.target.value)} /></Field></FieldGroup></section>;
        })}
      </div>
      <DialogFooter><DialogClose asChild><Button size="sm" variant="secondary">取消</Button></DialogClose><Button size="sm" disabled={saving || loading || selectedIds.size === 0} onClick={() => void submit()}>{saving ? "启动中" : mode === "plan" ? "生成计划" : "开始实现"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
