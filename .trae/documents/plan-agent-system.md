# 计划：Agent 体系端到端落地（可配置多 Agent + 仓库绑定 + 模型路由）

## 1. 目标概述

解决「任务执行全部依赖通用大模型能力、公司部分仓库通用模型表现差」的问题：
通过**可配置的多个 Agent**（每个 Agent 携带领域系统提示词、工程约定、模型与 Provider 偏好），
在任务执行时为**每个关联仓库自动分配对应的 Agent**，把最匹配的领域知识注入 plan /
implementation / test_generation 全阶段，并按 Agent 偏好路由模型与执行路径。

命名约定：UI 与文档统一叫 **Agent**（不叫"专精 Agent"）；代码类型名用 `AgentProfile`
（避免与 `AgentSession` / task agent 等既有概念混淆）。

## 2. 现状摘要与调研结论

### 2.1 现状

- 任务执行走 `TaskAgentDriver` 抽象：唯一实现 `QoderTaskAgentDriver`（`qoder-task-agent.ts`），
  prompt 为 `memoryContext + 任务描述 + 阶段指令` 三段通用模板，无领域知识。
- 模型路由仅 `task.qoderModel`（任务级）→ 系统 `defaultModel`，无法按仓库路由。
- `MemoryService.taskMemoryContext` 注入记忆 + repowiki 命中（每条截断 300 字符、总量 4000）。
- `RepositoryProfile` 只有命令字段，无任何 Agent 绑定；执行路径由全局 `modelProfile` 决定
  （`modelProvider()` 返回 `"qoder" | "openai"`）。

### 2.2 Qoder SDK 与 AGENTS.md 调研结论（决定 AGENTS.md 处理策略）

对 `@qoder-ai/qoder-agent-sdk@1.0.16` 源码的核查结果：

1. **SDK 层完全不处理 AGENTS.md**：`dist/index.js` 中无任何 `AGENTS.md` / `instructions` 字符串。
2. SDK 的 `query()` 实际是 spawn `qodercli` 子进程代理执行，事件钩子表含 **`InstructionsLoaded`**，
   说明 **AGENTS.md 由底层 qodercli 运行时按 cwd 自动加载**，SDK 无法感知、无法关闭、无法透传替代。
3. SDK 的 `query()` options 中没有 instructions 相关字段，无法通过 SDK 显式注入指令文件。

**多仓库 workspace 形态**：任务多仓库时，每个仓库的 worktree 位于同一个任务 workspace 目录下
（`/workspaces/<task-id>/<repo-name>/`，见 `git.ts ensureWorktree` 的 `directoryName` 参数）；
Qoder SDK 执行时 `cwd = primary 仓库的 worktree`，其余仓库挂 `additionalDirectories`。
因此按 cwd 加载的 AGENTS.md 只会命中 **primary 仓库**（基于 `InstructionsLoaded` 钩子的推断，
P1 阶段用真实任务验证），其余仓库（非 primary）的 AGENTS.md 大概率不会自动加载。

**结论**：不做 `includeRepoAgentsMd` 自动拼接（避免与运行时自动加载重复注入、浪费 token、
规则优先级混乱）；改为**扩展 repowiki 索引器支持索引仓库根 AGENTS.md**，让每个仓库的
AGENTS.md 进入检索池按语义召回——primary 交给运行时，非 primary 用检索弥补。

### 2.3 用户确认的决策

| # | 决策 |
| --- | --- |
| 1 | `AgentProfile` 增加 `preferredProvider`，与 `preferredModel` 成对，标识模型提供者（qoder / openai / 自定义），并决定任务执行路径 |
| 2 | **不**在 `RepositoryProfile` 增加 `agentProfileId`；绑定改为 Agent 侧 `repositoryIds` 白名单；多仓库任务采用**多 Agent 模式**（每仓库独立解析） |
| 3 | 命名统一为「Agent」 |
| 4 | 去掉 `includeRepoAgentsMd`；repowiki 索引 AGENTS.md 作为替代 |
| 5 | resumeTask（Qoder 真实续接）不重新拼 Agent 上下文，与现有 `memoryContext` 的 resume 行为一致 |

## 3. 设计要点

### 3.1 数据模型（`packages/core/src/types.ts`）

