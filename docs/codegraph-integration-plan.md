# CodeGraph 接入设计方案

## 1. 背景与目标

为 TaskPipeline 桌面端接入代码知识图谱能力，使 Agent 在任务执行和对话过程中能快速感知仓库代码结构（符号定义、调用关系、依赖图），减少暴力 grep 带来的 token 浪费。

**核心约束：**

1. 快速接入当前 Electron + Node.js 系统
2. 索引统一存放在 `dataDir`（而非各项目目录下），跟随数据目录迁移
3. 索引快速、高效，支持增量更新

---

## 2. 社区方案调研汇总

### 2.1 候选方案概览

| 方案                          | 语言/运行时                 | 索引存储                               | 存储路径可控                | 接入方式               | 语言支持                      | 特点                                             |
| ----------------------------- | --------------------------- | -------------------------------------- | --------------------------- | ---------------------- | ----------------------------- | ------------------------------------------------ |
| **`@colbymchenry/codegraph`** | npm (Node.js + Rust kernel) | `.codegraph/` SQLite WAL               | ❌ 硬编码项目目录           | `npm install` 直接引入 | 30+ 语言                      | 自包含运行时，MCP Server，~53k stars             |
| **`@optave/codegraph`**       | npm (Node.js + WASM)        | SQLite (`dbPath` 可配)                 | ✅ 构造参数指定             | `npm install` 引入     | 30+ 语言                      | better-sqlite3 + web-tree-sitter，与项目共用依赖 |
| **`codebase-memory-mcp`**     | C 静态二进制                | `~/.cache/codebase-memory-mcp/` SQLite | ✅ `CBM_CACHE_DIR` 环境变量 | 子进程 / MCP stdio     | 158 语言 + 12 语言 Hybrid LSP | 极快（Linux 内核 3 分钟），14 个 MCP 工具        |
| **Graphify**                  | Python                      | `graphify-out/` 目录                   | 部分可控                    | CLI / MCP              | 多语言                        | 代码+文档知识图谱，偏 Python 生态                |
| **`@sdsrs/code-graph`**       | npm                         | 内部 SQLite                            | 不明确                      | `npm install` + MCP    | 多语言                        | AST 知识图谱 + 语义搜索                          |

### 2.2 `@colbymchenry/codegraph` vs `@optave/codegraph` 深度对比

以下基于 npm registry 实际包元数据（2026-08-23 查询）：

| 维度                  | `@colbymchenry/codegraph` v1.5.0                                                           | `@optave/codegraph` v3.17.0                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **包体积（解包）**    | **664KB** — 极轻量，thin installer 架构                                                    | **~110MB** — 内含 30+ tree-sitter WASM grammar                                                 |
| **架构**              | 自包含运行时，平台原生二进制通过 `optionalDependencies` 分发                               | TypeScript + `better-sqlite3` + `web-tree-sitter`，纯 JS 运行时                                |
| **解析引擎**          | web-tree-sitter (WASM) + **原生 Rust kernel** 加速（C/C++/Rust 等 20 种核心语言）          | web-tree-sitter (WASM)，无原生加速层                                                           |
| **存储引擎**          | `node:sqlite`（Node.js 内置）                                                              | **`better-sqlite3`**（与 TaskPipeline 共用同一依赖）                                           |
| **存储路径**          | ❌ 硬编码 `<projectRoot>/.codegraph/`，issue#304 请求可配**未实现**                        | ✅ **`dbPath` 构造参数**直接指定数据库路径                                                     |
| **Programmatic API**  | `npm-sdk.js` 入口，`import codegraph from '@colbymchenry/codegraph'`，导出 CodeGraph class | `dist/index.js`（ESM + CJS 双导出），提供 `index()`、`search()`、`context()`、`trace()` 等方法 |
| **Electron 嵌入实证** | ✅ **issue#354 确认**："We use CodeGraph as an embedded library inside an Electron app"    | 无直接 Electron 嵌入案例                                                                       |
| **Node.js 要求**      | `>=20.0.0`（Node 25 有 V8 WASM JIT bug 被阻断）                                            | `>=22.12.0`                                                                                    |
| **GitHub stars**      | ~53k                                                                                       | 89                                                                                             |
| **维护活跃度**        | 最后提交 6 天前，社区庞大                                                                  | 活跃开发中，v3.17.0                                                                            |
| **许可证**            | MIT                                                                                        | Apache-2.0                                                                                     |
| **MCP Server**        | ✅ 内置（codegraph_explore / codegraph_search / codegraph_impact 等）                      | ✅ 内置（@optave/codegraph MCP）                                                               |
| **增量更新**          | ✅ 原生文件监听器自动同步                                                                  | ✅ 支持增量索引                                                                                |
| **语义搜索**          | ❌ 仅 FTS5 关键词搜索                                                                      | ✅ 可选 `@huggingface/transformers` 语义嵌入（peerDep，optional）                              |

