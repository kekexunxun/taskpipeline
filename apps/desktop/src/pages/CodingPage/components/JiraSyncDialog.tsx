import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, RefreshCw } from "lucide-react";
import { api, type JiraTaskCandidate } from "../../../api";

export function JiraSyncDialog({ open, onOpenChange, onImported }: { open: boolean; onOpenChange(open: boolean): void; onImported(): void }) {
  const [candidates, setCandidates] = useState<JiraTaskCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setBusy(true); setError(undefined);
    api.syncJiraTasks().then((items) => {
      setCandidates(items);
      setSelected(new Set(items.map((item) => item.jiraKey)));
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content jira-sync-dialog">
          <Dialog.Title>同步 Jira 任务</Dialog.Title>
          <Dialog.Description>勾选需要导入的任务，未勾选任务将在关闭后丢弃。</Dialog.Description>
          {busy && <div className="loading-row"><Loader2 className="spinning" size={14} />正在拉取 Jira…</div>}
          {error && <div className="error-row">{error}</div>}
          {!busy && !error && (
            <ul className="jira-candidates">
              {candidates.length === 0 && <li className="empty">没有待导入任务</li>}
              {candidates.map((item) => (
                <li key={item.jiraKey}>
                  <label>
                    <input type="checkbox" checked={selected.has(item.jiraKey)} onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(item.jiraKey); else next.delete(item.jiraKey);
                      setSelected(next);
                    }} />
                    <span>
                      <b>{item.jiraKey}</b>
                      <span>{item.title}</span>
                      {item.keywords.length > 0 && <small>{item.keywords.join(" · ")}</small>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="secondary">取消</button></Dialog.Close>
            <button className="primary" disabled={busy || selected.size === 0} onClick={async () => {
              setBusy(true);
              try {
                const items = candidates.filter((item) => selected.has(item.jiraKey));
                if (items.length) {
                  await api.importJiraTasks(items);
                  onImported();
                }
                onOpenChange(false);
              } finally { setBusy(false); }
            }}><RefreshCw size={14} />导入 {selected.size} 项</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
