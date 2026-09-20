/**
 * @task-pipeline/codeindex — 共享类型与注入接口
 *
 * 核心与运行时服务不依赖 Electron；数据库连接、文件系统、解析后端和监听工厂均可注入。
 * Node.js 默认适配器独立提供，宿主决定数据位置、监听实现和资源生命周期。
 */

import type Database from 'better-sqlite3'

// ────────────────────────────────────────────────────────────────────────────
// 语言与符号
// ────────────────────────────────────────────────────────────────────────────

/** 支持的语言；java/php 在 Phase 3 接入，先占位保证类型与 grammar 映射完整。 */
export type Language = 'javascript' | 'typescript' | 'tsx' | 'vue' | 'python' | 'java' | 'php'

/** 符号类别（对齐源码导航语义，非严格语言学术语）。 */
export type SymbolKind =
  | 'file'
  | 'module'
  | 'class'
  | 'struct'
  | 'interface'
  | 'trait'
  | 'function'
  | 'method'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'type_alias'
  | 'namespace'
  | 'parameter'
  | 'import'
  | 'export'
  | 'component'
  | 'route'

/** 关系边类型；Phase 1 生产 contains / imports，其余为后续阶段预留。 */
export type EdgeKind =
  | 'contains'
  | 'imports'
  | 'exports'
  | 'calls'
  | 'references'
  | 'extends'
  | 'implements'
  | 'returns'
  | 'decorates'

/** 单个抽取出的符号定义。行/列为「整文件 1-based 坐标」。 */
export interface ExtractedSymbol {
  kind: SymbolKind
  name: string
  qualifiedName?: string
  /** 仓内相对路径（POSIX 分隔）。 */
  filePath: string
  language: Language
  startLine: number
  startCol: number
  endLine: number
  endCol: number
  signature?: string
  visibility?: 'public' | 'private' | 'protected' | 'internal' | 'file'
  /** 是否被 export（供 search 排序/展示）。 */
  exported?: boolean
  /** 语言特定附加信息（JSON 序列化后落 node.extra）。 */
  extra?: Record<string, unknown>
}

/** 文件级 import 记录（Phase 1 落成未解析目标名的 imports 边）。 */
export interface ImportInfo {
  /** module 说明符，如 'vue'、'./foo'、'os.path'。 */
  module: string
  /** 被导入的名字（可能为空表示整包 import）。 */
  names?: string[]
  /** 整包 import 的本地别名。 */
  alias?: string
  /** 该 import 语句所在行（1-based）。 */
  line: number
}

/** 一次抽取的结果。 */
export interface ExtractResult {
  symbols: ExtractedSymbol[]
  imports: ImportInfo[]
  /** 解析是否有告警（如 tree-sitter ERROR 节点）；不致命，仅诊断用。 */
  hadParseError?: boolean
}

/** 抽取器输入。 */
export interface ExtractInput {
  /** 绝对路径（仅诊断用，不参与持久化）。 */
  absPath: string
  /** 仓内相对路径，写进 symbol.filePath。 */
  relPath: string
  content: string
  language: Language
}

/** 语言抽取器接口。每种语言一个实现。 */
export interface Extractor {
  readonly language: Language
  extract(input: ExtractInput): ExtractResult
}

// ────────────────────────────────────────────────────────────────────────────
// ParserBackend 抽象（未来切 Rust/NAPI 只改这一个接口实现）
// ────────────────────────────────────────────────────────────────────────────

/** 与 web-tree-sitter / native tree-sitter 兼容的最小 AST 节点视图。 */
export interface ASTNode {
  readonly type: string
  readonly text: string
  readonly startIndex: number
  readonly endIndex: number
  readonly startPosition: { row: number; column: number } // row 0-based
  readonly endPosition: { row: number; column: number }
  readonly childCount: number
  readonly namedChildCount: number
  readonly hasError: boolean
  readonly isError: boolean
  readonly isMissing: boolean
  readonly parent: ASTNode | null
  readonly children: ASTNode[]
  readonly namedChildren: ASTNode[]
  childForFieldName(name: string): ASTNode | null
  child(index: number): ASTNode | null
  namedChild(index: number): ASTNode | null
}

