import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Link2, Loader2 } from "lucide-react";
import { api } from "../../../api";

export function JiraDialog({ open, onOpenChange, onImported }: { open: boolean; onOpenChange(open: boolean): void; onImported(): void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>从 Jira 导入</Dialog.Title>
          <Dialog.Description>支持 Jira Key（如 PAY-1842）或 Issue 浏览链接。</Dialog.Description>
          <div className="dialog-form">
            <label>Jira Key / URL<input value={key} onChange={(event) => setKey(event.target.value)} placeholder="PAY-1842 或 https://…" /></label>
          </div>
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="secondary">取消</button></Dialog.Close>
            <button className="primary" disabled={!key.trim() || busy} onClick={async () => {
              setBusy(true);
              try {
                await api.importJiraTask(key.trim());
                onImported();
                onOpenChange(false);
                setKey("");
              } finally { setBusy(false); }
            }}>{busy ? <Loader2 className="spinning" size={14} /> : <Link2 size={14} />}导入</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
