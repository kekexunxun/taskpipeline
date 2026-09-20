/**
 * @task-pipeline/codeindex — mini-Atlas 源码索引引擎（public API）
 *
 * 索引核心与运行时服务不依赖 Electron；数据库位置和连接创建策略由宿主注入。
 * FileSystem、ParserBackend、watcher 工厂可替换；chokidar 适配器从 /node-watcher 单独导入。
 */

// 类型
export type {
  ASTNode,
  EdgeKind,
  ExtractedSymbol,
  ExtractInput,
  Extractor,
  ExtractResult,
  FileRecord,
  FileSystem,
  FileStat,
  ImportInfo,
  IndexedFileResult,
  IndexProgress,
  IndexResult,
  IndexStats,
  IndexWatcher,
  IndexWatcherFactory,
  IndexWatcherOptions,
  Language,
  Neighbor,
  ParserBackend,
  ParsedTree,
  SearchHit,
  SearchOptions,
  SymbolKind
} from './types.js'

// 解析后端
export { WebTreeSitterBackend } from './backend/web-tree-sitter.js'
export type { WebTreeSitterBackendOptions } from './backend/web-tree-sitter.js'
export {
  SUPPORTED_EXTENSIONS,
  grammarForLanguage,
  grammarForVueScript,
  grammarsForLanguage,
  resolveByExtension,
  resolveWasmPaths
} from './backend/grammars.js'
export type { GrammarName, WasmPaths } from './backend/grammars.js'

// 存储层
export { CodeIndexStore } from './db/sqlite-store.js'
export { ALL_DDL, EDGE_DDL, FILE_RECORD_DDL, NODE_DDL, NODE_FTS_DDL } from './db/schema.js'

// 文件系统默认实现
export { NodeFileSystem, createNodeFileSystem } from './fs/node.js'

// 抽取器
export { JavaScriptExtractor } from './extractor/javascript.js'
export { TypeScriptExtractor } from './extractor/typescript.js'
export { PythonExtractor } from './extractor/python.js'
export { VueExtractor } from './extractor/vue.js'
export { extractJsLike } from './extractor/base.js'

// 索引器
export { CodeIndexer } from './indexer/index.js'
export type { CodeIndexerOptions, IndexRepoOptions } from './indexer/index.js'
export {
  DEFAULT_HARD_SKIP_DIRS,
  DEFAULT_MAX_FILE_SIZE,
  discoverFiles,
  unsafeIndexRootReason
} from './indexer/discover.js'
export type { DiscoverOptions, DiscoveredFile } from './indexer/discover.js'

// 增量 sync 调度
export { DebouncedSyncQueue } from './indexer/sync.js'
export type { DebouncedSyncOptions, SyncRunContext } from './indexer/sync.js'

// 有界检索输出
export { DEFAULT_MAX_BYTES, DEFAULT_SNIPPET_LINES, formatBoundedSearch } from './search/bounded-formatter.js'
export type { BoundedFormatOptions, BoundedFormatResult } from './search/bounded-formatter.js'

// 运行时编排（不自动创建数据库或启动文件监听）
export { CodeIndexRegistry, indexKeyFor } from './runtime/registry.js'
export type { CodeIndexRegistryOptions, IndexHandle } from './runtime/registry.js'
export { CodeIndexService } from './runtime/service.js'
export type { CodeIndexServiceOptions, CodeSearchResult, IndexRoot } from './runtime/service.js'
