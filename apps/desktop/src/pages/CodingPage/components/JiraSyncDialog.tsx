import { useEffect, useState } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { api, type JiraTaskCandidate } from "@/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

export function JiraSyncDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onImported(): void;
}) {
  const [candidates, setCandidates] = useState<JiraTaskCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setBusy(true);
    setError(undefined);
    api
      .syncJiraTasks()
      .then((items) => {
        setCandidates(items);
        setSelected(new Set(items.map((item) => item.taskKey)));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(640px,calc(100vw-48px))]">
        <DialogHeader>
          <DialogTitle>同步 Jira 任务</DialogTitle>
          <DialogDescription>勾选需要导入的任务。</DialogDescription>
        </DialogHeader>
        <div className="thin-scrollbar min-h-48 max-h-[55vh] overflow-y-auto px-1">
          {busy && (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
              <Loader2Icon className="animate-spin-slow" size={13} />
              正在拉取 Jira
            </div>
          )}
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">
              {error}
            </div>
          )}
          {!busy && !error && (
            <ul className="space-y-1">
              {!candidates.length && (
                <li className="py-12 text-center text-xs text-muted-foreground">没有待导入任务</li>
              )}
              {candidates.map((item) => (
                <li key={item.taskKey}>
                  <label className="flex items-start gap-2.5 rounded-md border p-2.5 hover:bg-accent/40">
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.has(item.taskKey)}
                      onCheckedChange={(value) => {
                        const next = new Set(selected);
                        if (value === true) next.add(item.taskKey);
                        else next.delete(item.taskKey);
                        setSelected(next);
                      }}
                    />
                    <span className="min-w-0">
                      <b className="block font-mono text-xs text-muted-foreground">{item.taskKey}</b>
                      <span className="block truncate text-xs">{item.title}</span>
                      {item.keywords.length > 0 && (
                        <small className="text-xs text-muted-foreground">
                          {item.keywords.join(" · ")}
                        </small>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              取消
            </Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={async () => {
              setBusy(true);
              try {
                const items = candidates.filter((item) => selected.has(item.taskKey));
                if (items.length) {
                  await api.importJiraTasks(items);
                  onImported();
                }
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCwIcon size={11} />
            导入 {selected.size} 项
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
