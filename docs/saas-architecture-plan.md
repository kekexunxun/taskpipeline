# TaskPipeline SaaS 化架构方案

> 目标：在保留 Electron 桌面版（IDE）的同时，将产品演进为支持多租户的 SaaS 平台，Web 端具备全量能力，任务执行支持本地 / 云端 / 队列（Loop）三种模式。

## 1. 背景与目标

### 1.1 产品现状

TaskPipeline 当前以 Electron 桌面应用形态交付：

- **前端**：React 19 + Vite 6 + Tailwind CSS 4 + Radix UI（`apps/desktop/src/`）
- **后端**：Electron 主进程承载全部业务逻辑（`apps/desktop/electron/`），约 120 个 IPC handler
- **通信**：Electron IPC（`contextBridge` + `ipcRenderer.invoke`），事件走 `webContents.send`
- **存储**：better-sqlite3 本地数据库 + JSONL Trace 文件
- **原生能力**：本地 Git worktree、CodeGraph 索引、OCR、MCP/Skill 子进程

关键结构事实：

1. [ipc/index.ts](../apps/desktop/electron/ipc/index.ts)（908 行）本质是 `channel → service method` 的薄代理，与 REST router 同构，`IpcDeps` 已定义清晰的依赖注入边界；
2. Electron 特有 API 使用集中（`dialog` / `shell` / `app` / `BrowserWindow` / auto-updater），占比很小；
3. 前端 [api.ts](../apps/desktop/src/api.ts) 通过 `window.agentApi` 统一接口访问后端，且已有浏览器 mock 回退实现；
4. 业务模块已充分拆分：`chat/`、`task/`、`memory/`、`trace/`、`agents/`、`pi-extension/qoder/` 等。

### 1.2 产品价值分拆

产品的核心价值分为两个层次，二者对 Web 化的难度完全不同：

```
价值 A — 对话/计划/管理（信息流）
  Chat、Plan、Trace、Memory、MR 管理、Jira 同步
  → 本质是数据 CRUD + LLM API 调用
  → 天然适合云端，多端同步无障碍

价值 B — 代码执行（操作流）
  Agent 读写文件、git worktree、npm test、commit、push
  → 本质是"在真实代码仓库上执行物理操作"
  → 必须有一个"能碰到代码"的运行环境
```

### 1.3 架构决策（已确认）

| 决策       | 结论                                                                      |
| ---------- | ------------------------------------------------------------------------- |
| Web 端能力 | **全量能力**（含 Task 执行）                                              |
| 后端形态   | **统一 Node.js 后端 + 可插拔执行环境**，Electron 与 Web 接入同一套 Server |
| 产品形态   | **SaaS 多租户**                                                           |
| 云端执行   | **Docker 容器**执行每个任务                                               |
| Loop 定位  | **Task 的上层编排**，不是替代 Task 数据模型                               |

### 1.4 数据与执行的两个"世界"统一原则

禁止演变为两套各自维护的系统。原则：

- **一套后端、一套数据模型**：Electron 与 Web 连同一 Server（本地部署时为本地内置 Server），数据天然同步；
- **执行环境可插拔**：每个 Task 通过 `executionTarget` 字段决定执行位置，业务逻辑不感知执行位置；
- **Loop 是 Task 的上层编排**：新增编排层，不动已有 Task 数据模型。

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        SaaS Platform                         │
│                                                              │
│  ┌──────────┐  ┌──────────┐                                 │
│  │ Electron │  │   Web    │  ← 多端接入                      │
│  └────┬─────┘  └────┬─────┘                                 │
│       │              │                                       │
│       └──────┬───────┘                                       │
│              ▼                                               │
│  ┌──────────────────────────────────────┐                    │
│  │         API Server (Node.js)         │                    │
│  │  ┌─────────┐ ┌─────────┐ ┌────────┐ │                    │
│  │  │Auth/    │ │Chat     │ │Task    │ │                    │
│  │  │Tenant   │ │Service  │ │Service │ │                    │
│  │  │Manager  │ │         │ │        │ │                    │
│  │  └─────────┘ └─────────┘ └───┬────┘ │                    │
│  │                               │      │                    │
│  │  ┌─────────┐ ┌─────────┐ ┌───┴────┐ │                    │
│  │  │Trace    │ │Memory   │ │Loop    │ │                    │
│  │  │Service  │ │Service  │ │Scheduler│ │                    │
│  │  └─────────┘ └─────────┘ └───┬────┘ │                    │
│  └──────────────────────────────┼───────┘                    │
│              │                  │                             │
│     ┌────────┴───────┐  ┌──────┴────────┐                    │
│     │  PostgreSQL    │  │  Redis         │                    │
│     │  (多租户数据)   │  │  (队列+缓存)   │                    │
│     └────────────────┘  └──────┬─────────┘                    │
│                                │                              │
│                     ┌──────────┴──────────┐                   │
│                     │  Docker Executor    │                   │
│                     │  Pool               │                   │
│                     │ ┌─────┐ ┌─────┐    │                   │
│                     │ │T-01 │ │T-02 │    │                   │
│                     │ └─────┘ └─────┘    │                   │
│                     │ ┌─────┐ ┌─────┐    │                   │
│                     │ │T-03 │ │T-04 │    │                   │
│                     │ └─────┘ └─────┘    │                   │
│                     └─────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 执行环境可插拔模型