### 2.3 关键差异分析

#### 存储路径可控性（核心约束 #2）

这是两个方案最大的分水岭：

- **`@colbymchenry/codegraph`**：存储路径硬编码为 `<projectRoot>/.codegraph/`。要统一到 `dataDir` 必须采用变通方案：

  - **符号链接**：`<projectRoot>/.codegraph/` → `dataDir/codegraph/<repoHash>/`（Windows 需要管理员权限或开发者模式）
  - **Fork 修改**：维护自定义分支，改路径为构造参数（维护成本高，与上游 53k stars 社区脱节）
  - **运行时挂载**：在 Electron 主进程中 monkey-patch 其内部 `directory.ts` 的路径解析（脆弱，版本升级易碎）

- **`@optave/codegraph`**：`dbPath` 是构造参数，**原生支持**自定义存储路径。直接传入 `join(dataDir, 'codegraph', repoHash, 'graph.db')` 即可，零 hack。

#### Electron 嵌入兼容性（核心约束 #1）

- **`@colbymchenry/codegraph`**：已有 Electron 嵌入实证（issue#354），但自包含运行时意味着它会在 Electron 进程内启动自己的原生 Rust kernel。这在 Electron 的 Node.js 环境中可能产生 ABI 冲突（尤其是 `better-sqlite3` 已占用 native addon 线程池）。
- **`@optave/codegraph`**：使用 `better-sqlite3`（与 TaskPipeline **完全相同的依赖**，已验证 Electron ABI 兼容）+ `web-tree-sitter`（纯 WASM，无 native addon）。**零额外 native 依赖风险**。

#### 包体积与分发

- **`@colbymchenry/codegraph`**（664KB）：thin installer 架构，平台二进制按需下载。但 electron-builder 打包时需要处理 `optionalDependencies` 中的原生二进制（增加打包配置复杂度）。
- **`@optave/codegraph`**（110MB）：WASM grammar 文件体积大，但都是 `.wasm` 文件（跨平台通用），electron-builder 处理 WASM 比处理 native addon 简单得多。

### 2.4 选型结论（修订）

**推荐方案：`@optave/codegraph`**

理由：

1. **存储路径原生可控** — `dbPath` 构造参数直接满足"索引统一存放"的核心约束，无需符号链接/fork/monkey-patch 等变通方案
2. **依赖栈完全重合** — `better-sqlite3` 已在项目中验证 Electron ABI 兼容，`web-tree-sitter` 是纯 WASM 无 native 风险，**零额外兼容性成本**
3. **API 更丰富** — 提供 `index()` / `search()` / `context()` / `trace()` 四个核心方法 + 可选语义搜索（`@huggingface/transformers`），满足 Agent 代码感知需求
4. **ESM + CJS 双导出** — 同时兼容 Electron 主进程的 ESM 和 CJS 模块系统
5. **分发更简单** — WASM 文件跨平台通用，electron-builder 无需处理平台特定 native addon

**`@colbymchenry/codegraph` 的优势场景：**

- 如果项目不需要自定义存储路径（接受符号链接方案），它的社区更大（53k stars）、Rust kernel 解析更快、已有 Electron 嵌入实证
- 如果未来其 issue#304（可配存储路径）被实现，可重新评估

**进阶方案（可选）：`codebase-memory-mcp`**（子进程）

- 当需要 158 语言覆盖 + Hybrid LSP 类型解析 + Cypher 查询时，可通过子进程接入
- `CBM_CACHE_DIR` 环境变量原生支持自定义存储路径

---

## 3. 索引存储路径统一方案

### 3.1 现有数据目录结构

当前 `dataDir` 解析策略（`main.ts` L216）：

```
优先级：TASK_PIPELINE_DATA_DIR 环境变量 > userData/data-dir.json 自定义路径 > userData/data
```

现有子目录布局：

