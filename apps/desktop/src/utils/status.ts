import type { BoardColumn } from '@task-pipeline/core'
import { InboxIcon, ActivityIcon, ShieldIcon, CheckCircle2Icon } from 'lucide-react'

export const columns: Array<{ id: BoardColumn; title: string; icon: typeof InboxIcon }> = [
  { id: 'todo', title: 'Todo', icon: InboxIcon },
  { id: 'in_progress', title: 'InProgress', icon: ActivityIcon },
  { id: 'in_review', title: 'InReview', icon: ShieldIcon },
  { id: 'done', title: 'Done', icon: CheckCircle2Icon }
]

export const statusLabels: Record<string, string> = {
  draft: '待处理',
  confirmed: '已确认',
  preparing: '准备环境',
  planning: '计划中',
  awaiting_plan_approval: '等待计划确认',
  implementing: '实现中',
  paused: '已暂停',
  awaiting_input: '等待补充',
  validating: '校验中',
  validation_failed: '校验失败',
  failed: '执行失败',
  awaiting_review: '等待 Review',
  reviewing: 'Review 中',
  review_blocked: 'Review 阻断',
  awaiting_commit: '等待提交 MR',
  delivering: '提交 MR 中',
  await_merge: '等待合并',
  completed: '已完成',
  cancelled: '已取消'
}

export const inReviewStates = new Set([
  'awaiting_review',
  'reviewing',
  'review_blocked',
  'awaiting_commit',
  'delivering',
  'await_merge'
])

/** 文件变更状态 → 短标签（A/M/D/R/C）。 */
export function fileChangeLabel(status: string): string {
  if (status.includes('?')) return 'A'
  if (status.includes('R')) return 'R'
  if (status.includes('C')) return 'C'
  if (status.includes('D')) return 'D'
  if (status.includes('A')) return 'A'
  return 'M'
}

/** 文件变更状态 → 标签配色（bg + text）。 */
export function fileChangeTagColor(status: string): string {
  if (status.includes('?') || status.includes('A')) return 'bg-emerald-500/10 text-emerald-500'
  if (status.includes('D')) return 'bg-red-500/10 text-red-400'
  return 'bg-blue-500/10 text-blue-400'
}

/** 文件变更状态 → 图标配色。 */
export function fileChangeIconColor(status: string): string {
  if (status.includes('?') || status.includes('A')) return 'text-emerald-500'
  if (status.includes('D')) return 'text-red-400'
  return 'text-blue-400'
}

export function localizedEventTitle(title: string): string {
  const match = title.match(/^状态更新为\s+(.+)$/)
  return match ? `状态更新为 ${statusLabels[match[1]!] ?? match[1]}` : title
}
