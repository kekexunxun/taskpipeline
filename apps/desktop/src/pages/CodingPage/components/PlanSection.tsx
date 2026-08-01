import { useEffect, useRef, useState } from "react";
import type { Task } from "@coding-agent/core";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageResponse } from "@/components/ai-elements/message";

export function PlanSection({ task, running, onApprove, onRevise }: { task: Task; running: boolean; onApprove(): void; onRevise(feedback: string): void }) {
  const [feedback, setFeedback] = useState("");
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (task.state === "awaiting_plan_approval") sectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [task.planRevision, task.state]);
  if (!task.planContent && !["planning", "awaiting_plan_approval"].includes(task.state)) return null;
  return <section ref={sectionRef} className="space-y-2 border-b px-5 py-3">
    <div className="flex items-center justify-between text-xs font-semibold"><span>实施计划</span><span className="text-muted-foreground">第 {task.planRevision ?? 0} 版</span></div>
    {task.planContent ? <div className="max-h-64 overflow-y-auto rounded-md border bg-background p-3 text-xs leading-5"><MessageResponse>{task.planContent}</MessageResponse></div> : <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">正在生成计划</div>}
    {task.state === "awaiting_plan_approval" && <>
      <Textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="填写计划调整意见" />
      <div className="flex justify-end gap-2"><Button variant="secondary" disabled={running || !feedback.trim()} onClick={() => onRevise(feedback.trim())}>重新生成</Button><Button disabled={running} onClick={onApprove}>批准并开始</Button></div>
    </>}
  </section>;
}
