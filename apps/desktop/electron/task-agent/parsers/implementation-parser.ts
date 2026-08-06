/**
 * Implementation 阶段结果解析 — 从 `main.ts` 迁出。
 *
 * 复用 `task-readiness.ts` 的 `parseImplementationDecision` + `nextStepForImplementation`,
 * driver 不直接 import,调用方负责把 responseTexts 传进来。
 */
export { parseImplementationDecision, nextStepForImplementation } from "../../task-readiness.js";
