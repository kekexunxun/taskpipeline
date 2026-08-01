import { ExternalLinkIcon, GitBranchIcon, GitMergeIcon } from "lucide-react";
import type { TaskRepository } from "@coding-agent/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/utils/format";
const stateLabel: Record<string, string> = { opened: "已打开", merged: "已合并", closed: "已关闭", unknown: "未检测" };
export function MergeRequestsSection({ repos, onOpen }: { repos: TaskRepository[]; onOpen(url: string): void }) {
  const withMr = repos.filter((repo) => repo.mergeRequestUrl); if (!withMr.length) return null;
  return <section className="border-b px-5 py-3"><div className="mb-2 flex items-center justify-between text-xs font-semibold text-muted-foreground"><span className="flex items-center gap-1.5"><GitMergeIcon size={12} />Merge Requests</span><Badge variant="secondary">{withMr.length}</Badge></div><div className="space-y-1">{withMr.map((repo) => { const state = repo.mergeRequestState ?? "unknown"; return <div className="grid min-h-8 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded border px-2 text-xs" key={repo.id}><span className="flex min-w-0 items-center gap-1 truncate"><GitBranchIcon size={10} />{repo.name}</span><Badge variant={state === "merged" ? "success" : state === "closed" ? "destructive" : state === "opened" ? "default" : "outline"}>{stateLabel[state]}</Badge><Button variant="ghost" size="icon-sm" aria-label={`打开 MR ${repo.mergeRequestIid}`} onClick={() => repo.mergeRequestUrl && onOpen(repo.mergeRequestUrl)} title={`检查于 ${repo.mergeRequestCheckedAt ? formatTime(repo.mergeRequestCheckedAt) : "尚未检测"}`}><ExternalLinkIcon size={11} /></Button></div>; })}</div></section>;
}
