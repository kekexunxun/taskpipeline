import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Save } from "lucide-react";
import type { RepositoryProfile, McpProfile } from "@coding-agent/core";
import { api } from "../../../api";

type RepoDraft = Omit<RepositoryProfile, "id"> & { id?: string };

const empty: RepoDraft = { name: "", localPath: "", remoteUrl: "", defaultBranch: "main" };

export function RepositoryDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange(open: boolean): void; onSaved(): void }) {
  const [draft, setDraft] = useState<RepoDraft>(empty);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content repository-dialog">
          <Dialog.Title>新增 / 编辑仓库</Dialog.Title>
          <Dialog.Description>选择本地目录后，App 会自动读取 git remote 与默认分支。</Dialog.Description>
          <div className="dialog-form">
            <label>名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>本地路径
              <div className="path-input">
                <input value={draft.localPath} onChange={(event) => setDraft({ ...draft, localPath: event.target.value })} placeholder="/Users/me/projects/foo" />
                <button className="secondary" onClick={async () => { const folder = await api.chooseRepositoryFolder(); if (folder) setDraft({ ...draft, ...folder }); }}>选择…</button>
              </div>
            </label>
            <label>Remote URL<input value={draft.remoteUrl ?? ""} onChange={(event) => setDraft({ ...draft, remoteUrl: event.target.value })} /></label>
            <label>默认分支<input value={draft.defaultBranch} onChange={(event) => setDraft({ ...draft, defaultBranch: event.target.value })} /></label>
            <label>GitLab Project ID<input value={draft.gitlabProjectId ?? ""} onChange={(event) => setDraft({ ...draft, gitlabProjectId: event.target.value || undefined })} /></label>
            <label>测试命令<input value={draft.testCommand ?? ""} onChange={(event) => setDraft({ ...draft, testCommand: event.target.value || undefined })} /></label>
            <label>Lint 命令<input value={draft.lintCommand ?? ""} onChange={(event) => setDraft({ ...draft, lintCommand: event.target.value || undefined })} /></label>
            <label>构建命令<input value={draft.buildCommand ?? ""} onChange={(event) => setDraft({ ...draft, buildCommand: event.target.value || undefined })} /></label>
          </div>
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="secondary">取消</button></Dialog.Close>
            <button className="primary" onClick={async () => {
              const profile: RepositoryProfile = {
                id: draft.id ?? crypto.randomUUID(),
                name: draft.name.trim(),
                localPath: draft.localPath.trim(),
                remoteUrl: draft.remoteUrl?.trim() || undefined,
                defaultBranch: draft.defaultBranch.trim() || "main",
                gitlabProjectId: draft.gitlabProjectId,
                testCommand: draft.testCommand,
                lintCommand: draft.lintCommand,
                buildCommand: draft.buildCommand
              };
              await api.saveRepository(profile);
              setDraft(empty);
              onOpenChange(false);
              onSaved();
            }}><Save size={14} />保存</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function McpProfileDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange(open: boolean): void; onSaved(): void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>MCP Profile（暂未在 UI 暴露）</Dialog.Title>
          <Dialog.Description>请通过 settings.json 维护 mcpProfiles 字段。</Dialog.Description>
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="secondary">关闭</button></Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function TestButton({ kind, label }: { kind: "jira" | "confluence"; label: string }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | undefined>();
  return (
    <span className="test-button-row">
      <button className="secondary" disabled={running} onClick={async () => { setRunning(true); try { setResult(await api.testAtlassian(kind)); } finally { setRunning(false); } }}>{running ? "测试中…" : label}</button>
      {result && <span className={`test-result ${result.ok ? "ok" : "fail"}`}>{result.message}</span>}
    </span>
  );
}

void McpProfileDialog; // 暂未使用
void ((_p: McpProfile) => undefined);
