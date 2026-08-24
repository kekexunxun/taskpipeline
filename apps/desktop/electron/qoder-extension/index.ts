/**
 * Qoder Extension — Qoder SDK 完整接入的集中入口。
 *
 * 将原先散落在 electron/qoder/、electron/task-agent/、electron/chat/drivers/、
 * electron/trace/instrument/ 中的 Qoder 相关代码收拢到同一目录。
 *
 * 运行时行为不变：extension 跑在 Electron 主进程同一 Node.js 进程中，
 * SDK 的 query() / onMessage / canUseTool / permissionHooks 等进程内 API 直接可用。
 */

// ── 会话引擎 ────────────────────────────────────────────────
export { QoderSession, QoderSessionRegistry } from './qoder-session.js'

// ── Task Agent Driver ───────────────────────────────────────
export { QoderTaskAgentDriver, stripQoderModelPrefix } from './qoder-task-agent.js'
export type { QoderTaskAgentDeps } from './qoder-task-agent.js'

// ── Chat Driver ─────────────────────────────────────────────
export { QoderChatDriver } from './qoder-chat-driver.js'
export type { QoderToolPermissionHandler, QoderToolPermissionHandlerResult } from './qoder-chat-driver.js'

// ── Plan Mode Provider ──────────────────────────────────────
export { QoderPlanModeProvider } from './qoder-plan-mode.js'

// ── Trace Builder ───────────────────────────────────────────
export { QoderTraceBuilder } from './trace-builder.js'

// ── 日志 / 消息记录 ─────────────────────────────────────────
export { logQoderMessage, qoderLogFile, recordQoderMessage, closeQoderQuerySafely } from './log.js'

// ── 编排器 ──────────────────────────────────────────────────
export { QoderOrchestrator } from './qoder-orchestrator.js'
export type { QoderStatus, TestCaseGenerationResult, QoderOrchestratorDeps } from './qoder-orchestrator.js'
