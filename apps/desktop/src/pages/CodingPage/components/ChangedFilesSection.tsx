import { FileDiffIcon, GitBranchIcon } from "lucide-react";
import type { ChangedFile } from "@/api";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { changeStatusLabel } from "@/utils/status";

export function ChangedFilesSection({ groups, total }: { groups: Array<{ repositoryId: string; repositoryName: string; files: ChangedFile[] }>; total: number }) {
  return <section className="border-b px-5 py-3"><div className="mb-2 flex items-center justify-between text-xs font-semibold text-muted-foreground"><span className="flex items-center gap-1.5"><FileDiffIcon size={12} />变化文件</span><Badge variant="secondary">{total}</Badge></div>{groups.length ? <div className="space-y-2">{groups.map((group) => <div key={group.repositoryId}><div className="flex min-h-6 items-center justify-between border-b text-xs text-muted-foreground"><span className="flex min-w-0 items-center gap-1 truncate"><GitBranchIcon size={10} />{group.repositoryName}</span><small>{group.files.length}</small></div><div className="thin-scrollbar max-h-44 overflow-y-auto pt-1">{group.files.map((file) => { const added = file.status.includes("?") || file.status.includes("A"), deleted = file.status.includes("D"); return <div className="grid min-h-6 grid-cols-[38px_minmax(0,1fr)] items-center gap-1.5 text-xs" key={file.path}><span className={cn("text-amber-300", added && "text-emerald-400", deleted && "text-red-300")}>{changeStatusLabel(file.status)}</span><span className="truncate font-mono text-muted-foreground" title={file.path}>{file.path}</span></div>; })}</div></div>)}</div> : <div className="text-xs text-muted-foreground">暂无文件变化</div>}</section>;
}
