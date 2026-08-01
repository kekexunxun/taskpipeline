import { CheckIcon, GitBranchIcon } from "lucide-react";
import type { RepositoryProfile, TaskRepository } from "@coding-agent/core";
import { cn } from "@/lib/utils";

export function mergeRepositoryOptions(profiles: RepositoryProfile[], attached: TaskRepository[]): RepositoryProfile[] {
  const result = [...profiles];
  const knownIds = new Set(profiles.map((profile) => profile.id));
  for (const repo of attached) {
    if (knownIds.has(repo.repositoryId)) continue;
    result.push({
      id: repo.repositoryId,
      name: repo.name,
      localPath: repo.localPath,
      defaultBranch: repo.baseBranch,
      setupCommand: repo.setupCommand,
      lintCommand: repo.lintCommand,
      testCommand: repo.testCommand,
      buildCommand: repo.buildCommand
    });
    knownIds.add(repo.repositoryId);
  }
  return result;
}

export function RepositoryPicker({ repositories, selectedIds, loading, onToggle }: { repositories: RepositoryProfile[]; selectedIds: Set<string>; loading?: boolean; onToggle(id: string, selected: boolean): void }) {
  if (!loading && repositories.length === 0) return <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">还没有可关联的仓库。请到设置 → 仓库中添加。</div>;
  return <div className="thin-scrollbar max-h-44 space-y-1.5 overflow-y-auto rounded-md border bg-card/60 p-1.5">
    {repositories.map((repo) => {
      const checked = selectedIds.has(repo.id);
      return <button type="button" key={repo.id} onClick={() => onToggle(repo.id, !checked)} className={cn("flex w-full items-start gap-2 rounded-md border bg-card p-2 text-left transition-colors hover:border-border hover:bg-accent/40", checked && "border-ring bg-accent/70")}>
        <span className={cn("mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-[3px] border", checked ? "border-foreground bg-foreground text-background" : "border-border bg-background")}>{checked && <CheckIcon size={9} strokeWidth={3} />}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-foreground">{repo.name}</span><span className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground"><GitBranchIcon size={9} className="shrink-0" />{repo.defaultBranch || "main"}</span></span>
      </button>;
    })}
  </div>;
}
