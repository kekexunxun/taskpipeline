import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Save } from "lucide-react";
import type { Task } from "@coding-agent/core";
import { api } from "../../../api";

export function TaskEditorDialog({ task, open, onOpenChange, onSaved }: { task: Task | undefined; open: boolean; onOpenChange(open: boolean): void; onSaved(): void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [keywords, setKeywords] = useState("");
  const [acceptance, setAcceptance] = useState("");
  useEffect(() => {
    if (open) {
      setTitle(task?.title ?? "");
      setDescription(task?.description ?? "");
      setKeywords(task?.keywords.join(", ") ?? "");
      setAcceptance(task?.acceptanceCriteria.join("\n") ?? "");
    }
  }, [open, task]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content task-editor-dialog">
          <Dialog.Title>编辑任务</Dialog.Title>
          <Dialog.Description>调整标题、描述、关键词与验收标准。</Dialog.Description>
          <div className="dialog-form">
            <label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label>描述<textarea value={description} rows={5} onChange={(event) => setDescription(event.target.value)} /></label>
            <label>关键词（逗号分隔）<input value={keywords} onChange={(event) => setKeywords(event.target.value)} /></label>
            <label>验收标准（每行一条）<textarea value={acceptance} rows={3} onChange={(event) => setAcceptance(event.target.value)} /></label>
          </div>
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="secondary">取消</button></Dialog.Close>
            <button className="primary" disabled={!title.trim() || !task} onClick={async () => {
              if (!task) return;
              await api.updateTask(task.id, {
                title: title.trim(),
                description,
                keywords: keywords.split(",").map((item) => item.trim()).filter(Boolean),
                acceptanceCriteria: acceptance.split("\n").map((item) => item.trim()).filter(Boolean)
              });
              onSaved();
              onOpenChange(false);
            }}><Save size={14} />保存</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