每个 Task 有一个 `executionTarget` 字段，由业务层统一调度：

```typescript
type ExecutionTarget =
  | { type: 'local' } // Electron 专属：本地 worktree 执行
  | { type: 'container' } // Server 创建 Docker 容器执行
  | { type: 'queue'; loopId: string } // Loop：异步队列执行（云端）

interface Task {
  id: string
  title: string
  executionTarget: ExecutionTarget
  // ... 其余字段不变
}
```

执行抽象层示意图：

```
TaskWorkflow / QoderOrchestrator（业务逻辑，不感知执行位置）
        │
        ▼
  ExecutionBackend（统一抽象）
   ├── LocalBackend      → 本地文件系统 + execa（Electron）
   ├── ContainerBackend  → Docker 容器 FS + docker exec（云端）
   └── QueueBackend      → BullMQ 异步任务（Loop）
```

### 2.2 现有代码的对接点

| 现有组件                                   | 改造方式                                                            |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `GitService`（execa git）                  | 构造函数已接受 `GitRunner` 注入，改为容器内执行即可，业务逻辑零改动 |
| `TaskWorkflow.prepareWorktree()`           | 改为 `ExecutionBackend.create()`（容器内 clone + 建分支）           |
| `TaskWorkflow` 的 shell runner             | 改为 `ExecutionBackend.exec()`                                      |
| `QoderOrchestrator` Agent 文件操作         | 通过 `ExecutionBackend` 的 FS API 代理到容器内                      |
| `taskChangedFiles()` / `mergeBackToBase()` | 改为 `ExecutionBackend.git()`                                       |

## 3. Docker 执行环境

### 3.1 Executor Pool 职责

```
createExecution(taskId, tenantId, repos):
  1. 选择/复用镜像（按语言栈 + 租户缓存）
  2. 启动容器（clone 仓库、注入凭据、设置资源限制）
  3. 执行初始化命令（setupCommand，如 npm install）
  4. 返回 ExecutionHandle

exec(handle, command):   容器内执行命令
readFile/writeFile(handle, path):  容器内文件读写（Agent 用）
git(handle, args):       容器内 Git 操作
destroy(handle):         停止并删除容器
```

### 3.2 镜像与缓存策略

| 方案                              | 启动耗时                  | 说明                                                      |
| --------------------------------- | ------------------------- | --------------------------------------------------------- |
| 通用镜像                          | 秒级 + install 时间       | 预装 node/python/git，每任务 npm install                  |
| 按需构建镜像                      | 首次 1-3min，命中缓存秒级 | 按 package.json 构建专属镜像，同仓库复用                  |
| **基础镜像 + 依赖缓存卷（推荐）** | ~5s                       | 通用镜像 + 挂载缓存卷，`npm ci --prefer-offline` 命中缓存 |

### 3.3 容器安全基线（SaaS 必做）

```dockerfile
FROM node:20-slim AS executor
RUN useradd -m executor
USER executor
WORKDIR /workspace
```

```bash
docker run --rm --init \
  --memory=2g --cpus=2 \
  --network=restricted \            # 仅放行 npm registry + Git remote + LLM API
  --read-only \                     # 根文件系统只读
  --tmpfs /workspace:rw,size=1g \   # 仅工作区可写
  --security-opt=no-new-privileges \
  executor
```

网络策略：**禁止**访问内网地址（10.x / 172.x / 192.168.x）、其他租户容器、宿主机；允许 npm registry、用户配置的 Git remote、LLM API。

### 3.4 生命周期与 GC