```ts
/** 模型提供者标识；未配置表示跟随系统（inherit）。 */
export type AgentProvider = "qoder" | "openai" | string; // 自定义 provider id，如 "company-openai"

export type AgentProfile = {
  id: string;
  name: string;
  description?: string;
  /** 角色/领域系统提示词，注入所有阶段 prompt 的 Agent 段。 */
  systemPrompt: string;
  /** 工程约定，追加在 systemPrompt 之后。 */
  engineeringGuidelines?: string;
  /** 模型提供者 + 模型名，成对出现；未配置时跟随系统 modelProfile。 */
  preferredProvider?: AgentProvider;
  preferredModel?: string;
  /** 白名单绑定：适用仓库 id 列表。未绑定任何仓库的 Agent 不会自动命中。 */
  repositoryIds: string[];
  /** repowiki 文档路径白名单：命中这些路径的文档全文注入（不截断）。 */
  wikiIncludePaths?: string[];
  enabled: boolean;
  /** 内置模板标记，UI 提供"基于模板新建"入口。 */
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
};
```

存储方式与现有 `modelProfile` 一致：`store.setSetting("agentProfiles", JSON.stringify(AgentProfile[]))`，
**不新增 SQLite 表**。

### 3.2 仓库 → Agent 解析（多 Agent 模式）

任务多仓库时**不做强制单一绑定**，每个仓库独立解析：

```
resolveAgentFor(repositoryId)：
  1. 在所有 enabled 的 Agent 中，找 repositoryIds 包含该仓库的 Agent；
  2. 命中多个时按更新时间取最近修改的（或 UI 上限制一个仓库只能被一个 Agent 绑定）；
  3. 未命中 → 内置「通用」Agent（systemPrompt 为空 = 原行为，零配置兼容）。
```

内置「通用」Agent：`id = "builtin-general"`，`systemPrompt` 为空，`enabled = true`，不参与
列表展示（或置灰展示），任何仓库未绑定时回退到它。

### 3.3 模型与执行路径路由（preferredProvider 语义）

`AgentProfile.preferredProvider + preferredModel` 成对出现，用途是**标识模型来自哪个提供者**，
并据此决定任务走哪条执行路径（Qoder SDK 只能跑 qoder 模型，pi-coding-agent 只能跑
OpenAI 兼容模型，不区分就会出现"选了模型却跑不了"的问题）。

解析优先级链（任务启动时由 `AgentResolver.resolveRuntime(task, repos)` 计算一次）：

```
1. 任务显式指定 task.qoderModel → 沿用现有逻辑（qoder 路径）
2. primary 仓库 Agent 配置了 preferredProvider + preferredModel：
   provider = preferredProvider, model = preferredModel
3. 未配置 → 跟随系统 modelProfile（provider = modelProvider()，model = defaultModel）
```

- 执行路径：`provider === "qoder"` → `QoderTaskAgentDriver`；否则 → `startPi` + piSession 路径。
  `startTask` / `resumeTask` / `approveTaskPlan` / `reviseTaskPlan` 中的 `modelProvider()` 分支
  改为 `resolveRuntime(task).provider`。
- 启动校验：路由到 qoder 但 qoderToken 未配置 → 明确报错「Agent X 指定了 Qoder 模型，请先配置 Qoder Token」，
  不静默切换。
- 多仓库模型冲突：非 primary 仓库的 Agent 只贡献提示词段，不参与模型路由
  （一次 query 只有一个模型，以 primary 仓库为准，文档写明）。

### 3.4 Agent 上下文注入（核心）

`AgentResolver.resolveAgentContext(task, repos)` 返回 `{ sections: string[] }`，拼装规则：

```
## Agent 指引 — 仓库 <name>（<localPath 末级>）
<systemPrompt>
<engineeringGuidelines>
<wikiIncludePaths 命中的 repowiki 文档全文，按优先级截断>
```

- 每仓库一段、带仓库名前缀（Qoder 一次 query 只能一个 cwd，模型靠前缀把规则映射到对应目录）。
- 回退到「通用」Agent 的仓库不输出该段（空内容不占 token）。
- 截断优先级：`systemPrompt > engineeringGuidelines > wiki 全文`，总长上限 12k chars。
- 注入位置（全部在 prompt 最前，Agent 指引在 memoryContext 之前）：
  - `QoderTaskAgentDriver.runPlan` / `runImplementation` / `runTestGeneration`（**resume 路径不注入**，见 3.5）
  - main.ts piSession 路径的 plan / implementation / resume / approvePlan / revisePlan prompt
  - `callQoderReviewer`（Review 阶段，P1）

### 3.5 resume 规则（用户确认）

- **Qoder 路径**：`resumeSessionId` 存在时走 SDK 真实续接（`resume: sessionId`），会话上下文已包含
  原 Agent 指引，**不重新拼 Agent 上下文**（与现有 `const memoryContext = resumeSessionId ? undefined : ...`
  完全一致，一行代码即可）。
