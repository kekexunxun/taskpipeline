/**
 * Plan 阶段 JSON 解析 — 从 `main.ts` 迁出。
 *
 * 复用 `plan-content.ts` 的 `parsePlanDecision`,driver 不直接 import,
 * 通过调用方把 resultText 传进来。
 */
export { parsePlanDecision } from "../../plan-content.js";