export interface ParsedTree {
  rootNode: ASTNode
}

/** 语法解析后端抽象。language 为 grammar 名（'typescript' / 'python' ...）。 */
export interface ParserBackend {
  /** 懒加载指定 grammar，返回是否可用。 */
  ensureLanguage(language: string): Promise<boolean>
  /** 用指定 grammar 解析源码。 */
  parse(content: string, language: string): ParsedTree
  /** 释放底层资源。 */
  dispose?(): void
}

// ────────────────────────────────────────────────────────────────────────────
// FileSystem 注入（核心算法不直接依赖 node:fs，便于 headless/沙箱复用）
// ────────────────────────────────────────────────────────────────────────────

export interface FileStat {
  size: number
  mtimeMs: number
  isFile: boolean
  isDirectory: boolean
}

export interface FileSystem {
  readFile(path: string): string
  stat(path: string): FileStat | null
  /** 返回目录下的直接子项名（不含路径）。 */
  readDir(path: string): string[]
  exists(path: string): boolean
  isDirectory(path: string): boolean
}

/**
 * 文件变更监听器抽象；Node.js 默认实现位于独立的 node-watcher 子路径。
 * 实现方把 add/change/unlink 事件喂给注入的回调；服务不关心底层监听技术。
 */
export interface IndexWatcher {
  /** 开始监听（幂等）。 */
  start(): void
  /** 停止并释放底层资源（幂等）。 */
  stop(): void | Promise<void>
}

export interface IndexWatcherOptions {
  /** 规范化后的工作目录绝对路径。 */
  rootDir: string
  /** 相对路径使用 POSIX 分隔符。 */
  onFileChange: (relPath: string, type: 'upsert' | 'unlink') => void
  onError?: (error: unknown) => void
}

export type IndexWatcherFactory = (options: IndexWatcherOptions) => IndexWatcher

// ────────────────────────────────────────────────────────────────────────────
// 索引与检索的数据结构
// ────────────────────────────────────────────────────────────────────────────

export interface FileRecord {
  repoId: string
  path: string // 仓内相对路径
  language: Language | null
  size: number
  mtimeMs: number
  contentHash: string
  indexedAt: string
}

export interface IndexedFileResult {
  path: string
  symbolCount: number
  /** 是否真正重解析（false = 因 mtime+size+hash 命中而跳过）。 */
  reindexed: boolean
}

export interface IndexProgress {
  phase: 'scan' | 'index' | 'done'
  total: number
  done: number
  current?: string
}

export interface IndexResult {
  repoId: string
  filesScanned: number
  filesIndexed: number
  filesSkipped: number
  filesErrored: number
  symbolCount: number
  edgeCount: number
  durationMs: number
  errors: Array<{ path: string; message: string }>
}

/** 检索命中。有界输出用：只带坐标 + 简短签名，代码片段由调用方按 FileSystem 现取。 */
export interface SearchHit {
  repoId: string
  name: string
  qualifiedName: string | null
  kind: SymbolKind
  language: Language
  filePath: string // 仓内相对路径
  startLine: number
  endLine: number
  signature: string | null
  exported: boolean
  score: number
}

export interface SearchOptions {
  /** 限定这些 repo；为空表示不限（跨全部已索引仓）。 */
  repoIds?: string[]
  kinds?: SymbolKind[]
  languages?: Language[]
  limit?: number
  /** 是否包含 import/export 噪声符号（默认 false）。 */
  includeNoise?: boolean
}

/** 图邻接（Phase 1 仅 contains / imports 有数据；接口先就位）。 */
export interface Neighbor {
  kind: EdgeKind
  name: string
  qualifiedName: string | null
  filePath: string
  line: number
  direction: 'out' | 'in'
}

/** 存储统计。 */
export interface IndexStats {
  repoId?: string
  nodeCount: number
  edgeCount: number
  fileCount: number
  nodesByKind: Record<string, number>
  filesByLanguage: Record<string, number>
}

export type { Database }
