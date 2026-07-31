# 计划：pi-package 与 desktop 业务逻辑对齐 + 下沉共享

> 状态：**已完成**（2026-07-30）
> 目标：把 desktop 已迭代成熟的 review / deliver / MR 状态 / Jira 同步 / 编辑器唤起等业务逻辑下沉到 `@coding-agent/integrations`（必要时在 `@coding-agent/core` 加抽象接口），让 `apps/desktop/electron/main.ts` 和 `packages/pi-package/src/index.ts` 复用同一份实现，**禁止再次分叉**。

---

## 1. 背景与现状

### 1.1 已观察到的差异（desktop vs pi-package）

| 能力 | desktop（`apps/desktop/electron/main.ts`） | pi-package（`packages/pi-package/src/index.ts`） |
|---|---|---|
| Review 模式 | **委托模式**：git diff → ocr `delegate rule` → LLM（Qoder / OpenAI 兼容） | **本地 ocr**：`OpenCodeReviewService.review()` 直接出 JSON |
| Review 超时 | LLM `REVIEW_LLM_TIMEOUT_MS = 3min` | 无 |
| Review 阻断级别 | 支持 `reviewBlockingLevel`（critical / medium / high） | 写死 critical/high/error |
| Review 重入保护 | `if (reviewing && reviewStatus === "running")` 跳过 | 无 |
| Review 异常处理 | try/catch → `reviewStatus: blocked` + `review_blocked` 状态 | 异常直接冒泡 |
| Review 重置 | `resetTaskReview()` 走合法出口 reviewing → review_blocked | 无 |
| `deliver` 提交 | `git commit --no-verify`（绕开 husky） | `git commit -m`（会被 husky 卡死） |
| `deliver` push | 单独 90s 超时；网络错误识别 + 友好提示 | 默认 10min；无错误识别 |
| `deliver` push 认证 | 用 GitLab token 走 `http.extraHeader` | 不传 token |
| `deliver` 失败 | 退到 `awaiting_commit` 允许重试，**不**退到 failed | 异常冒泡 |
| MR 已存在 | 走 update（iid + url 存在） | 不支持，每次都 create |
| MR 状态轮询 | `refreshMergeStatuses()`：60s 定时 + 焦点触发 | 无 |
| MR 状态变化事件 | 状态变更才发，避免 timeline 刷屏 | 无 |
| 自动 completed | 全部 merged 自动 `await_merge → completed` | 无 |
| 手动结束 | `manualCompleteTask()`，任意状态走 `await_merge → completed` | 无 |
| 交付重置 | `resetTaskDelivery()` 走合法出口 delivering → awaiting_commit | 无 |
| `autoCreateMergeRequests` | review 通过后自动提交 MR | 无 |
| Qoder Agent SDK | 完整 `runQoder` + `recordQoderMessage` + `qoderLogFile` + 多模型适配 | 无 |
| OCR bundled binary | `resolveBundledOcrBinary` + `createOcrRunner` | 仅 `process.env.OCR_BINARY ?? "ocr"` |
| Jira 同步 | `jira:import` / `jira:sync`（分页 100 页） / `atlassian:test` | 仅有 `jira-sync` 命令（旧版单页） |
| Jira 客户端 | `atlassianClient(jira\|confluence)` + `jiraKeyFrom` + `mcpPayload` | 内联在 `jira-sync` handler |
| Confluence | 支持 | 无 |
| 编辑器唤起 | `openTaskEditor`（vscode / qoder） | 无 |
| 任务删除清理 | `deleteTask` 清理 worktree + `worktrees/{taskId}` 目录 | 无 |
| `prepareTask` 失败恢复 | `failed → implementing` / `draft → confirmed → preparing` 全自动 | 仅 `task-start` 命令内联实现 |
| `modelProvider()` | qoder / openai 双模式 | 无 |
| `syncPiModelConfig` | 把 `modelProfile` 同步到 `models.json` | 无 |
| `shell:open-external` | 外部链接（http(s) 白名单） | 无 |

### 1.2 pi-package 已有的合理部分（保留）

