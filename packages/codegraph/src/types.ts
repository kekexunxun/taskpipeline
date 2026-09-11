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

/**
 * codegraph CLI 子进程运行时。
 *
 * codegraph CLI 是一个独立的 Node.js 程序，默认通过宿主 `npx` 调用；
 * 打包后的桌面应用不能依赖用户机器的 PATH / Node 安装，因此由应用侧
 * 解析出一份自带资源（Electron 以 ELECTRON_RUN_AS_NODE 充当 Node 运行时）
 * 后注入这里。未提供时回落到 `npx -y @optave/codegraph`。
 */
export interface CodegraphCliRuntime {
  /** 可执行文件绝对路径（如 process.execPath） */
  command: string
  /** 置于 codegraph 参数之前的前缀（如 [shim 路径]） */
  argsPrefix?: string[]
  /** 追加到子进程环境变量的键值（如 ELECTRON_RUN_AS_NODE） */
  env?: Record<string, string>
}

/** CodegraphManager 构造选项 */
export interface CodegraphManagerOptions {
  /** 数据根目录（索引存放在 dataDir/codegraph/） */
  dataDir: string
  /** 解析引擎，默认 'wasm'（Electron 环境安全） */
  engine?: 'native' | 'wasm'
  /** CLI 子进程运行时；缺省表示用宿主 npx */
  cli?: CodegraphCliRuntime
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
