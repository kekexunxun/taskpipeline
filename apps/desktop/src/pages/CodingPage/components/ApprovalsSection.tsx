import { CheckCircle2Icon, ClockIcon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { Approval } from "@task-pipeline/core";
import { Badge } from "@/components/ui/badge";
import { formatTime } from "@/utils/format";

const kindLabels: Record<Approval["kind"], string> = {
  plan: "计划",
  review: "Review",
  commit: "提交代码",
  push: "推送分支",
  merge_request: "创建 MR",
  jira_writeback: "Jira 回写",
  permission: "工具权限"
};
const statusBadge: Record<Approval["status"], { label: string; variant: "default" | "success" | "destructive" | "outline" | "secondary" | "warning" }> = {
  pending: { label: "待确认", variant: "warning" },
  approved: { label: "已批准", variant: "success" },
  rejected: { label: "已拒绝", variant: "destructive" }
};

/** 审批记录（Approval 表）：计划 / commit / push / MR 等人工确认点的审计历史。 */
export function ApprovalsSection({ approvals }: { approvals: Approval[] }) {
  if (!approvals.length) return null;
  return (
    <section className="border-b px-5 py-3">
      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <ShieldCheckIcon size={12} />审批记录
        </span>
        <Badge variant="secondary">{approvals.length}</Badge>
      </div>
      <div className="space-y-1">
        {approvals.map((approval) => {
          const badge = statusBadge[approval.status];
          const Icon = approval.status === "approved" ? CheckCircle2Icon : approval.status === "rejected" ? XCircleIcon : ClockIcon;
          return (
            <div className="grid min-h-8 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded border px-2 py-1 text-xs" key={approval.id}>
              <Icon size={11} className={approval.status === "rejected" ? "text-red-400" : approval.status === "approved" ? "text-emerald-500" : "text-amber-500"} />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">{kindLabels[approval.kind]}</span>
                  <time className="text-[10px] text-muted-foreground">{formatTime(approval.resolvedAt ?? approval.createdAt)}</time>
                </div>
                {approval.context && <p className="truncate text-[11px] text-muted-foreground" title={approval.context}>{approval.context}</p>}
              </div>
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </div>
          );
        })}
      </div>
    </section>
  );
}