- **OpenAI 路径**：resume 是重新 prompt（piSession 重新起 session），**需要注入** Agent 上下文。

### 3.6 repowiki 扩展：索引仓库根 AGENTS.md

`repowiki/indexer.ts` 的 `collectRepoWikiDocs` 增加单文件候选：仓库根的 `AGENTS.md` /
`agents.md`（大小限制沿用 `MAX_FILE_BYTES`）。入库后按任务查询语义检索召回，解决
非 primary 仓库 AGENTS.md 不生效的问题，且不重复注入（仅命中时进 memoryContext）。

## 4. 详细文件级变更

### 4.1 `packages/core/src/types.ts`
- 新增 `AgentProvider` / `AgentProfile` 类型（见 3.1）。

### 4.2 `apps/desktop/electron/agents/agent-service.ts`（新）
```ts
export class AgentService {
  list(): AgentProfile[];
  save(profile: AgentProfile): void;
  delete(id: string): void;                       // 仅删除自身，仓库不受影响（绑定在 Agent 侧）
  resolveAgentFor(repositoryId: string): AgentProfile | undefined;  // 白名单解析，无命中返回 undefined
  resolveRuntime(task: Task, repos: TaskRepository[]): { provider: "qoder" | "openai"; model?: string };
  resolveAgentContext(task: Task, repos: TaskRepository[]): Promise<{ sections: string[] }>;
}
```

### 4.3 `apps/desktop/electron/agents/templates.ts`（新）
内置模板（`builtin: true`，复制生成新 Agent）：通用（空） / Java 服务端 / 前端 React+TS /
Python 数据后端 / 测试专精。每个模板提供 systemPrompt 骨架 + 变量占位符提示。

### 4.4 `apps/desktop/electron/task-agent/task-agent-driver.ts`
- `TaskAgentDeps` 增加 `resolveAgentContext?: (task: Task, repos: TaskRepository[]) => Promise<{ sections: string[] }>`。

### 4.5 `apps/desktop/electron/task-agent/qoder-task-agent.ts`
- `runPlan` / `runImplementation` / `runTestGeneration` 的 prompt 组装开头注入 agent sections；
- `const memoryContext = resumeSessionId ? undefined : ...` 同一条件约束 agent context（3.5）。

### 4.6 `apps/desktop/electron/main.ts`
- 实例化 `AgentService`（构造依赖 `store` + `memoryService`）。
- `startTask` / `resumeTask` / `approveTaskPlan` / `reviseTaskPlan`：`modelProvider()` 判定改为
  `agentService.resolveRuntime(task, repos).provider`；OpenAI 分支 prompt 注入 agent sections。
- `callQoderReviewer`：注入 primary 仓库 agent 上下文（P1）。
- 注册 IPC：`agents:list` / `agents:save` / `agents:delete`。

### 4.7 `apps/desktop/electron/repowiki/indexer.ts`
- `collectRepoWikiDocs` 追加仓库根 `AGENTS.md` / `agents.md` 单文件候选。

### 4.8 `apps/desktop/electron/preload.cts` + `apps/desktop/src/api.ts`
- 暴露 `listAgents` / `saveAgent` / `deleteAgent` + 浏览器 fallback（空列表 / 抛错）。

### 4.9 `apps/desktop/src/pages/CodingPage/components/SettingsDialog.tsx`
- Tab 列表新增 `agents`（「Agent」），位于「仓库」之后；
- Agent 卡片列表（复用 RepositoryCard 风格）：名称 / 描述 / 模型 badge（provider+model）/
  绑定仓库数 / 启用 Switch / 编辑 / 删除；
- 加载时 `api.listAgents()`，保存按钮仅保存通用设置（Agent 为即改即存，同记忆/仓库模式）；
- 挂载 `AgentDialog`。

### 4.10 `apps/desktop/src/pages/CodingPage/components/AgentDialog.tsx`（新）
- 名称 / 描述 / 系统提示词（Textarea，含变量占位符提示）/ 工程约定（Textarea）；
- 模型选择：Provider 下拉（跟随系统 / Qoder / OpenAI 兼容 / 自定义）+ 模型下拉
  （按 provider 过滤：qoder → `qoder.models`；openai → modelProfile 的 model；其余 → 手动输入）；
- 适用仓库多选（Checkbox，数据来自 `api.listRepositories()`）；
- 「基于内置模板新建」入口；
- 校验：`preferredProvider` 与 `preferredModel` 必须成对。

### 4.11 `apps/desktop/src/pages/CodingPage/components/RepositoryCard.tsx`（SettingsDialog 内）
- 显示该仓库命中的 Agent 名称徽章（数据由 `api.listAgents()` 反查）。

