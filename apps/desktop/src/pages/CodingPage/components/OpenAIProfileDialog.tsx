import { useEffect, useState } from "react";
import { Loader2Icon, PencilIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
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
import { SecretInput } from "@/components/ui/secret-input";
import { Badge } from "@/components/ui/badge";

export type OpenAIProfile = {
  baseUrl: string;
  model: string;
  displayName?: string;
  apiKeyConfigured: boolean;
};

/**
 * OpenAI-Compatible 模型配置弹窗：
 * - 填写 URL（Base URL）、API Key、显示名称、Model ID。
 * - 支持新增/编辑两种模式，编辑时若 API Key 为空则保留已有值。
 */
export function OpenAIProfileDialog({
  open,
  onOpenChange,
  initial,
  mode,
  onSaved,
  onDeleted,
  onError
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initial?: OpenAIProfile;
  mode: "create" | "edit";
  onSaved(profile: { baseUrl: string; model: string; displayName?: string; apiKey: string | undefined }): void;
  onDeleted?(): void;
  onError?(reason: unknown): void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!open) return;
    setBaseUrl(initial?.baseUrl ?? "");
    setModel(initial?.model ?? "");
    setDisplayName(initial?.displayName ?? "");
    setApiKey(initial?.apiKeyConfigured ? "__configured__" : "");
  }, [open, initial]);
  const trimmedBase = baseUrl.trim();
  const trimmedModel = model.trim();
  const canSave = trimmedBase.length > 0 && trimmedModel.length > 0 && !saving && !deleting;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const apiKeyValue = apiKey === "__configured__" ? undefined : apiKey;
      onSaved({ baseUrl: trimmedBase, model: trimmedModel, displayName: displayName.trim() || undefined, apiKey: apiKeyValue });
    } catch (reason) {
      onError?.(reason);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!onDeleted) return;
    setDeleting(true);
    try {
      onDeleted();
    } catch (reason) {
      onError?.(reason);
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[520px] !max-w-[520px] grid max-h-[min(560px,calc(100vh-64px))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
        <DialogHeader className="space-y-1 border-b px-5 pb-3 pt-3.5">
          <DialogTitle className="text-sm">{mode === "create" ? "新增 OpenAI-Compatible 模型" : "编辑 OpenAI-Compatible 模型"}</DialogTitle>
          <DialogDescription>配置兼容 OpenAI API 格式的模型服务，可用于对话与任务执行。</DialogDescription>
        </DialogHeader>
        <div className="thin-scrollbar min-h-0 overflow-y-auto px-5 py-4">
          <FieldGroup className="gap-3">
            <Field label="URL">
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://gateway.example.com/v1"
              />
            </Field>
            <Field label="API Key">
              <SecretInput
                aria-label="API Key"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </Field>
            <Field label="名称">
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="公司自建网关"
              />
            </Field>
            <Field label="使用的模型 (Model)">
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="gpt-4o-mini"
              />
            </Field>
            {trimmedModel && (
              <div className="flex items-center gap-2 rounded-md border bg-card/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">预览</span>
                <Badge variant="outline">{displayName.trim() || "OpenAI-Compatible"}</Badge>
                <span className="truncate font-mono text-xs text-foreground/80">{trimmedModel}</span>
              </div>
            )}
          </FieldGroup>
        </div>
        <DialogFooter className="border-t px-5 py-2.5">
          {mode === "edit" && onDeleted && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto text-muted-foreground hover:text-destructive"
              disabled={deleting || saving}
              onClick={() => void remove()}
            >
              {deleting ? <Loader2Icon className="animate-spin-slow" size={11} /> : <Trash2Icon size={11} />}
              {deleting ? "删除中" : "删除配置"}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              取消
            </Button>
          </DialogClose>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {saving ? <Loader2Icon className="animate-spin-slow" size={11} /> : <SaveIcon size={11} />}
            {saving ? "保存中" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 触发按钮：区分空状态（新增） 与 已配置（编辑） 两种用法。
 */
export function OpenAIProfileTrigger({
  configured,
  onClick
}: {
  configured: boolean;
  onClick(): void;
}) {
  if (configured) {
    return (
      <Button variant="secondary" size="sm" onClick={onClick}>
        <PencilIcon size={11} />
        编辑
      </Button>
    );
  }
  return (
    <Button size="sm" onClick={onClick}>
      <PlusIcon size={11} />
      新增 OpenAI-Compatible
    </Button>
  );
}