```
dataDir/
├── task-pipeline.db        # 主数据库
├── chats/                  # 对话数据
├── traces/                 # Trace 日志
├── skills/                 # Skill 文件
├── mcp.json                # MCP 配置
├── plans/                  # Plan 文件
├── chat-attachments/       # 对话附件
├── install.key             # 安装密钥
└── workspaces/             # 工作区配置
```

### 3.2 新增 codegraph 索引目录

```
dataDir/
├── ...（现有文件）
└── codegraph/              # 新增：代码图谱索引
    ├── config.json         # 索引元信息（版本、已索引仓库列表）
    ├── <repoHash>/         # 按仓库路径 hash 隔离
    │   ├── graph.db        # SQLite 知识图谱（@optave/codegraph，通过 dbPath 指定）
    │   └── meta.json       # 仓库索引状态（最后索引时间、文件数、节点/边数）
    └── <repoHash>/
        └── graph.db
```

**路径 hash 策略：** 对仓库 `localPath` 取 SHA-256 前 16 位作为目录名，避免路径特殊字符和长度问题，同时保证唯一性。

### 3.3 `@optave/codegraph` 存储路径配置（推荐方案）

`@optave/codegraph` 原生支持 `dbPath` 构造参数，**零 hack** 将索引统一到 `dataDir`：

```typescript
// codegraph-service.ts
import { CodeGraph } from '@optave/codegraph'

function createGraphForRepo(localPath: string): CodeGraph {
  const hash = repoHash(localPath)
  const dbPath = join(dataDir, 'codegraph', hash, 'graph.db')
  // 确保目录存在
  mkdirSync(dirname(dbPath), { recursive: true })
  return new CodeGraph({ dbPath, rootDir: localPath })
}
```

优点：

- 原生支持，无需符号链接/fork/monkey-patch
- 索引随 `dataDir` 自动迁移（现有 `cpSync` 迁移逻辑自动覆盖）
- 不污染用户项目目录（不会在项目目录下创建任何文件）
- Windows 零权限问题

### 3.4 备选：`@colbymchenry/codegraph` 存储路径改造（如选用）

若选用 `@colbymchenry/codegraph`，需采用以下变通方案之一：

**方案 A：符号链接重定向**

```typescript
// 项目目录 .codegraph/ → dataDir/codegraph/<repoHash>/
const repoGraphDir = join(dataDir, 'codegraph', repoHash)
const projectLink = join(repoLocalPath, '.codegraph')
// Windows 需要管理员权限或开发者模式
```

**方案 B：fork/patch 修改存储路径**

维护自定义分支，将 `.codegraph/` 硬编码路径改为可配置。维护成本高，与上游 53k stars 社区脱节。

### 3.5 进阶方案：`codebase-memory-mcp` 环境变量直配

```typescript
// 启动子进程前设置环境变量
process.env.CBM_CACHE_DIR = join(dataDir, 'codegraph', 'cbm-cache')
```

---

## 4. Electron 主进程索引服务封装

### 4.1 模块结构

新增文件 `apps/desktop/electron/codegraph/`：

```
electron/codegraph/
├── codegraph-service.ts    # 索引服务主类（生命周期管理）
├── codegraph-indexer.ts    # 索引构建/增量更新逻辑
├── codegraph-query.ts      # 查询封装（符号查找、调用图、依赖分析）
└── codegraph-types.ts      # 类型定义
```

### 4.2 CodegraphService 类设计

遵循现有服务封装模式（参照 `MemoryService`、`ChatAttachmentCache`）：

