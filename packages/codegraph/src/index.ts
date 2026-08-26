/**
 * @task-pipeline/codegraph — 代码图谱索引服务。
 *
 * 为 TaskPipeline 桌面端和 pi CLI 提供统一的代码图谱索引能力。
 * 基于 @optave/codegraph，通过 npx 子进程方式调用，避免依赖冲突。
 *
 * @example
 * ```typescript
 * import { CodegraphManager } from '@task-pipeline/codegraph'
 *
 * const manager = new CodegraphManager({ dataDir: '/path/to/data' })
 *
 * // 触发索引
 * await manager.ensureIndex('repo-123', '/path/to/repo')
 *
 * // 获取状态
 * const status = manager.getStatus('repo-123')
 *
 * // 生成 MCP 配置（供 Agent 注入）
 * const mcpConfig = manager.resolveMcpConfig('/path/to/repo')
 * ```
 */

export { CodegraphManager } from './codegraph-manager.js'
export { buildMcpArgs, runBuild, runStats } from './codegraph-cli.js'
export type { BuildResult, CodegraphManagerOptions, IndexStatus, McpServerConfig, RepoIndexMeta } from './types.js'
