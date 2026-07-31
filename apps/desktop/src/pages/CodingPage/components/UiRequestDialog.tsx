import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { api } from "../../../api";

type UiRequest = {
  requestId: string;
  method: "confirm" | "select" | "input" | "editor";
  prompt?: string;
  options?: Array<{ value: string; label: string }>;
};

export function UiRequestDialog() {
  const [req, setReq] = useState<UiRequest | undefined>();
  useEffect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<UiRequest>).detail;
      setReq(detail);
    };
    window.addEventListener("task:ui-request", onAsk as EventListener);
    return () => window.removeEventListener("task:ui-request", onAsk as EventListener);
  }, []);
  if (!req) return null;
  return (
    <Dialog.Root open={Boolean(req)} onOpenChange={(open) => { if (!open) setReq(undefined); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content ui-request-dialog">
          <Dialog.Title>{req.prompt ?? "执行器请求"}</Dialog.Title>
          <Dialog.Description>方法：{req.method}</Dialog.Description>
          {req.method === "confirm" && (
            <div className="dialog-actions">
              <button className="secondary" onClick={async () => { await api.respondTaskUi({ requestId: req.requestId, ok: false }); setReq(undefined); }}>拒绝</button>
              <button className="primary" onClick={async () => { await api.respondTaskUi({ requestId: req.requestId, ok: true }); setReq(undefined); }}>允许</button>
            </div>
          )}
          {req.method === "select" && (
            <div className="ui-options">
              {req.options?.map((opt) => <button key={opt.value} className="secondary" onClick={async () => { await api.respondTaskUi({ requestId: req.requestId, value: opt.value }); setReq(undefined); }}>{opt.label}</button>)}
            </div>
          )}
          {req.method === "input" && (
            <InputRequest onSubmit={async (value) => { await api.respondTaskUi({ requestId: req.requestId, value }); setReq(undefined); }} />
          )}
          {req.method === "editor" && (
            <div className="ui-options">
              <button className="secondary" onClick={async () => { await api.respondTaskUi({ requestId: req.requestId, editor: "vscode" }); setReq(undefined); }}>VS Code</button>
              <button className="secondary" onClick={async () => { await api.respondTaskUi({ requestId: req.requestId, editor: "qoder" }); setReq(undefined); }}>Qoder</button>
            </div>
          )}
          <Dialog.Close asChild><button className="icon-button dialog-close" title="关闭"><X size={15} /></button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InputRequest({ onSubmit }: { onSubmit(value: string): void }) {
  const [value, setValue] = useState("");
  return (
    <div className="ui-input">
      <input value={value} onChange={(event) => setValue(event.target.value)} />
      <button className="primary" onClick={() => onSubmit(value)}>确认</button>
    </div>
  );
}