```typescript
// electron/codegraph/codegraph-service.ts

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskStore } from '@task-pipeline/core'
import { CodeGraphIndexer, type IndexStatus } from './codegraph-indexer.js'
import { CodegraphQuery, type SymbolInfo, type CallEdge } from './codegraph-query.js'

export interface RepoIndexMeta {
  repositoryId: string
  localPath: string
  lastIndexedAt: string // ISO 时间戳
  fileCount: number
  nodeCount: number
  edgeCount: number
  status: 'idle' | 'indexing' | 'error'
  error?: string
}

export class CodegraphService {
  private readonly indexRoot: string
  private readonly indexer: CodeGraphIndexer
  private readonly query: CodegraphQuery
  /** 仓库维度索引状态缓存（repoHash → meta） */
  private readonly metaCache = new Map<string, RepoIndexMeta>()

  constructor(
    private readonly dataDir: string,
    private readonly store: TaskStore
  ) {
    this.indexRoot = join(dataDir, 'codegraph')
    mkdirSync(this.indexRoot, { recursive: true })
    this.indexer = new CodeGraphIndexer(this.indexRoot)
    this.query = new CodegraphQuery(this.indexRoot)
    this.loadMetaCache()
  }

  /** 计算仓库路径的 hash（SHA-256 前 16 位） */
  repoHash(localPath: string): string {
    return createHash('sha256').update(localPath).digest('hex').slice(0, 16)
  }

  /** 获取仓库的索引目录路径 */
  repoIndexDir(localPath: string): string {
    return join(this.indexRoot, this.repoHash(localPath))
  }

  /** 触发全量索引（首次或强制重建） */
  async indexRepository(repositoryId: string, localPath: string): Promise<IndexStatus> {
    const hash = this.repoHash(localPath)
    const dir = this.repoIndexDir(localPath)
    this.metaCache.set(hash, {
      repositoryId,
      localPath,
      lastIndexedAt: '',
      fileCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      status: 'indexing'
    })
    try {
      const status = await this.indexer.build(dir, localPath)
      this.metaCache.set(hash, {
        repositoryId,
        localPath,
        lastIndexedAt: new Date().toISOString(),
        fileCount: status.fileCount,
        nodeCount: status.nodeCount,
        edgeCount: status.edgeCount,
        status: 'idle'
      })
      this.saveMetaCache()
      return status
    } catch (err) {
      this.metaCache.get(hash)!.status = 'error'
      this.metaCache.get(hash)!.error = String(err)
      this.saveMetaCache()
      throw err
    }
  }

  /** 增量更新（基于文件变更检测） */
  async updateIndex(repositoryId: string, localPath: string): Promise<IndexStatus> {
    const dir = this.repoIndexDir(localPath)
    if (!existsSync(dir)) return this.indexRepository(repositoryId, localPath)
    return this.indexer.incrementalUpdate(dir, localPath)
  }

  /** 查询符号定义 */
  findSymbol(localPath: string, name: string): SymbolInfo[] {
    return this.query.searchSymbol(this.repoHash(localPath), name)
  }

  /** 查询调用关系 */
  traceCalls(localPath: string, symbolName: string, direction: 'inbound' | 'outbound'): CallEdge[] {
    return this.query.traceCalls(this.repoHash(localPath), symbolName, direction)
  }

  /** 获取仓库索引状态 */
  getIndexStatus(localPath: string): RepoIndexMeta | undefined {
    return this.metaCache.get(this.repoHash(localPath))
  }

  /** 列出所有已索引仓库 */
  listIndexed(): RepoIndexMeta[] {
    return [...this.metaCache.values()]
  }

  /** 删除仓库索引 */
  deleteIndex(repositoryId: string): void {
    const meta = [...this.metaCache.values()].find((m) => m.repositoryId === repositoryId)
    if (!meta) return
    const dir = this.repoIndexDir(meta.localPath)
    this.indexer.removeIndex(dir)
    this.metaCache.delete(this.repoHash(meta.localPath))
    this.saveMetaCache()
  }

  // --- 内部持久化 ---
  private loadMetaCache(): void {
    /* 从 indexRoot/config.json 加载 */
  }
  private saveMetaCache(): void {
    /* 写入 indexRoot/config.json */
  }
}
```

### 4.3 初始化时机

在 `main.ts` 中，紧随 `memoryService` 初始化之后：

```typescript
// main.ts — 在 const memoryService = new MemoryService(store) 之后
const codegraphService = new CodegraphService(dataDir, store)
```

### 4.4 IPC 通道设计

遵循现有 IPC 命名模式（`模块:动作`）：

```typescript
// preload.cts — 新增 codegraph 区块
// === CodeGraph 代码图谱 ==================================================
indexCodeGraph: (repositoryId: string) => ipcRenderer.invoke('codegraph:index', repositoryId),
updateCodeGraph: (repositoryId: string) => ipcRenderer.invoke('codegraph:update', repositoryId),
searchCodeGraph: (repositoryId: string, query: string) =>
  ipcRenderer.invoke('codegraph:search', repositoryId, query),
traceCodeGraph: (repositoryId: string, symbol: string, direction: string) =>
  ipcRenderer.invoke('codegraph:trace', repositoryId, symbol, direction),
listCodeGraphs: () => ipcRenderer.invoke('codegraph:list'),
deleteCodeGraph: (repositoryId: string) => ipcRenderer.invoke('codegraph:delete', repositoryId),
getCodeGraphStatus: (repositoryId: string) =>
  ipcRenderer.invoke('codegraph:status', repositoryId),
```

