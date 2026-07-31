import { CircleDot, GitBranch, Pencil, Shield, Trash2 } from "lucide-react";
import type { TaskCard } from "@coding-agent/core";
import { statusLabels } from "../../../utils/status";

export function TaskCardView({ task, active, onOpen, onEdit, onRemove }: { task: TaskCard; active: boolean; onOpen(): void; onEdit?(): void; onRemove?(): void }) {
  return (
    <article className={`task-card ${active ? "active" : ""}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}>
      <div className="card-top">
        <span className="jira-key">{task.jiraKey ?? "LOCAL"}</span>
        <span className={`state-dot ${task.state}`}><CircleDot size={11} />{statusLabels[task.state]}</span>
      </div>
      <strong>{task.title}</strong>
      {task.keywords.length > 0 && <div className="keyword-row">{task.keywords.slice(0, 3).map((item) => <span key={item}>{item}</span>)}</div>}
      {task.repositories.map((repo) => <div className="repo-line" key={repo.id}><span><GitBranch size={12} />{repo.name}</span><small>{repo.deliveryStatus === "mr_created" ? "MR 已提交" : repo.changeSummary ?? "等待修改"}</small></div>)}
      <div className="card-footer">
        <span><Shield size={12} />{task.reviewStatus === "passed" ? "Review 通过" : task.reviewStatus === "blocked" ? "Review 阻断" : "待 Review"}</span>
        <span className="card-commands">
          {onEdit && <button className="card-icon" title="编辑任务" onClick={(event) => { event.stopPropagation(); onEdit(); }}><Pencil size={13} /></button>}
          {onRemove && <button className="card-icon" title="移除任务" onClick={(event) => { event.stopPropagation(); onRemove(); }}><Trash2 size={13} /></button>}
        </span>
      </div>
    </article>
  );
}
