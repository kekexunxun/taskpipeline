import type { TaskState } from "./types.js";
import { TASK_STATES } from "./types.js";

const transitions: Record<TaskState, TaskState[]> = {
  draft: ["confirmed", "cancelled"], confirmed: ["preparing", "cancelled"], preparing: ["planning", "implementing", "failed", "cancelled"],
  planning: ["awaiting_plan_approval", "completed", "failed", "cancelled"],
  awaiting_plan_approval: ["planning", "implementing", "failed", "cancelled"],
  implementing: ["awaiting_input", "generating_tests", "validating", "awaiting_review", "failed", "cancelled"],
  awaiting_input: ["implementing", "completed", "failed", "cancelled"],
  // generating_tests 是新引入的中间态：实现完成后、validation/review 之前。
  // 允许退到 validating（正常路径）/ implementing（重做）/ failed（生成失败）。
  generating_tests: ["validating", "implementing", "failed", "cancelled"],
  validating: ["awaiting_review", "validation_failed", "failed", "cancelled"],
  validation_failed: ["validating", "implementing", "cancelled"],
  awaiting_review: ["reviewing", "awaiting_commit", "implementing", "completed", "cancelled"], reviewing: ["review_blocked", "awaiting_commit", "implementing", "completed", "failed"],
  review_blocked: ["reviewing", "implementing", "awaiting_commit", "completed", "cancelled"], awaiting_commit: ["delivering", "implementing", "completed", "cancelled"],
  // delivering 允许退到 awaiting_commit: commit/push/MR 中途失败、进程崩溃或 hook 卡死时,
  // 用户可以一键重置并重新提交,不必被迫进入 failed 再重跑实现。
  delivering: ["await_merge", "failed", "awaiting_commit"],
  await_merge: ["implementing", "completed"],
  completed: ["preparing"], failed: ["preparing", "planning", "implementing", "validating", "cancelled"], cancelled: []
};

export function transitionTask(from: TaskState, to: TaskState): void {
  if (!TASK_STATES.includes(to) || !transitions[from].includes(to)) throw new Error(`Invalid task transition: ${from} -> ${to}`);
}

export function transitionTaskSafely(from: TaskState, to: TaskState): TaskState { transitionTask(from, to); return to; }

// 状态机辅助纯函数:用于业务编排模块的入口校验和按钮可见性判断,
// 仅描述"哪些状态可以做这件事",不涉及具体转移。状态转移合法性仍由 transitionTask 决定。
const REVIEWABLE_STATES: TaskState[] = ["implementing", "awaiting_review", "review_blocked"];
const DELIVERABLE_STATES: TaskState[] = ["awaiting_commit"];
const MERGE_TRACKABLE_STATES: TaskState[] = ["await_merge"];

export function isReviewable(state: TaskState): boolean { return REVIEWABLE_STATES.includes(state); }
export function isDeliverable(state: TaskState): boolean { return DELIVERABLE_STATES.includes(state); }
export function isMergeTrackable(state: TaskState): boolean { return MERGE_TRACKABLE_STATES.includes(state); }

/**
 * 根据用户在设置里配置的 `reviewBlockingLevel` 决定哪些 severity 视为"阻断问题"。
 *
 * - critical:仅 critical
 * - high(默认):critical + high + error
 * - medium:critical + high + error + medium
 */
export function blockingSeveritiesFor(level: "critical" | "high" | "medium" | undefined): string[] {
  if (level === "critical") return ["critical"];
  if (level === "medium") return ["critical", "high", "error", "medium"];
  return ["critical", "high", "error"];
}
