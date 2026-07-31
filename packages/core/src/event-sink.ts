import type { AgentEvent } from "./types.js";

/**
 * 任务事件写入与变更通知的宿主无关抽象。
 *
 * - desktop 端:包 `addTaskEvent`(内部调 `store.addEvent` + `emitTaskChanged`),
 *   同时把事件通过 IPC 推给渲染进程,前端实时刷新。
 * - pi 端:包 `store.addEvent`,`emitChanged` 留空(Pi Extension 没有 IPC,
 *   timeline 状态依赖下次拉取或下一次 `session_start`)。
 *
 * 业务编排模块(review / delivery / merge-status)只依赖这个接口,
 * 不直接 import `TaskStore`,便于在两个宿主之间复用同一份实现。
 */
export interface TaskEventSink {
  /** 写入一条任务事件,返回持久化后的事件(含 id / createdAt)。 */
  addEvent(input: Omit<AgentEvent, "id" | "createdAt">): AgentEvent;
  /** 通知宿主"任务已变化",便于 UI 重新拉取。无 IPC 的宿主可留空。 */
  emitChanged(taskId: string): void;
}
