import { GitBranch, GitMerge } from "lucide-react";
import type { TaskRepository } from "@coding-agent/core";
import { formatTime } from "../../../utils/format";

const stateLabel: Record<string, string> = { opened: "已打开", merged: "已合并", closed: "已关闭", unknown: "未检测" };

export function MergeRequestsSection({ repos, onOpen }: { repos: TaskRepository[]; onOpen(url: string): void }) {
  const withMr = repos.filter((repo) => repo.mergeRequestUrl);
  if (withMr.length === 0) return null;
  return (
    <section className="merge-requests-section">
      <div className="section-title">
        <span><GitMerge size={13} />Merge Requests</span>
        <small>{withMr.length}</small>
      </div>
      <div className="merge-request-list">
        {withMr.map((repo) => {
          const state = repo.mergeRequestState ?? "unknown";
          const stateClass = state === "merged" ? "merged" : state === "closed" ? "closed" : state === "opened" ? "opened" : "unknown";
          const checkedAt = repo.mergeRequestCheckedAt ? formatTime(repo.mergeRequestCheckedAt) : "尚未检测";
          return (
            <div className={`merge-request-row ${stateClass}`} key={repo.id}>
              <span className="repo-name"><GitBranch size={11} />{repo.name}</span>
              <span className={`mr-state ${stateClass}`}>{stateLabel[state]}</span>
              <button className="mr-link" type="button" onClick={() => repo.mergeRequestUrl && onOpen(repo.mergeRequestUrl)} title={repo.mergeRequestUrl ?? ""}>!{repo.mergeRequestIid}</button>
              <small className="mr-checked">检查于 {checkedAt}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}