## 5. 数据/事件不变量

- Agent 配置存 settings key `agentProfiles`（JSON 数组），不需要 schema 迁移。
- 删除 Agent 不影响仓库配置（绑定在 Agent 侧，天然无级联清理）。
- 零配置时（无任何自定义 Agent）：所有仓库回退「通用」Agent，`resolveAgentContext` 返回空
  sections，prompt 与现状完全一致，既有测试全绿。
- 模型路由失败不静默：token 缺失 / 模型不在 provider 模型列表 → 明确错误事件 + 任务转 failed。
- 注入的 Agent 指引写入任务事件（`kind: "status"`，title「注入 Agent 上下文」），便于排查。

## 6. 测试与验证

1. `pnpm -w typecheck` 全量类型检查通过。
2. `pnpm -w test` 新增：
   - `agent-service.test.ts`：白名单解析（命中 / 未命中回退通用 / 多 Agent 冲突取最近修改）、
     `resolveRuntime` 优先级链（任务显式 > Agent > 系统）、删除 Agent 不影响仓库；
   - `qoder-task-agent` prompt 快照：非 resume 注入 sections、resume 不注入；
   - `indexer` 单测：AGENTS.md 进入候选文档集；
   - UI 组件测试：AgentDialog 校验（provider/model 成对）、SettingsDialog Agent Tab 渲染。
3. 手动回归（Electron）：
   - 配置「Java 服务端」Agent 并绑定一个仓库 → 启动该仓库任务 → Timeline 出现
     「注入 Agent 上下文」事件，Agent 指引在 prompt 最前；
   - 多仓库任务（仓库 A 绑定 Agent1、仓库 B 绑定 Agent2）→ prompt 出现两段带仓库名前缀的指引；
   - Agent 指定 preferredProvider=qoder + 模型 → 任务走 Qoder；切到 openai 的 Agent →
     primary 仓库任务改走 piSession 路径；
   - 任务失败 → resume → prompt 日志中**无**重复的 Agent 指引（Qoder 路径）；
   - 仓库根新增 AGENTS.md → 重建 repowiki 索引 → 命中文档数 +1。

## 7. 关键决策

1. **绑定在 Agent 侧（repositoryIds 白名单）**：用户确认。多仓库任务天然多 Agent 模式，
   每仓库独立解析；删除 Agent 无级联；UI 上「一个仓库可被多个 Agent 声明，取最近修改」。
2. **preferredProvider + preferredModel 成对 + 任务级执行路径路由**：用户确认
   「preferredProvider 主要表明当前选择的模型提供者，支持 Qoder SDK 后必须区分，否则只有
   model 会出问题」。任务启动时按 primary 仓库 Agent 的 provider 决定走 Qoder SDK 还是
   piSession 路径。
3. **AGENTS.md 不自动拼接**：基于 SDK 源码调研（SDK 不处理 AGENTS.md、qodercli 运行时按 cwd
   自动加载 + `InstructionsLoaded` 钩子）。避免重复注入；改用 repowiki 索引仓库根 AGENTS.md
   弥补非 primary 仓库空白。
4. **resume 不注入**：Qoder 真实续接（`resume: sessionId`）上下文已在会话内；与现有
   memoryContext 行为保持一致。
5. **不新增 SQLite 表**：Agent 配置进 settings JSON，与 modelProfile 同模式。

## 8. 范围外（明确不做）

- 不做运行时 AGENTS.md 行为验证实验之前的任何拼接假设（P1 先做实验确认 primary/多仓库行为）。
- 不做任务级 Agent 手动选择（TaskEditorDialog 三态），接口位留给 P2。
- 不做 Agent 导入导出 JSON（P2）。
- 不改 Qoder SDK；不新增依赖。

## 9. 实施顺序

1. **P0 — 核心闭环**：类型（4.1）→ AgentService + templates（4.2/4.3）→ driver 接线（4.4/4.5）
   → main.ts 路由 + IPC（4.6）→ preload/api（4.8）→ 设置 UI（4.9/4.10/4.11）→ 测试。
2. **P1 — 深度增强**：piSession 4 处 prompt 注入 + 抽公共 `buildAgentPrompt` → repowiki 索引
   AGENTS.md（4.7）→ Review 注入 → 真实任务验证 AGENTS.md 加载行为（primary/多仓库）。
3. **P2 — 高级能力**：内置模板扩充 → 导入导出 → 任务级 Agent 选择 → wikiIncludePaths 全文注入。

每步完成后跑 `pnpm -w test`，新增用例覆盖新逻辑。
