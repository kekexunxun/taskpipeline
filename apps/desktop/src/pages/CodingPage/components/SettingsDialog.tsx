import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Plug, Save } from "lucide-react";
import { api, type QoderStatus } from "../../../api";
import { TestButton } from "./RepositoryDialog";

type Tab = "general" | "atlassian" | "repositories" | "model";

type Settings = {
  qoderEndpoint: string;
  defaultModel: string;
  gitlabToken: string;
  gitlabHost: string;
  jiraHost: string;
  jiraEmail: string;
  jiraToken: string;
  confluenceHost: string;
  confluenceEmail: string;
  confluenceToken: string;
};

const defaults: Settings = {
  qoderEndpoint: "https://qoder.dev",
  defaultModel: "claude-sonnet-4.5",
  gitlabToken: "",
  gitlabHost: "",
  jiraHost: "",
  jiraEmail: "",
  jiraToken: "",
  confluenceHost: "",
  confluenceEmail: "",
  confluenceToken: ""
};

export function SettingsDialog({ open, onOpenChange, qoder, onRepositoriesChanged }: { open: boolean; onOpenChange(open: boolean): void; qoder?: QoderStatus; onRepositoriesChanged(): void }) {
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<Settings>(defaults);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<number>();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content settings-dialog">
          <Dialog.Title>设置</Dialog.Title>
          <Dialog.Description>配置 Qoder / GitLab / Atlassian / 模型 / 仓库。</Dialog.Description>
          <nav className="settings-tabs">
            <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>通用</button>
            <button className={tab === "atlassian" ? "active" : ""} onClick={() => setTab("atlassian")}>Atlassian</button>
            <button className={tab === "repositories" ? "active" : ""} onClick={() => setTab("repositories")}>仓库</button>
            <button className={tab === "model" ? "active" : ""} onClick={() => setTab("model")}>模型</button>
          </nav>
          <div className="settings-body">
            {tab === "general" && (
              <div className="dialog-form">
                <label>Qoder Endpoint<input value={settings.qoderEndpoint} onChange={(event) => setSettings({ ...settings, qoderEndpoint: event.target.value })} /></label>
                <label>GitLab Host<input value={settings.gitlabHost} onChange={(event) => setSettings({ ...settings, gitlabHost: event.target.value })} placeholder="gitlab.example.com" /></label>
                <label>GitLab Token（环境变量名，保存到 keystore 引用）<input value={settings.gitlabToken} onChange={(event) => setSettings({ ...settings, gitlabToken: event.target.value })} placeholder="GITLAB_TOKEN" /></label>
                {qoder && <p className="qoder-hint">当前 Qoder 状态：{qoder.connected ? "已连接" : "未连接"}，档位 {qoder.account?.subscriptionType ?? "未知"}</p>}
              </div>
            )}
            {tab === "atlassian" && (
              <div className="dialog-form">
                <label>Jira Host<input value={settings.jiraHost} onChange={(event) => setSettings({ ...settings, jiraHost: event.target.value })} /></label>
                <label>Jira Email<input value={settings.jiraEmail} onChange={(event) => setSettings({ ...settings, jiraEmail: event.target.value })} /></label>
                <label>Jira Token<input value={settings.jiraToken} onChange={(event) => setSettings({ ...settings, jiraToken: event.target.value })} /></label>
                <TestButton kind="jira" label="测试 Jira 连接" />
                <label>Confluence Host<input value={settings.confluenceHost} onChange={(event) => setSettings({ ...settings, confluenceHost: event.target.value })} /></label>
                <label>Confluence Email<input value={settings.confluenceEmail} onChange={(event) => setSettings({ ...settings, confluenceEmail: event.target.value })} /></label>
                <label>Confluence Token<input value={settings.confluenceToken} onChange={(event) => setSettings({ ...settings, confluenceToken: event.target.value })} /></label>
                <TestButton kind="confluence" label="测试 Confluence 连接" />
              </div>
            )}
            {tab === "repositories" && (
              <div className="dialog-form">
                <p>仓库在「编码 → 详情 → 关联仓库」或下方按钮中维护。</p>
                <button className="primary" onClick={() => onRepositoriesChanged()}><Plug size={14} />刷新仓库列表</button>
              </div>
            )}
            {tab === "model" && (
              <div className="dialog-form">
                <label>默认模型 (Qoder)<input value={settings.defaultModel} onChange={(event) => setSettings({ ...settings, defaultModel: event.target.value })} /></label>
                {qoder?.models.length ? (
                  <ul className="model-list">
                    {qoder.models.map((model) => <li key={model.value}><b>{model.displayName}</b><span>{model.description}</span></li>)}
                  </ul>
                ) : <p>未发现 Qoder 模型，请先在通用页配置 Qoder。</p>}
              </div>
            )}
          </div>
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="secondary">关闭</button></Dialog.Close>
            <button className="primary" disabled={saving} onClick={async () => {
              setSaving(true);
              try {
                for (const [key, value] of Object.entries(settings)) {
                  await api.setSetting(key, value);
                }
                setSaved(Date.now());
              } finally { setSaving(false); }
            }}><Save size={14} />{saving ? "保存中…" : "保存设置"}</button>
            {saved && <small className="saved-hint">已保存</small>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
