import { useEffect, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/**
 * Phase 3 HITL：计划直接编辑对话框。
 * 在 awaiting_plan_approval 阶段允许用户直接修改 planContent（替代"只能反馈文本重新生成"），
 * 保存后回到计划确认区，再点「批准并开始」执行。
 */
export function EditPlanDialog({
  open,
  taskId,
  initialContent,
  onOpenChange,
  onSaved
}: {
  open: boolean;
  taskId?: string;
  initialContent: string;
  onOpenChange(open: boolean): void;
  onSaved(): void;
}) {
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setContent(initialContent);
  }, [open, initialContent]);
  const save = async () => {
    if (!taskId || !content.trim()) return;
    setSaving(true);
    try {
      await api.updateTaskPlan(taskId, content.trim());
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onOpenChange(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑实施计划</DialogTitle>
          <DialogDescription>修改后将保存为新的计划版本（第 {content.trim() ? "" : ""}版由系统递增），可随后批准执行。</DialogDescription>
        </DialogHeader>
        <Textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className="min-h-[40vh] max-h-[60vh] resize-y font-mono text-xs"
          placeholder="在此编辑计划内容（Markdown）"
        />
        <DialogFooter>
          <Button variant="secondary" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={saving || !content.trim()} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
