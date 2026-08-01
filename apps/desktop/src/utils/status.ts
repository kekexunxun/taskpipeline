import type { BoardColumn } from "@coding-agent/core";
import { InboxIcon, ActivityIcon, ShieldIcon, CheckCircle2Icon } from "lucide-react";

export const columns: Array<{ id: BoardColumn; title: string; icon: typeof InboxIcon }> = [
  { id: "todo", title: "Todo", icon: InboxIcon },
  { id: "in_progress", title: "InProgress", icon: ActivityIcon },
  { id: "in_review", title: "InReview", icon: ShieldIcon },
  { id: "done", title: "Done", icon: CheckCircle2Icon }
];

export const statusLabels: Record<string, string> = {
  draft: "待处理",
  confirmed: "已确认",
  preparing: "准备环境",
  implementing: "实现中",
  failed: "执行失败",
  awaiting_review: "等待 Review",
  reviewing: "Review 中",
  review_blocked: "Review 阻断",
  awaiting_commit: "等待提交 MR",
  delivering: "提交 MR 中",
  await_merge: "等待合并",
  completed: "已完成",
  cancelled: "已取消"
};

export const inReviewStates = new Set([
  "awaiting_review",
  "reviewing",
  "review_blocked",
  "awaiting_commit",
  "delivering",
  "await_merge"
]);

export function changeStatusLabel(status: string): string {
  if (status.includes("?")) return "新增";
  if (status.includes("R")) return "重命名";
  if (status.includes("C")) return "复制";
  if (status.includes("D")) return "删除";
  if (status.includes("A")) return "新增";
  return "修改";
}

export function localizedEventTitle(title: string): string {
  const match = title.match(/^状态更新为\s+(.+)$/);
  return match ? `状态更新为 ${statusLabels[match[1]!] ?? match[1]}` : title;
}
