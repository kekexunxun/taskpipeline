import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import type { Memory, MemoryScope, RepositoryProfile } from "@task-pipeline/core";
import { api } from "@/api";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export function MemoryDialog({
  open,
  onOpenChange,
  initial,
  repositories,
  onSaved,
  onError
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initial?: Partial<Memory> & { id?: string };
  repositories: RepositoryProfile[];
  onSaved(memory: Memory): void;
  onError?(reason: unknown): void;
}) {
  const [scope, setScope] = useState<MemoryScope>("user");
  const [repositoryId, setRepositoryId] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setScope(initial?.scope ?? "user");
      setRepositoryId(initial?.repositoryId ?? "");
      setTitle(initial?.title ?? "");
      setContent(initial?.content ?? "");
      setTags(initial?.tags?.join(", ") ?? "");
      setPinned(initial?.pinned ?? false);
    }
  }, [initial, open]);

  const save = async () => {
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (!trimmedTitle || !trimmedContent) {
      onError?.(new Error("标题与内容不能为空"));
      return;
    }
    if (scope === "repo" && !repositoryId) {
      onError?.(new Error("仓库级记忆必须选择所属仓库"));
      return;
    }
    setSaving(true);
    const editingId = initial?.id;
    try {
      const patch = {
        scope,
        repositoryId: scope === "repo" ? repositoryId : undefined,
        title: trimmedTitle,
        content: trimmedContent,
        tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        pinned,
        importance: initial?.importance ?? 0.5,
        source: "manual" as const
      };
      const saved = editingId ? await api.updateMemory(editingId, patch) : await api.upsertMemory(patch);
      onSaved(saved);
      onOpenChange(false);
    } catch (reason) {
      onError?.(reason);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(560px,calc(100vw-48px))]">
        <DialogHeader>
          <DialogTitle>{initial?.id ? "编辑记忆" : "新增记忆"}</DialogTitle>
          <DialogDescription>记忆会按作用域注入到对话与任务执行上下文。</DialogDescription>
        </DialogHeader>
        <FieldGroup className="grid-cols-2 gap-3 overflow-y-auto px-1 py-1">
          <Field label="作用域">
            <Select value={scope} onValueChange={(value) => setScope(value as MemoryScope)}>
              <SelectTrigger aria-label="作用域" className="h-8 text-xs!">
                <SelectValue placeholder="选择作用域" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">用户级</SelectItem>
                <SelectItem value="repo">仓库级</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {scope === "repo" && (
            <Field label="所属仓库">
              <Select value={repositoryId} onValueChange={setRepositoryId}>
                <SelectTrigger aria-label="所属仓库" className="h-8 text-xs!">
                  <SelectValue placeholder="选择仓库" />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((repository) => (
                    <SelectItem key={repository.id} value={repository.id}>
                      {repository.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field className="col-span-2" label="标题">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：项目使用 pnpm 管理依赖" />
          </Field>
          <Field className="col-span-2" label="内容">
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="记忆的具体内容，会注入到 Agent 上下文中"
              rows={4}
            />
          </Field>
          <Field className="col-span-2" label="标签">
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="逗号分隔，例如：约定, 命令" />
          </Field>
          <label className="col-span-2 flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">置顶</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">置顶记忆在注入排序中优先。</span>
            </span>
            <Switch checked={pinned} onCheckedChange={setPinned} />
          </label>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="sm">取消</Button>
          </DialogClose>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2Icon className="animate-spin-slow" size={11} /> : null}
            {saving ? "保存中" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
