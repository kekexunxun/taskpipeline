import { useEffect, useState } from "react";
import { Loader2Icon, SaveIcon } from "lucide-react";
import type { AgentProfile, RepositoryProfile } from "@coding-agent/core";
import type { AgentTemplate, ChatModelGroup } from "@/api";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ChatModelSelector } from "../../ChatPage/components/ChatModelSelector";

export type AgentDraft = Omit<AgentProfile, "id" | "createdAt" | "updatedAt"> & { id?: string };
const empty: AgentDraft = { name: "", systemPrompt: "", repositoryIds: [], wikiIncludePaths: [], enabled: true };

/** 根据模型 value 在 groups 中查找 driverId，映射为 preferredProvider。 */
function providerForModel(value: string | undefined, groups: ChatModelGroup[]): "qoder" | "openai" | undefined {
  if (!value) return undefined;
  for (const group of groups) {
    if (group.models.some((m) => m.value === value)) {
      if (group.driverId === "qoder") return "qoder";
      if (group.driverId === "openai") return "openai";
      return undefined;
    }
  }
  return undefined;
}

export function AgentDialog({
  open,
  onOpenChange,
  initial,
  repositories,
  templates,
  onSaved,
  onError,
  builtin
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initial?: AgentProfile;
  repositories: RepositoryProfile[];
  templates: AgentTemplate[];
  onSaved(agent: AgentProfile): void;
  onError?(reason: unknown): void;
  builtin?: boolean;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial ?? empty);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setDraft(initial ?? empty);
  }, [initial, open]);
  const update = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const applyTemplate = (template: AgentTemplate) =>
    setDraft((current) => ({
      ...current,
      name: current.name || template.name,
      systemPrompt: template.systemPrompt,
      engineeringGuidelines: template.engineeringGuidelines
    }));
  const toggleRepository = (repositoryId: string, checked: boolean) =>
    setDraft((current) => ({
      ...current,
      repositoryIds: checked
        ? [...current.repositoryIds, repositoryId]
        : current.repositoryIds.filter((id) => id !== repositoryId)
    }));
  // 模型选择器数据
  const [modelGroups, setModelGroups] = useState<ChatModelGroup[]>([]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.listChatModels().then((groups) => {
      if (!cancelled) setModelGroups(groups);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [open]);
  const save = async () => {
    setSaving(true);
    try {
      // 选了模型才视为有偏好，否则跟随系统设置
      const hasModelPreference = Boolean(draft.preferredModel?.trim());
      const provider = hasModelPreference ? providerForModel(draft.preferredModel, modelGroups) : undefined;
      const agent: AgentProfile = {
        id: draft.id ?? crypto.randomUUID(),
        name: draft.name.trim(),
        description: draft.description?.trim() || undefined,
        systemPrompt: draft.systemPrompt,
        engineeringGuidelines: draft.engineeringGuidelines?.trim() || undefined,
        preferredProvider: provider,
        preferredModel: hasModelPreference ? draft.preferredModel!.trim() : undefined,
        repositoryIds: draft.repositoryIds,
        wikiIncludePaths: draft.wikiIncludePaths?.length ? draft.wikiIncludePaths : undefined,
        enabled: draft.enabled,
        createdAt: initial?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await api.saveAgent(agent);
      onSaved(agent);
      onOpenChange(false);
    } catch (reason) {
      onError?.(reason);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[min(560px,calc(100vh-64px))] w-[min(640px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
        <DialogHeader className="space-y-1 border-b px-5 pb-3 pt-3.5">
          <DialogTitle>{builtin ? "编辑系统角色" : draft.id ? "编辑 Agent" : "新增 Agent"}</DialogTitle>
          <DialogDescription>
            {builtin
              ? "系统内置角色 Agent 的名称、描述为固定值，仅可编辑系统提示词与模型偏好。"
              : "Agent 携带领域系统提示词与模型偏好，通过仓库白名单绑定；任务执行时自动为关联仓库注入对应指引。"}
          </DialogDescription>
        </DialogHeader>
        <div className="thin-scrollbar min-h-0 overflow-y-auto px-5 py-4">
          {!draft.id && !builtin && templates.length > 0 && (
            <Field label="基于模板新建">
              <Select
                value="__none__"
                onValueChange={(value) => {
                  const template = templates.find((item) => item.id === value);
                  if (template) applyTemplate(template);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择模板（可选）" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不使用模板</SelectItem>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name} — {template.description}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <FieldGroup className="grid-cols-2 gap-3">
            <Field label="名称">
            <Input
              value={draft.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder="例如 Java 服务端"
              disabled={builtin}
            />
          </Field>
          <Field label="描述">
            <Input
              value={draft.description ?? ""}
              onChange={(event) => update("description", event.target.value)}
              placeholder="一句话说明适用场景"
              disabled={builtin}
            />
          </Field>
          <Field className="col-span-2" label="系统提示词">
            <Textarea
              rows={6}
              value={draft.systemPrompt}
              onChange={(event) => update("systemPrompt", event.target.value)}
              placeholder={"领域知识、编码约定、需要严格遵守的规则……\n留空表示使用通用能力，不注入额外指引"}
            />
          </Field>
          <Field className="col-span-2" label="工程约定">
            <Textarea
              rows={3}
              value={draft.engineeringGuidelines ?? ""}
              onChange={(event) => update("engineeringGuidelines", event.target.value)}
              placeholder="实现前需要遵循的工程流程、复用约定（可选）"
            />
          </Field>
          <Field label="首选模型">
            <div className="flex items-center gap-1.5">
              <ChatModelSelector
                groups={modelGroups}
                value={draft.preferredModel}
                onChange={(value) => {
                  update("preferredModel", value ?? undefined);
                }}
              />
              {draft.preferredModel && (
                <span className="text-[11px] text-muted-foreground">
                  {providerForModel(draft.preferredModel, modelGroups) === "qoder" ? "Qoder" : providerForModel(draft.preferredModel, modelGroups) === "openai" ? "OpenAI" : ""}
                </span>
              )}
            </div>
          </Field>
          {!builtin && (
            <>
              <div className="col-span-2">
                <p className="mb-1.5 text-xs font-medium text-foreground">适用仓库（白名单，可多选）</p>
                {repositories.length ? (
                  <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded-md border bg-card/40 p-2">
                    {repositories.map((repository) => (
                      <label
                        key={repository.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/60"
                      >
                        <Checkbox
                          checked={draft.repositoryIds.includes(repository.id)}
                          onCheckedChange={(checked) => toggleRepository(repository.id, checked === true)}
                        />
                        <span className="truncate">{repository.name}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                    还没有配置仓库，可稍后在仓库页添加
                  </p>
                )}
              </div>
              <label className="col-span-2 flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-foreground">启用</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    关闭后该 Agent 不参与仓库解析，相关仓库回退使用通用能力。
                  </span>
                </span>
                <Switch checked={draft.enabled} onCheckedChange={(checked) => update("enabled", checked)} />
              </label>
              <p className="col-span-2 text-[11px] leading-5 text-muted-foreground">
                不配置模型时跟随系统全局模型设置；选择模型后自动识别对应提供者（Qoder / OpenAI 兼容）。
              </p>
            </>
          )}
        </FieldGroup>
        </div>
        <DialogFooter className="border-t px-5 py-2.5">
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              取消
            </Button>
          </DialogClose>
          <Button size="sm" disabled={saving || !draft.name.trim()} onClick={() => void save()}>
            {saving ? <Loader2Icon className="animate-spin-slow" size={11} /> : <SaveIcon size={11} />}
            {saving ? "保存中" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