```
环境状态机: creating → ready → executing → (完成/失败/取消) → destroying → destroyed
```

- 已完成超过 1 小时的环境 → 销毁
- 空闲超过 30 分钟的环境 → 销毁
- 失败超过 24 小时的环境 → 销毁
- 仓库 clone 落盘 `/data/repos/{tenant}/`，按租户配额 LRU 淘汰

## 4. Loop 编排层

### 4.1 定义

Loop 是 Task 的上层编排，实现"任务新增 → 任务计划 → 确认执行进入队列 → 任务完成"的异步流水线。仅需云端实现；Task 数据模型不变。

### 4.2 数据模型

```typescript
interface TaskLoop {
  id: string
  tenantId: string
  name: string
  status: 'idle' | 'planning' | 'queued' | 'executing' | 'paused' | 'completed' | 'failed'
  concurrency: number // 同时执行的任务数
  retryPolicy: { maxRetries: number; backoffMs: number }
  totalTasks: number
  completedTasks: number
  failedTasks: number
  createdAt: string
  updatedAt: string
}
```

### 4.3 队列技术选型

**Redis + BullMQ**（Node.js 生态最成熟的任务队列）：

- 优先级队列、延迟任务、重试策略、并发控制
- 天然支持多 Worker 进程水平扩展
- Worker 消费时从租户配额读取 `concurrency` 上限

```typescript
interface TaskJob {
  taskId: string
  loopId: string
  tenantId: string
  priority: number
  attempts: number
}
```

### 4.4 用户体验流程

```
1. Web 创建 Task / Loop，关联仓库（remote URL + 凭据）
2. 点击"生成计划" → 秒级返回（只需 LLM API）
3. 审批计划 → 系统自动：
   a. 创建执行环境（进度展示：clone 仓库 → 安装依赖…）
   b. Agent 执行（实时日志流）
   c. 完成 → 等待 review
4. 用户查看文件变更列表 / diff / 测试结果
5. 审批 → push + 创建 MR（GitLab API）→ 销毁环境
6. 要求修改 → 在已有环境继续；取消 → 销毁环境
```

## 5. 多租户设计

### 5.1 隔离层级

| 层级     | 隔离方式                                            |
| -------- | --------------------------------------------------- |
| 数据层   | `tenant_id` 行级隔离（PostgreSQL RLS 或应用层过滤） |
| 执行层   | Docker 容器隔离（每 Task 独立容器）                 |
| 文件层   | 容器内文件系统隔离（容器销毁即清理）                |
| 凭据层   | 加密存储，按 tenant 隔离                            |
| LLM 配额 | 按 tenant 计量（token 用量 / 调用次数）             |

### 5.2 租户上下文与配额

```typescript
interface TenantContext {
  tenantId: string
  userId: string
  quotas: {
    maxConcurrentTasks: number
    maxStorageGb: number
    monthlyLLMTokens: number
    monthlyComputeMinutes: number
  }
}
```

中间件在每个 API 请求中解析租户、校验配额（超限返回 429）。

### 5.3 数据库迁移：SQLite → PostgreSQL

所有表增加 `tenant_id` 列并建联合索引：

```sql
ALTER TABLE tasks ADD COLUMN tenant_id UUID NOT NULL;
ALTER TABLE events ADD COLUMN tenant_id UUID NOT NULL;
ALTER TABLE repositories ADD COLUMN tenant_id UUID NOT NULL;
ALTER TABLE chat_conversations ADD COLUMN tenant_id UUID NOT NULL;
-- ...

CREATE INDEX idx_tasks_tenant ON tasks(tenant_id, state);
CREATE INDEX idx_events_tenant ON events(tenant_id, task_id);
```

**关键难点**：`better-sqlite3` 为同步 API、PostgreSQL 为异步 API。现有 `TaskStore` / `ChatStorage` 等接口抽象良好，可通过双实现切换：

- Electron 本地模式：保留 `SQLiteTaskStore`（现有实现，包一层 async wrapper）
- SaaS 云端模式：新增 `PostgresTaskStore`

上层业务代码需逐步改为 `await store.xxx()`，波及面广，是最大的隐性工作量。

## 6. 凭据与安全

```
当前 (Electron): 凭据在用户本机（electron-store 加密文件）
SaaS:           凭据入库加密（AES-256 或 Vault），按 tenant 隔离
```

要求：