```typescript
// main.ts — IPC handler 注册
// === CodeGraph 代码图谱 ==================================================
ipcMain.handle('codegraph:index', async (_event, repositoryId: string) => {
  const profile = store.listRepositoryProfiles().find((r) => r.id === repositoryId)
  if (!profile) throw new Error('仓库不存在')
  return codegraphService.indexRepository(profile.id, profile.localPath)
})

ipcMain.handle('codegraph:update', async (_event, repositoryId: string) => {
  const profile = store.listRepositoryProfiles().find((r) => r.id === repositoryId)
  if (!profile) throw new Error('仓库不存在')
  return codegraphService.updateIndex(profile.id, profile.localPath)
})

ipcMain.handle('codegraph:search', (_event, repositoryId: string, query: string) => {
  const profile = store.listRepositoryProfiles().find((r) => r.id === repositoryId)
  if (!profile) return []
  return codegraphService.findSymbol(profile.localPath, query)
})

ipcMain.handle('codegraph:trace', (_event, repositoryId: string, symbol: string, direction: string) => {
  const profile = store.listRepositoryProfiles().find((r) => r.id === repositoryId)
  if (!profile) return []
  return codegraphService.traceCalls(profile.localPath, symbol, direction as 'inbound' | 'outbound')
})

ipcMain.handle('codegraph:list', () => codegraphService.listIndexed())

ipcMain.handle('codegraph:delete', (_event, repositoryId: string) => {
  codegraphService.deleteIndex(repositoryId)
  return codegraphService.listIndexed()
})

ipcMain.handle('codegraph:status', (_event, repositoryId: string) => {
  const meta = codegraphService.listIndexed().find((m) => m.repositoryId === repositoryId)
  return meta ?? null
})
```

---

## 5. 索引生命周期管理

### 5.1 创建（首次索引）

**触发时机：**

- 用户绑定仓库后，在设置页/仓库管理页手动触发"索引代码图谱"
- 对话中 Agent 首次访问某仓库的代码结构时自动触发（lazy init）

**流程：**

```
用户/Agent 触发
  → codegraph:index IPC
  → CodegraphService.indexRepository()
    → 创建 dataDir/codegraph/<repoHash>/ 目录
    → CodeGraphIndexer.build(indexDir, repoLocalPath)
      → 调用 CodeGraph 的 tree-sitter 解析流水线
      → 遍历仓库文件，提取 AST 节点和边
      → 写入 SQLite graph.db
    → 更新 metaCache + 持久化 config.json
  → 返回 IndexStatus
```

**并发控制：** 同一仓库不允许并行索引（通过 `metaCache.status === 'indexing'` 判断），不同仓库可并行。

### 5.2 增量更新

**触发时机：**

- 任务执行过程中文件变更后（task state → completed/failed 时）
- 对话中需要最新代码结构时（检查 `lastIndexedAt` 是否过期，阈值可配，默认 5 分钟）
- 用户手动触发

**策略：**

```typescript
// codegraph-indexer.ts
async incrementalUpdate(indexDir: string, repoPath: string): Promise<IndexStatus> {
  // 1. 读取上次索引的 git HEAD
  // 2. 获取 git diff --name-only 变更文件列表
  // 3. 仅对变更文件重新解析 AST
  // 4. 更新 graph.db 中对应节点和边
  // 5. 更新 meta.json
}
```

**文件监听（可选增强）：** 参照 `codebase-memory-mcp` 的 watcher 模式，在索引后注册 `fs.watch` / `chokidar` 监听器，检测文件变更后自动触发增量更新。

### 5.3 清理

**触发时机：**

- 用户删除仓库时（`repos:delete` IPC handler 中联动调用 `codegraph:delete`）
- 数据目录迁移时（现有迁移逻辑 `app:set-data-dir` 的 `cpSync` 会自动拷贝整个 `dataDir`，codegraph 子目录随之迁移）
- 用户手动删除特定仓库索引

**清理策略：**

```typescript
// 删除仓库索引
deleteIndex(repositoryId: string): void {
  const meta = findMeta(repositoryId)
  // rmSync 递归删除索引目录
  rmSync(this.repoIndexDir(meta.localPath), { recursive: true, force: true })
  this.metaCache.delete(this.repoHash(meta.localPath))
  this.saveMetaCache()
}
```

