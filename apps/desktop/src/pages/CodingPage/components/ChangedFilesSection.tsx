import { FileDiff, GitBranch } from "lucide-react";
import { changeStatusLabel } from "../../../utils/status";
import type { ChangedFile } from "../../../api";

export function ChangedFilesSection({ groups, total }: { groups: Array<{ repositoryId: string; repositoryName: string; files: ChangedFile[] }>; total: number }) {
  return (
    <section className="files-section">
      <div className="section-title">
        <span><FileDiff size={13} />变化文件</span>
        <small>{total}</small>
      </div>
      {groups.length ? (
        <div className="repository-file-groups">
          {groups.map((group) => (
            <div className="repository-file-group" key={group.repositoryId}>
              <div className="repository-file-head">
                <span><GitBranch size={11} />{group.repositoryName}</span>
                <small>{group.files.length}</small>
              </div>
              <div className="changed-files">
                {group.files.map((file) => (
                  <div className="changed-file" key={file.path}>
                    <span className={`change-status ${file.status.includes("D") ? "deleted" : file.status.includes("?") || file.status.includes("A") ? "added" : "modified"}`}>{changeStatusLabel(file.status)}</span>
                    <span className="change-path" title={file.path}>{file.path}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overview-empty">暂无文件变化</div>
      )}
    </section>
  );
}
