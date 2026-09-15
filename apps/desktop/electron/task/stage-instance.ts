/**
 * 阶段实例标识（P1/P3 共用）。
 *
 * 放在 `task/` 而不是 `pi-extension/qoder/`：一条铁律「会话绑阶段实例，不绑任务」
 * 与运行时无关，Qoder 与 Pi 必须用同一套 id 与阶段名，否则 Trace / 产物目录会分叉。
 */

import type { TaskAgentPhase } from '../agents/task-agent/task-agent-driver.js'

/**
 * 阶段实例的归属阶段。
 *
 * `test_generation` 自 P2 起是独立实例（Exec → Test 也走 fork，输入是 `exec.summary.md`），
 * 不再蹭 implementation 的会话 —— 蹭着的后果是测试阶段继承了整段实现推理，
 * 而它真正需要的是「改了哪些文件 + 怎么验」。
 */
export type StagePhase = 'planning' | 'implementation' | 'test'

export function stagePhaseOf(phase: TaskAgentPhase): StagePhase {
  if (phase === 'planning') return 'planning'
  return phase === 'test_generation' ? 'test' : 'implementation'
}

/** 一次阶段执行 = 一个阶段实例；会话绑阶段实例，不绑任务。 */
export function stageInstanceId(taskId: string, phase: StagePhase, seq: number): string {
  return `${taskId}:${phase}:${seq}`
}

/** 阶段实例 id 是否属于某个任务（`stageInstanceId` 以 `${taskId}:` 开头，taskId 不含冒号）。 */
export function stageIdOfTask(stageId: string, taskId: string): boolean {
  return stageId.startsWith(`${taskId}:`)
}

/** 从阶段实例 id 取 taskId（id 形如 `task-1:implementation:2`）。 */
export function taskIdOfStage(stageId: string): string {
  return stageId.split(':')[0] ?? ''
}