- `evaluatePermission`（[permission.ts](file:///Users/robin/Documents/codingagent/packages/pi-package/src/permission.ts)）：与桌面端语义一致，**保留**。
- `DockerToolRouter`（[sandbox.ts](file:///Users/robin/Documents/codingagent/packages/pi-package/src/sandbox.ts)）：pi 特有的工具路由，**保留在 pi-package**。
- 任务命令骨架（`tasks` / `task-open` / `task-start` / `task-cancel` / `task-resume`）：保留结构，**业务编排改为调用下沉模块**。

### 1.3 已有可复用基础设施

- `@coding-agent/core`：`TaskStore`、`LocalFileKeyStore`、`transitionTask`、`boardColumnFor`、所有类型。
- `@coding-agent/integrations`：`GitService`（含 `--no-verify` / 90s / 网络错误识别）、`GitLabService`、`OpenCodeReviewService`（含 `delegate rule`）、`McpClient`、`DockerSandbox`。
- 状态机 `delivering` 出口：`["await_merge", "failed", "awaiting_commit"]`（[workflow.ts](file:///Users/robin/Documents/codingagent/packages/core/src/workflow.ts)）已正确支持回退。

---

## 2. 设计原则

1. **下沉而非复制**：所有"纯业务编排"逻辑（不依赖宿主运行时）下沉到 `integrations`。
2. **抽象层最小化**：只在两个宿主都需要的能力上抽接口（`TaskEventSink`、`SettingResolver`），能传 `TaskStore` 的地方不强行包装。
3. **Qoder 留在宿主**：Qoder SDK / Electron IPC / Pi ExtensionUI 等依赖宿主的逻辑**不**下沉。
4. **状态机不变**：所有改造**不**修改 `core/workflow.ts` 的状态转移表，回退出口已就绪。
5. **行为等价**：下沉模块的**行为**与桌面端当前实现一致，事件类型、字段、标题文案保持不变（便于复用测试断言）。

---

## 3. 抽象层（core 新增）

### 3.1 `core/src/event-sink.ts`

```ts
import type { AgentEvent } from "./types.js";

export interface TaskEventSink {
  /** 写入一条任务事件。 */
  addEvent(input: Omit<AgentEvent, "id" | "createdAt">): AgentEvent;
  /** 通知宿主"任务已变化"，便于 UI 重新拉取。 */
  emitChanged(taskId: string): void;
}
```

- desktop 实现：包 `addTaskEvent`（内部调 `store.addEvent` + `emitTaskChanged`）。
- pi-package 实现：包 `store.addEvent`，`emitChanged` 走 `ctx.ui.notify` 触发前端刷新（Pi 环境无 IPC 事件，依赖下次拉取）。

### 3.2 `core/src/setting-resolver.ts`

```ts
export interface SettingResolver {
  get(key: string): string | undefined;
  getSecret(key: string, envName?: string): string | undefined;
}
```

- desktop 实现：`SettingResolver` 接 `store` + `keyStore`。
- pi-package 实现：接 `store` + `keyStore`，完全等价。

### 3.3 `core/src/workflow.ts` 扩展（仅补充，不改转移表）

```ts
// 纯函数,无状态机变更
export function isReviewable(state: TaskState): boolean;     // ["implementing", "awaiting_review", "review_blocked"].includes(state)
export function isDeliverable(state: TaskState): boolean;    // ["awaiting_commit"].includes(state)
export function isMergeTrackable(state: TaskState): boolean; // ["await_merge"].includes(state)
export function blockingSeveritiesFor(level: "critical" | "high" | "medium"): string[];
```

---

## 4. integrations 新增模块

### 4.1 `integrations/src/review-orchestrator.ts`

**导出**：

```ts
export type Reviewer = (input: DelegateReviewerInput, taskId: string, model?: string) => Promise<string>;
export type DelegateReviewerInput = { repo: string; task: string; files: string[]; rules: string; diff: string };

export interface ReviewOrchestratorOptions {
  ocr: OpenCodeReviewService;          // 已下沉
  git: GitService;                     // 已下沉
  reviewer: Reviewer;                  // 调用方注入（Qoder 或 OpenAICompat）
  reviewBlockingLevel?: "critical" | "high" | "medium";
}

export class ReviewOrchestrator {
  constructor(private readonly opts: ReviewOrchestratorOptions, private readonly sink: TaskEventSink) {}
  async run(task: Task, repo: TaskRepository): Promise<ReviewResult>;
}

export function buildReviewPrompt(input: DelegateReviewerInput): string;
export function parseReviewResult(text: string): ReviewResult;

/** OpenAI 兼容实现,可直接由 desktop 与 pi-package 复用。 */
export class OpenAICompatReviewer implements Reviewer {
  constructor(private readonly resolver: SettingResolver, private readonly timeoutMs: number = 3 * 60_000) {}
  async call(input: DelegateReviewerInput, taskId: string, model?: string): Promise<string>;
}
```

**从 desktop 迁移**：

- `runDelegateReview` → `ReviewOrchestrator.run`
- `buildReviewPrompt` / `parseReviewResult` / `callOpenAICompatReviewer` → 顶层导出
- `callQoderReviewer` 留在 desktop（实现 `Reviewer` 接口）

**关键行为**：

- 每个子步骤发 `status` 事件（取文件 → 取 diff → diff 为空 → ocr rule → LLM 调用 → LLM 返回）。
- `runDelegateReview` 全部从 desktop 复制。
- LLM JSON 解析失败时抛 `Error`，由 `runTaskReview` 顶层 try/catch 统一处理（review_blocked）。

### 4.2 `integrations/src/merge-status.ts`

**导出**：

```ts
export type MergeRepoStatus = {
  repoId: string;
  repoName: string;
  mergeRequestIid: number;
  mergeRequestUrl?: string;
  state: "opened" | "merged" | "closed" | "error";
  error?: string;
};
export type MergeStatusSummary = {
  taskId: string;
  taskTitle: string;
  repos: MergeRepoStatus[];
  allMerged: boolean;
  taskCompleted: boolean;
};

export class MergeStatusRefresher {
  constructor(private readonly store: TaskStore, private readonly resolver: SettingResolver, private readonly sink: TaskEventSink) {}
  async refresh(): Promise<MergeStatusSummary[]>;
}

export class TaskCompleter {
  constructor(private readonly store: TaskStore, private readonly sink: TaskEventSink) {}
  /** 手动结束:任意 await_merge → completed,记录 MR 状态快照。 */
  manualComplete(taskId: string): void;
}
```

**从 desktop 迁移**：

- `refreshMergeStatuses` → `MergeStatusRefresher.refresh`
- `manualCompleteTask` → `TaskCompleter.manualComplete`
- `MergeRepoStatus` / `MergeStatusSummary` → 顶层导出

**关键行为**：

- 仅处理 `state === "await_merge"` 的 task。
- 状态变化才发事件（opened→closed=error, closed→merged=status, closed→opened=status, opened→merged=不发只走 auto-completed）。
- 全部 merged 自动 `await_merge → completed`，并发 status 事件"所有 MR 已合并,任务自动完成"。

### 4.3 `integrations/src/delivery.ts`

**导出**：

```ts
export class DeliveryService {
  constructor(
    private readonly store: TaskStore,
    private readonly git: GitService,
    private readonly resolver: SettingResolver,
    private readonly sink: TaskEventSink,
    private readonly approve: (task: Task, kind: "commit" | "push" | "merge_request", context: string) => Promise<boolean>
  ) {}
  /** 走完整 commit → push → MR,失败退到 awaiting_commit。 */
  async submitMergeRequests(taskId: string): Promise<void>;
  /** 重置 delivering → awaiting_commit,清 commitSha 与 mergeRequestState。 */
  resetDelivery(taskId: string): void;
}
```

**从 desktop 迁移**：

- `submitTaskMergeRequests` → `DeliveryService.submitMergeRequests`
- `resetTaskDelivery` → `DeliveryService.resetDelivery`
- `approve` 回调由宿主注入（desktop：GUI confirm；pi-package：Pi ExtensionUI confirm）。

**关键行为**（全部从 desktop 复制）：

- `git commit --no-verify`，"nothing to commit" 复用 HEAD。
- `git push` 90s 超时，token 走 `http.extraHeader`，网络错误友好提示。
- MR 已存在（iid + url）走更新路径，否则 create。
- 任何步骤失败：addTaskEvent(error) + 单独 try 退到 `awaiting_commit`（互不影响）。
- 全部成功：`awaiting_commit → await_merge`。

### 4.4 `integrations/src/jira-mcp.ts`

**导出**：

```ts
export function jiraKeyFrom(value: string): string;
export class AtlassianClientFactory {
  constructor(private readonly resolver: SettingResolver) {}
  create(kind: "jira" | "confluence"): McpClient;
}
export async function importJiraIssue(client: McpClient, keyOrUrl: string): Promise<Task>;
export async function syncJiraTasks(
  client: McpClient,
  jql?: string,
  pageSize?: number
): Promise<Task[]>;
export async function testAtlassianConnection(client: McpClient): Promise<{ ok: boolean; message: string }>;
```

**从 desktop 迁移**：

- `atlassianClient` → `AtlassianClientFactory.create`
- `jiraKeyFrom` / `mcpPayload` → 顶层导出
- `jira:import` → `importJiraIssue`
- `jira:sync`（分页 100 页）→ `syncJiraTasks`
- `atlassian:test` → `testAtlassianConnection`

**关键行为**：

- `jiraKeyFrom` 支持 Jira browse URL 解析。
- `mcpPayload` 抽到独立函数（无状态）。
- 分页逻辑保留 `next_page_token` + `start_at` 双轨。

### 4.5 `integrations/src/task-workflow.ts`

**导出**：

```ts
export class TaskWorkflow {
  constructor(
    private readonly store: TaskStore,
    private readonly resolver: SettingResolver,
    private readonly sink: TaskEventSink
  ) {}
  /** draft → confirmed → preparing → implementing,worktree 准备。 */
  prepare(taskId: string): Promise<Task>;
  /** 走完 review 流程:实现 → 等待审核 → review → await_commit | review_blocked。 */
  runReview(taskId: string, orchestrator: ReviewOrchestrator): Promise<void>;
  /** 重置 reviewing → review_blocked,清理 reviewStatus。 */
  resetReview(taskId: string): void;
  /** 编排器持有者:被 runReview 调用。 */
  isReviewEnabled(): boolean;
}
```

**从 desktop 迁移**：

- `prepareTask` → `TaskWorkflow.prepare`
- `runTaskReview`（编排部分） → `TaskWorkflow.runReview`
- `resetTaskReview` → `TaskWorkflow.resetReview`
- `reviewEnabled` → `TaskWorkflow.isReviewEnabled`

**关键行为**：

- 状态机推进：实现状态检查 → 委托 review → 异常 → review_blocked → 全部通过 → awaiting_commit。
- `runReview` 接受外部 `ReviewOrchestrator`，由宿主构造（避免循环依赖）。

### 4.6 `integrations/src/editor-launcher.ts`

**导出**：

```ts
export async function openTaskEditor(
  editor: "vscode" | "qoder",
  worktreePaths: string[],
  platform: NodeJS.Platform = process.platform
): Promise<void>;
```

**从 desktop 迁移**：

- `openTaskEditor` 内部用 `execa`（不直接 `execFile`，统一错误处理）。

### 4.7 `integrations/src/index.ts` 更新

```ts
export * from "./process.js";
export * from "./git.js";
export * from "./gitlab.js";
export * from "./mcp.js";
export * from "./review.js";
export * from "./docker.js";
export * from "./jira.js";
// 新增
export * from "./review-orchestrator.js";
export * from "./merge-status.js";
export * from "./delivery.js";
export * from "./jira-mcp.js";
export * from "./task-workflow.js";
export * from "./editor-launcher.js";
```

### 4.8 `core/src/index.ts` 更新

```ts
export * from "./types.js";
export * from "./db.js";
export * from "./crypto.js";
export * from "./workflow.js";
// 新增
export * from "./event-sink.js";
export * from "./setting-resolver.js";
```

---

## 5. 桌面端重构（`apps/desktop/electron/main.ts`）

### 5.1 新增宿主实现

```ts
class DesktopEventSink implements TaskEventSink {
  addEvent(input) { return store.addEvent(input); emitTaskChanged(input.taskId); return event; }
  emitChanged(taskId) { emitTaskChanged(taskId); }
}
class DesktopSettingResolver implements SettingResolver {
  get(key) { return store.getSetting(key); }
  getSecret(key, envName) {
    if (envName && process.env[envName]) return process.env[envName];
    return keyStore.resolve(store.getSetting(key), key);
  }
}
const desktopSink = new DesktopEventSink();
const desktopResolver = new DesktopSettingResolver();
```

### 5.2 替换映射

| 原内联函数 | 改为 |
|---|---|
| `buildReviewPrompt` / `parseReviewResult` / `runDelegateReview` / `callOpenAICompatReviewer` | 改为 `new ReviewOrchestrator({ ocr, git, reviewer: new OpenAICompatReviewer(desktopResolver) }, desktopSink).run(task, repo)` |
| `callQoderReviewer` | 保留为 `Reviewer` 实现，注入到 `ReviewOrchestrator` |
| `submitTaskMergeRequests` | 改为 `new DeliveryService(store, git, desktopResolver, desktopSink, approveForDesktop).submitMergeRequests(taskId)` |
| `resetTaskDelivery` | 改为 `new DeliveryService(...).resetDelivery(taskId)` |
| `refreshMergeStatuses` | 改为 `new MergeStatusRefresher(store, desktopResolver, desktopSink).refresh()` |
| `manualCompleteTask` | 改为 `new TaskCompleter(store, desktopSink).manualComplete(taskId)` |
| `prepareTask` | 改为 `new TaskWorkflow(store, desktopResolver, desktopSink).prepare(taskId)` |
| `runTaskReview` | 改为 `new TaskWorkflow(...).runReview(taskId, orchestrator)` |
| `resetTaskReview` | 改为 `new TaskWorkflow(...).resetReview(taskId)` |
| `atlassianClient` / `jiraKeyFrom` / `jira:import` / `jira:sync` / `atlassian:test` | 改为 `new AtlassianClientFactory(desktopResolver).create("jira")` + `importJiraIssue` / `syncJiraTasks` / `testAtlassianConnection` |
| `openTaskEditor` | 改为 `openTaskEditor(editor, paths)`（来自 integrations） |
| `deleteTask`（worktree 清理逻辑） | 保留，逻辑不在本次范围 |
| `getQoderStatus` / `runQoder` / `recordQoderMessage` / `qoderLogFile` | **保留**，Qoder 专属 |
| `createAgentSession` / Pi Session / 模型同步 | **保留** |

### 5.3 目标行数

- 重构前：`main.ts` ~1080 行。
- 重构后：~500-600 行（仅保留 Electron 协调、Pi Session、Qoder SDK、IPC、模型同步）。
- 旧 `main.ts` 末尾的 IPC handler **保留**（只换内部实现）。

### 5.4 desktop 的 `approve` 注入

```ts
const approveForDesktop: DeliveryServiceOptions["approve"] = async (task, kind, context) => {
  const approval = store.addApproval({ taskId: task.id, kind, context });
  const accepted = await requestUi<boolean>("confirm", { title: "提交确认", message: context });
  store.resolveApproval(approval.id, accepted ? "approved" : "rejected");
  return accepted;
};
```

> 注意：原 desktop 的 `submitTaskMergeRequests` **没有** confirm commit/push/MR（直接执行）；pi-package 的 `deliver` 才有 confirm 流程。本次为了**对齐行为**，在 `DeliveryService` 内部提供 `approve` 回调。**Desktop 改造时** 走默认行为（直接执行，不 confirm）；**pi-package 改造时** 注入 confirm。
>
> 设计决策：是否让 desktop 也走 confirm 流程？请用户在审阅时确认。

---

## 6. pi-package 重构（`packages/pi-package/src/index.ts`）

### 6.1 改造范围

- `evaluatePermission`：**保留**，不变。
- `DockerToolRouter`：**保留**。
- `tasks` / `task-open` / `task-resume` 命令：**保留**。
- `task-start` 命令：内联 prepare 逻辑 → 调用 `TaskWorkflow.prepare`。
- `deliver` 命令：旧实现（含 confirm 流程） → 注入 Pi confirm 到 `DeliveryService`。
- `review` 命令：旧实现（直接调 ocr） → 调用 `TaskWorkflow.runReview` + `ReviewOrchestrator`。
- `jira-sync` 命令：旧实现（单页） → 调用 `syncJiraTasks`。

### 6.2 新增命令（与 desktop 对齐）

| 命令 | 行为 |
|---|---|
| `/task-reset-review <id>` | 调 `TaskWorkflow.resetReview` |
| `/task-reset-delivery <id>` | 调 `DeliveryService.resetDelivery` |
| `/task-manual-complete <id>` | 调 `TaskCompleter.manualComplete` |
| `/task-refresh-mr` | 调 `MergeStatusRefresher.refresh`，把结果写到 timeline |

### 6.3 pi-package 的 EventSink / SettingResolver

```ts
class PiEventSink implements TaskEventSink {
  constructor(private readonly store: TaskStore, private readonly getActiveTaskId: () => string | undefined) {}
  addEvent(input) { const event = this.store.addEvent(input); /* Pi 无 IPC 推送 */ return event; }
  emitChanged(taskId) { /* Pi 无 IPC 推送;依赖下次拉取或 session_start */ }
}
class PiSettingResolver implements SettingResolver {
  get(key) { return this.store.getSetting(key); }
  getSecret(key, envName) {
    if (envName && process.env[envName]) return process.env[envName];
    return this.keyStore.resolve(this.store.getSetting(key), key);
  }
}
```

### 6.4 Qoder 走 review 注入？

- pi-package 当前没有 Qoder 集成。
- 本次不做 Qoder 在 pi-package 中的集成（仅 review 用 LLM 时走 OpenAI 兼容 + desktop 环境的 `modelProfile`，或 fallback 默认设置）。
- 如果需要 Qoder 走 review 路径，请用户在审阅时明确（涉及 SDK 在 pi-package 中的安装）。

### 6.5 pi-package 的 `approve` 注入

```ts
const approveForPi: DeliveryServiceOptions["approve"] = async (task, kind, context, ctx) => {
  const approval = store.addApproval({ taskId: task.id, kind, context });
  const accepted = await ctx.ui.confirm("业务节点确认", context);
  store.resolveApproval(approval.id, accepted ? "approved" : "rejected");
  return accepted;
};
```

---

## 7. 状态机与边界

### 7.1 状态机不变

`core/workflow.ts` 转移表已支持 `delivering → awaiting_commit`（[workflow.ts#L10](file:///Users/robin/Documents/codingagent/packages/core/src/workflow.ts#L10)），**不修改**。

### 7.2 异常边界

| 入口 | 异常处理 |
|---|---|
| `DeliveryService.submitMergeRequests` | 内部 try/catch；addTaskEvent(error) 单独 try；状态退到 awaiting_commit 单独 try；三者互不影响 |
| `TaskWorkflow.runReview` | 内部 try/catch → `reviewStatus: blocked` + `review_blocked`；不冒泡 |
| `MergeStatusRefresher.refresh` | 单个 repo 失败 → `state: "error"`；不阻断其他 repo |
| `ReviewOrchestrator.run` | 不 catch 异常，向上抛给 `TaskWorkflow.runReview` |

### 7.3 事件文案

所有事件标题、detail 文案**逐字保留** desktop 原版，保证 timeline 视觉一致。

---

## 8. 测试

### 8.1 现有测试

- `core/src/workflow.test.ts`（不修改）
- `core/src/db.test.ts`（不修改）
- `core/src/crypto.test.ts`（不修改）
- `integrations/src/integrations.test.ts`（不修改）
- `pi-package/src/permission.test.ts`（不修改）

### 8.2 新增测试

- `integrations/src/delivery.test.ts`：mock `GitService` + `TaskStore`，验证
  - `commit --no-verify` 调用
  - `push` 90s 超时
  - "nothing to commit" 复用 HEAD
  - 失败退到 awaiting_commit
  - MR 已存在走更新路径
- `integrations/src/merge-status.test.ts`：mock `GitLabService`，验证
  - 状态变化才发事件
  - 全部 merged 自动 completed
- `integrations/src/review-orchestrator.test.ts`：mock `Reviewer`，验证
  - diff 为空时跳过 LLM
  - ocr rule 失败走默认规则
  - 异常向上抛
- `pi-package/src/permission.test.ts`：**保留**（行为不变）

### 8.3 typecheck

```bash
npm run typecheck -w @coding-agent/core
npm run typecheck -w @coding-agent/integrations
npm run typecheck -w @coding-agent/pi-package
npm run typecheck -w @coding-agent/desktop
```

---

## 9. 风险与决策

### 9.1 已知风险

| 风险 | 缓解 |
|---|---|
| EventSink 抽象过度，调用栈变深 | 优先传 `TaskStore` + 直接调 `addEvent`；EventSink 只在"emit 通知宿主 UI"场景使用 |
| Reviewer 注入导致 Qoder 路径变复杂 | 明确接口；提供默认 `OpenAICompatReviewer`；调用方自行实现 `QoderReviewer` |
| `mcpPayload` 抽象在 jira-mcp 与 mcp 两处重复 | 抽到 `mcp.ts` 作为顶层 export |
| desktop 的 confirm 行为缺失 | 决策点 9.2.1 |
| pi-package 的 Qoder 集成 | 决策点 9.2.2 |

### 9.2 待用户决策

#### 9.2.1 desktop 的 `deliver` 流程是否要 confirm？

- 方案 A：保留 desktop 现状（直接执行，不 confirm commit/push/MR），`approve` 回调默认返回 `true`。
- 方案 B：让 desktop 也走 confirm（与 pi-package 一致），需要在前端加 3 次确认弹窗。
- **推荐 A**：desktop 已有按钮触发，UI 上更顺；confirm 留作 pi-package 交互差异。

#### 9.2.2 pi-package 是否需要 Qoder 集成？

- 方案 A：本次只做 Qoder reviewer 接口预留，pi-package 暂时用 OpenAI 兼容 + `modelProfile` 设置。
- 方案 B：pi-package 也集成 Qoder SDK。
- **推荐 A**：Qoder SDK 涉及大量改造（依赖、`runQoder` 整套、事件流），本次只同步非 Qoder 路径。

#### 9.2.3 pi-package 是否要新增 `reset-review` / `reset-delivery` / `manual-complete` / `refresh-mr` 命令？

- 方案 A：与 desktop 完全对齐，4 个命令都加。
- 方案 B：只加 `reset-review` / `reset-delivery`（用户最常在 Pi 里手动救火），`manual-complete` / `refresh-mr` 留待 desktop 独占。
- **推荐 A**：命令层成本低，行为对齐更重要。

---

## 10. 执行清单（按依赖顺序）

> 每步执行前会先 `TodoWrite` 同步状态。

### 阶段 1：core 抽象层

- [ ] 1.1 `core/src/event-sink.ts` + `core/src/setting-resolver.ts` + `core/src/workflow.ts` 扩展（isReviewable / isDeliverable / isMergeTrackable / blockingSeveritiesFor）
- [ ] 1.2 `core/src/index.ts` 导出
- [ ] 1.3 `core` 包 typecheck

### 阶段 2：integrations 业务模块

- [ ] 2.1 `integrations/src/review-orchestrator.ts`（含 OpenAICompatReviewer、buildReviewPrompt、parseReviewResult）
- [ ] 2.2 `integrations/src/merge-status.ts`（含 MergeStatusRefresher、TaskCompleter）
- [ ] 2.3 `integrations/src/delivery.ts`（含 DeliveryService、approve 注入）
- [ ] 2.4 `integrations/src/jira-mcp.ts`（含 AtlassianClientFactory、jiraKeyFrom、importJiraIssue、syncJiraTasks、testAtlassianConnection）
- [ ] 2.5 `integrations/src/task-workflow.ts`（含 TaskWorkflow、prepare、runReview、resetReview）
- [ ] 2.6 `integrations/src/editor-launcher.ts`
- [ ] 2.7 `integrations/src/index.ts` 导出
- [ ] 2.8 `integrations` 包 typecheck

### 阶段 3：integrations 新增测试

- [ ] 3.1 `integrations/src/delivery.test.ts`
- [ ] 3.2 `integrations/src/merge-status.test.ts`
- [ ] 3.3 `integrations/src/review-orchestrator.test.ts`
- [ ] 3.4 `integrations` 包测试

### 阶段 4：desktop 切换

- [ ] 4.1 引入 `DesktopEventSink` + `DesktopSettingResolver`
- [ ] 4.2 替换 `submitTaskMergeRequests` / `resetTaskDelivery` 为 `DeliveryService`
- [ ] 4.3 替换 `refreshMergeStatuses` / `manualCompleteTask` 为 `MergeStatusRefresher` / `TaskCompleter`
- [ ] 4.4 替换 `runTaskReview` / `resetTaskReview` / `prepareTask` 为 `TaskWorkflow`
- [ ] 4.5 替换 `runDelegateReview` / `callOpenAICompatReviewer` 为 `ReviewOrchestrator` + `OpenAICompatReviewer`；`callQoderReviewer` 实现 `Reviewer` 接口
- [ ] 4.6 替换 `atlassianClient` / `jiraKeyFrom` / `jira:import` / `jira:sync` / `atlassian:test` 为 jira-mcp 模块
- [ ] 4.7 替换 `openTaskEditor` 为 integrations 版本
- [ ] 4.8 `desktop` 包 typecheck
- [ ] 4.9 保留 Qoder / Pi Session / IPC / 模型同步

### 阶段 5：pi-package 切换

- [ ] 5.1 引入 `PiEventSink` + `PiSettingResolver`
- [ ] 5.2 替换 `task-start` 内联 prepare → `TaskWorkflow.prepare`
- [ ] 5.3 替换 `deliver` → `DeliveryService` + 注入 Pi confirm
- [ ] 5.4 替换 `review` → `TaskWorkflow.runReview` + `ReviewOrchestrator`（注入 OpenAICompatReviewer）
- [ ] 5.5 替换 `jira-sync` → `syncJiraTasks`
- [ ] 5.6 新增 `/task-reset-review` `/task-reset-delivery` `/task-manual-complete` `/task-refresh-mr` 命令
- [ ] 5.7 `pi-package` 包 typecheck + 测试

### 阶段 6：收尾

- [ ] 6.1 全部包 typecheck
- [ ] 6.2 全部包测试
- [ ] 6.3 复核 `permission.ts` 是否需要扩展（按 1.2 节保留判断）
- [ ] 6.4 更新本计划文件为"已完成"或拆分为 ADR

---

## 11. 验收标准

1. **行为等价**：desktop 与 pi-package 在 review / deliver / MR 状态 / Jira 同步 4 个流程上**行为一致**（事件文案、状态转移、错误处理）。
2. **不引入新依赖**：所有下沉使用已有的 `@coding-agent/core` / `@coding-agent/integrations` 类型。
3. **状态机不变**：`core/workflow.ts` 转移表 0 改动。
4. **测试通过**：4 个包 `typecheck` + `test` 全部 green。
5. **desktop `main.ts` 行数减少**：从 ~1080 行降到 ~500-600 行。
6. **pi-package `index.ts` 简化**：交付 / review / jira-sync handler 全部走模块调用，不再含内联业务逻辑。

---

## 12. 关联文件

- [packages/pi-package/src/index.ts](file:///Users/robin/Documents/codingagent/packages/pi-package/src/index.ts) — 当前实现（待重构）
- [packages/pi-package/src/permission.ts](file:///Users/robin/Documents/codingagent/packages/pi-package/src/permission.ts) — 保留
- [packages/pi-package/src/sandbox.ts](file:///Users/robin/Documents/codingagent/packages/pi-package/src/sandbox.ts) — 保留
- [packages/core/src/workflow.ts](file:///Users/robin/Documents/codingagent/packages/core/src/workflow.ts) — 状态机（不修改）
- [packages/core/src/db.ts](file:///Users/robin/Documents/codingagent/packages/core/src/db.ts) — TaskStore
- [packages/core/src/types.ts](file:///Users/robin/Documents/codingagent/packages/core/src/types.ts) — 类型
- [packages/integrations/src/git.ts](file:///Users/robin/Documents/codingagent/packages/integrations/src/git.ts) — GitService
- [packages/integrations/src/gitlab.ts](file:///Users/robin/Documents/codingagent/packages/integrations/src/gitlab.ts) — GitLabService
- [packages/integrations/src/review.ts](file:///Users/robin/Documents/codingagent/packages/integrations/src/review.ts) — OpenCodeReviewService
- [packages/integrations/src/mcp.ts](file:///Users/robin/Documents/codingagent/packages/integrations/src/mcp.ts) — McpClient
- [apps/desktop/electron/main.ts](file:///Users/robin/Documents/codingagent/apps/desktop/electron/main.ts) — desktop 端（待重构）
