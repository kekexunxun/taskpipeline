import { X } from "lucide-react";
import type { Task } from "@coding-agent/core";
import { EditorLauncher } from "./EditorLauncher";

export function DetailHeader({ task, onClose, onOpenVSCode, onOpenQoder }: { task: Task; onClose(): void; onOpenVSCode(): void; onOpenQoder(): void }) {
  return (
    <div className="detail-head">
      <div>
        <span className="jira-key">{task.jiraKey ?? "LOCAL"}</span>
        <h2>{task.title}</h2>
        <p>{task.summary ?? task.description}</p>
      </div>
      <button className="icon-button detail-close" title="关闭详情" onClick={onClose}><X size={17} /></button>
      <EditorLauncher onLaunchVSCode={onOpenVSCode} onLaunchQoder={onOpenQoder} />
    </div>
  );
}