1. 数据库凭据加密存储，解密仅在服务端内存进行
2. 容器凭据通过运行时 env / Secret 注入，**不写入镜像层**
3. 容器销毁即清除凭据
4. 租户 A 永远无法访问租户 B 的凭据（含 Git Token / Jira Token / Qoder Token / LLM Key）

## 7. 存储规划

| 存储类型       | 位置                    | 清理策略            |
| -------------- | ----------------------- | ------------------- |
| Git 仓库 clone | `/data/repos/{tenant}/` | 按租户配额 LRU 淘汰 |
| Task 工作区    | 容器内 `/workspace/`    | 容器销毁即清理      |
| LLM 对话记录   | PostgreSQL              | 永久保留            |
| Trace 日志     | PostgreSQL / S3         | 按保留策略归档      |
| 附件 / 产物    | S3 / MinIO              | 按 Task 生命周期    |

## 8. 潜在风险与应对

| 风险                   | 说明                                      | 应对                                                                       |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| SQLite → PG 迁移工作量 | 同步 API vs 异步 API，波及所有 store 调用 | 先定义异步 Store 接口，Electron 用 async wrapper 包 SQLite，云端换 PG 实现 |
| 容器启动延迟           | 每次 Task clone + install 可达 1-5min     | 仓库预热 + node_modules 缓存卷 + 镜像复用                                  |
| 容器资源成本           | 每 Task 一容器，并发高时成本飙升          | 租户并发配额 + 同仓库连续 Task 复用容器                                    |
| 长时任务               | 单 Task 可达 10-30min                     | 容器不设超时，用租户月度计算时长配额约束                                   |
| Agent 文件操作适配     | Qoder SDK / pi Agent 直接操作本地 FS      | FS 操作经 ExecutionBackend 代理到容器                                      |
| CodeGraph 容器化       | 当前为本地子进程                          | 容器内运行，或通过 volume 共享索引                                         |

## 9. 实施路线

```
Phase 1: 统一后端 + API 化（约 3 周）
  ├── 提取 Node.js Server（IPC → HTTP + WS 路由迁移，~120 endpoint）
  ├── 定义异步 Store 接口
  ├── Electron 内置 Server + SQLite（本地模式）
  ├── 前端 api.ts HTTP 实现（保留 window.agentApi IPC 分支）
  ├── Electron 薄壳化（窗口 + 本地服务启动器）
  └── Chat / 配置 / Trace 全量可用（Level 0 + 1）

Phase 2: PostgreSQL + 多租户（约 2-3 周）
  ├── PostgresTaskStore 实现
  ├── tenant_id 全表迁移
  ├── 认证系统（JWT + 租户上下文中间件）
  ├── Electron 本地仍走 SQLite
  └── Web 云端走 PostgreSQL

Phase 3: Docker 执行环境（约 3-4 周）
  ├── ExecutorService + 容器生命周期管理
  ├── 镜像策略 + 依赖缓存卷
  ├── 安全基线（非 root / 网络限制 / 只读根 FS / 凭据注入）
  ├── GitService 注入容器 GitRunner
  └── Agent 文件操作适配 ExecutionBackend

Phase 4: Loop 编排（约 2-3 周）
  ├── Redis + BullMQ 队列
  ├── TaskLoop 数据模型 + API
  ├── 调度器 + 并发控制（按租户配额）
  ├── Web 端 Loop 管理界面
  └── 执行进度推送 + 通知

Phase 5: 计费 + 运维（约 2-3 周）
  ├── 租户配额管理
  ├── LLM 用量计量
  ├── 计算时长计量
  ├── 存储用量计量
  └── 管理后台

合计约 12-16 周，核心改造集中在 Phase 1-3。
```

## 10. Electron 本地执行与云端的选择交互

Electron 内置 Server（本地模式）与 SaaS Server（云端模式）共用同一套后端代码与数据模型，差异仅在 Store 实现与 ExecutionBackend 选择：

| 能力                | Electron 本地模式                                | Web / SaaS 云端                 |
| ------------------- | ------------------------------------------------ | ------------------------------- |
| 后端位置            | 用户本机（内置 Server + SQLite）                 | 云端（PostgreSQL）              |
| 数据                | 本地 SQLite                                      | 云端数据库                      |
| 仓库                | 用户本地目录 / remote clone                      | remote clone                    |
| Task 执行           | LocalBackend（本地 worktree）或 ContainerBackend | ContainerBackend / QueueBackend |
| 对话 / 计划 / Trace | 全量                                             | 全量                            |
| Loop                | 不启用（可选连云端 Server 后使用）               | 全量                            |