**数据目录迁移兼容：** 现有迁移逻辑（`main.ts` L3383-3402）通过 `cpSync` 递归拷贝整个 `dataDir`，`codegraph/` 子目录自动包含在内，无需额外处理。迁移后符号链接需要重建（因为项目路径未变，但 `dataDir` 变了）。

### 5.4 生命周期状态机

```
                  ┌──────────┐
         创建     │          │    增量更新
  ────────► IDLE ◄──────────┤
           │      │          │◄───────┐
           │      └──────────┘        │
           │            │             │
     indexRepository   updateIndex    │
           │            │             │
           ▼            ▼             │
        ┌──────────────────┐          │
        │    INDEXING      │──────────┘
        └──────────────────┘
           │         │
        成功│         │失败
           ▼         ▼
        ┌──────┐  ┌──────┐
        │ IDLE │  │ ERROR│
        └──────┘  └──────┘
                      │
                 重试  │
                      ▼
                   INDEXING

        任意状态 ──delete──► 删除（rmSync）
```

---

## 6. 与 Agent 系统的集成

### 6.1 Agent 上下文注入

在 `loadRepoContext`（`task-runner.ts`）中增加代码图谱上下文：

```typescript
// task-runner.ts — loadRepoContext 增强
async function loadRepoContext(...) {
  // ... 现有 git 上下文 ...

  // 新增：代码图谱摘要
  if (codegraphService) {
    const arch = codegraphService.getArchitecture(repoPath)
    if (arch) {
      context += `\n## 代码结构摘要\n${arch.summary}`
    }
  }
  return context
}
```

### 6.2 对话工具集成

在 Chat 系统的 `project-query-tools.ts` 中新增代码图谱查询工具：

```typescript
// 新增工具：codegraph_search / codegraph_trace
// Agent 可通过这些工具查询代码结构，替代暴力 grep
```

### 6.3 MCP Server 模式（可选）

若选择 `codebase-memory-mcp` 作为进阶方案，可直接将其注册为内部 MCP Server：

```typescript
// mcp-config.ts — 内置 MCP Server
const BUILTIN_MCP_IDS = ['codebase-memory-mcp', ...existingIds]
```

---

## 7. 依赖与包配置

### 7.1 package.json 变更

```json
{
  "dependencies": {
    "@colbymchenry/codegraph": "^0.9.8"
  }
}
```

若采用进阶方案：

```json
{
  "optionalDependencies": {
    "codebase-memory-mcp": "..."
  }
}
```

### 7.2 electron-builder 配置

CodeGraph 的 tree-sitter native 模块需要在 electron-builder 的 `extraResources` 中处理原生模块重编译（与现有 `better-sqlite3` 类似）。

---

## 8. 实施路线图

| 阶段       | 内容                                                          | 预估工时 |
| ---------- | ------------------------------------------------------------- | -------- |
| P0         | 新增 `codegraph/` 模块骨架 + `CodegraphService` 类 + IPC 通道 | 1-2 天   |
| P1         | 索引创建/增量更新/删除完整实现 + 存储路径统一                 | 2-3 天   |
| P2         | Agent 上下文注入 + 对话工具集成                               | 1-2 天   |
| P3         | 数据目录迁移兼容 + 符号链接重建 + 错误处理                    | 1 天     |
| P4（可选） | `codebase-memory-mcp` 子进程模式集成                          | 2-3 天   |

---

## 9. 风险与缓解

| 风险                                          | 影响                   | 缓解                                                           |
| --------------------------------------------- | ---------------------- | -------------------------------------------------------------- |
| CodeGraph 存储路径不可配                      | 索引散落在各项目目录   | 符号链接重定向或 fork patch                                    |
| tree-sitter native 模块与 Electron ABI 不兼容 | 运行时崩溃             | 使用 `electron-rebuild` 重编译，参照 `better-sqlite3` 处理方式 |
| 大型仓库索引耗时过长                          | 用户等待体验差         | 异步索引 + 进度通知 + 增量更新                                 |
| Windows 符号链接需要管理员权限                | 方案 A 在 Windows 失败 | 回退到方案 B（fork patch）或文件拷贝                           |
| CodeGraph 上游更新破坏兼容性                  | 功能异常               | 锁定版本 + 定期跟进更新                                        |
