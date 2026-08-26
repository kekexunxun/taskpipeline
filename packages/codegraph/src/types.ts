/**
 * CodeGraph 索引服务类型定义。
 */

/** 索引状态 */
export type IndexStatus = 'idle' | 'indexing' | 'error' | 'not_indexed'

/** 仓库索引元数据 */
export interface RepoIndexMeta {
  repositoryId: string
  localPath: string
  /** ISO 时间戳，上次成功索引时间 */
  lastIndexedAt?: string
  /** 当前索引状态 */
  status: IndexStatus
  /** 使用的解析引擎 */
  engine: 'native' | 'wasm'
  /** 索引的文件数 */
  fileCount?: number
  /** 图谱节点数 */
  nodeCount?: number
  /** 图谱边数 */
  edgeCount?: number
  /** 错误信息（status === 'error' 时） */
  error?: string
}

/** CodegraphManager 构造选项 */
export interface CodegraphManagerOptions {
  /** 数据根目录（索引存放在 dataDir/codegraph/） */
  dataDir: string
  /** 解析引擎，默认 'wasm'（Electron 环境安全） */
  engine?: 'native' | 'wasm'
}

/** codegraph build 命令结果 */
export interface BuildResult {
  fileCount: number
  nodeCount: number
  edgeCount: number
  duration: number
}

/** MCP Server 配置（供 SDK mcpServers 注入） */
export interface McpServerConfig {
  type: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
}
