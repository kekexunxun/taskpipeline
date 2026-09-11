# Task 任务板块 Qoder / CodeBuddy 插件化方案

## 背景与目标

TaskPipeline 当前是 Electron 桌面端 Coding Agent 工作台（Monorepo：desktop → pi-package → integrations → core）。本方案评估将 **Task 任务板块**（不含 Chat / Trace / Memory / CodeGraph 等周边能力）交付为 Qoder / CodeBuddy 插件，供用户在 CLI/IDE 环境中直接使用任务流水线能力。

结论先行：

- 插件模型是声明式扩展（Markdown Agent + MCP Server + Hook），不携带 UI 与重型运行时；
- Task 任务板块中 **Agent 提示词** 可直接提取复用；**状态机与 Git 编排** 通过可选 MCP Server 承载；
- 规则知识单独成 Skill、斜杠 Commands、领域 Agent 模板、Hooks 校验等均属非必要开销，**已砍除**；
- 所有 MCP 集成**防御性降级**：依赖的系统不存在即跳过，不强行执行。

## 参考文档

- Qoder 插件系统：<https://docs.qoder.com/zh/qoder/plugins>（页面路径与英文版 `docs.qoder.com/cli/plugins-reference` 一致）
- CodeBuddy 插件市场：<https://www.codebuddy.ai/docs/zh/cli/plugin-marketplaces>

## 一、两个插件平台的能力承载面

Qoder 与 CodeBuddy 插件系统高度同源（底层同一套扩展模型），均为**声明式、Markdown 驱动**：

| 组件类型                        | 格式                              | 说明                                      |
| ------------------------------- | --------------------------------- | ----------------------------------------- |
| Skills                          | `skills/<name>/SKILL.md`          | 领域知识 / 工作流模板                     |
| Agents                          | `agents/<name>.md`（frontmatter） | 专精子代理，可配 model / tools / maxTurns |
| Commands                        | `commands/<name>.md`              | 斜杠命令入口                              |
| Hooks                           | `hooks/hooks.json`                | 生命周期事件自动响应                      |
| MCP Servers                     | `.mcp.json` 或 plugin.json 内联   | 外部工具 / 服务能力                       |
| Output Styles / LSP / Workflows | —                                 | 输出风格、语言服务器、工作流              |

**关键约束：插件本身不携带运行时后端代码**（除 MCP Server 与 Hook 的 command/http 形式）。核心逻辑都通过 Agent 提示词 + MCP 工具编排。

### 两平台差异

| 维度              | Qoder                       | CodeBuddy                       | 对方案的影响                         |
| ----------------- | --------------------------- | ------------------------------- | ------------------------------------ |
| 插件清单          | `.qoder-plugin/plugin.json` | `.codebuddy-plugin/plugin.json` | 组件内容一致，仅清单目录不同         |
| Agent frontmatter | 基础字段                    | 含 `isolation: "worktree"`      | CodeBuddy 原生支持 worktree 隔离     |
| Hook 事件         | 标准集                      | 含 TaskCreated / TaskCompleted  | CodeBuddy 可与任务生命周期更紧密集成 |
| userConfig        | —                           | 支持敏感值 keychain 存储        | 凭证（GitLab Token 等）可安全存储    |
| 依赖声明          | 支持                        | 支持（版本解析 + 跨市场控制）   | 可依赖已有插件                       |

**结论**：组件完全复用，可同时向两个平台发布。

## 二、Task 板块能力清单与迁移判定

| 能力                                                 | 当前实现位置                                                                 | 承载方式                                             | 迁移成本 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- | -------- |
| 19 态状态机 + 看板列映射                             | `packages/core/src/workflow.ts` / `types.ts`                                 | task-state MCP Server 内实现校验                     | 中       |
| 任务工作流编排（prepare/validation/review/delivery） | `packages/integrations/src/task-workflow.ts`                                 | 部分进 MCP，部分由 Agent 提示词串联                  | 中       |
| 计划生成 / 审批 / 修订                               | `apps/desktop/electron/task/task-lifecycle.ts` §计划                         | **task-planner Agent**（提示词直接提取）             | 低       |
| 实现 + outcome 收尾判定                              | `apps/desktop/electron/task/task-readiness.ts`                               | **task-implementer Agent**（outcome 协议内嵌提示词） | 低       |
| Review（严重级 + 结构化 JSON）                       | `apps/desktop/electron/agents/agent-service.ts` `ROLE_AGENT_DEFAULTS.review` | **code-reviewer Agent**                              | 低       |
| 测试覆盖检测 + 用例生成                              | `agent-service.ts` `ROLE_AGENT_DEFAULTS.test`                                | **test-writer Agent**                                | 低       |
| MR 描述生成                                          | `agent-service.ts` `ROLE_AGENT_DEFAULTS.mr`                                  | **mr-writer Agent**                                  | 低       |
| 多 Agent 体系（仓库归属 / wiki 注入）                | `agent-service.ts` AgentService                                              | **不迁移**（CLI Agent 无此解析层）                   | —        |
| Git worktree / branch / diff                         | `packages/integrations/src/git.ts`                                           | git-ops MCP Server（worktree 可选）                  | 中       |
| MR 提交 + 合并状态跟踪                               | `packages/integrations/src/delivery.ts` + `merge-status.ts`                  | git-ops MCP Server（检测到 GitLab remote 才注册）    | 中       |

## 三、方案演进与精简决策

### 3.1 首轮全量方案（已否决）

最初方案包含 5 个承载面（Agents + Skills + Commands + Hooks + MCP Servers），并按以下原则精简：

| 砍除项                                                                   | 理由                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Skills（规则知识提取）**                                               | 状态机规则、review/outcome 协议等是"给 Agent 看的文档"，直接写进 Agent 提示词即可，单独成 Skill 是冗余开销 |
| **Commands（斜杠命令）**                                                 | 纯 Markdown 编排壳子，主 Agent 通过自然对话 + 调用子 Agent 即可完成，无需专门命令入口                      |
| **领域 Agent 模板**（java-backend / frontend-react / python-backend 等） | 用户自定义内容，不属于任务流水线核心                                                                       |
| **Hooks + scripts/**                                                     | outcome 标记协议已内嵌 Agent 提示词，PostToolUse 再校验属于过度设计                                        |
| **Jira 任务创建 Agent**                                                  | 外部集成，不属于任务流水线本身                                                                             |

### 3.2 精简原则

1. **只保留必要承载面**：Agents（核心交付物）+ 可选 MCP Servers。
2. **MCP 全部防御性接入**：启动时探测系统是否存在，不存在即跳过注册，不强行执行。
3. **Git worktree 为可选模式**：用户通过 userConfig 决定是否使用 worktree，不用则在当前目录直接操作。

## 四、精简方案

```
task-pipeline/
├── .qoder-plugin/
│   └── plugin.json
├── agents/
│   ├── task-planner.md          # 计划生成（只读，输出 JSON 计划）
│   ├── task-implementer.md      # 实现执行（含 outcome 标记协议）
│   ├── code-reviewer.md         # Code Review（结构化 JSON 输出）
│   ├── test-writer.md           # 测试用例生成
│   └── mr-writer.md             # MR 描述生成
└── mcp-servers/
    ├── task-state/              # 任务状态管理（JSON 文件持久化）
    └── git-ops/                 # Git 操作（worktree 可选，GitLab MR 可选）
```

### 4.1 Agents —— 核心交付物

5 个 Agent 提示词均从现有代码直接提取，工作流编排逻辑（何时调用哪个 Agent）写入主 Agent 提示词，不单独声明：

| Agent            | 提示词来源                                    | 关键协议                                                                                                                |
| ---------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------- |
| task-planner     | `task-lifecycle.ts` 计划生成段                | 只读模式 + JSON 输出：`{"outcome":"changes_required","plan":"..."}` / `{"outcome":"already_satisfied","summary":"..."}` |
| task-implementer | `task-readiness.ts` outcome 协议              | 执行 + 结尾输出标记：`<!-- task-pipeline-outcome:needs_input                                                            | already_satisfied | completed -->` |
| code-reviewer    | `agent-service.ts` ROLE_AGENT_DEFAULTS.review | 严重级 critical/high/medium/low + 严格 JSON comments 输出                                                               |
| test-writer      | `agent-service.ts` ROLE_AGENT_DEFAULTS.test   | 最小测试集、不改业务逻辑、测试可通过 testCommand 跑通                                                                   |
| mr-writer        | `agent-service.ts` ROLE_AGENT_DEFAULTS.mr     | JSON 格式：commitMessage / title / description                                                                          |

frontmatter 示例（按目标平台规范补充）：

```markdown
---
name: task-implementer
description: 任务实现 Agent，执行代码修改并在结束时标记执行结果
model: sonnet
maxTurns: 30
---
```

### 4.2 MCP Servers —— 全部可选、防御性执行

#### task-state：任务状态管理

- 职责：任务 CRUD + 状态流转 + 持久化（JSON 文件，不依赖 SQLite）
- 防御性：`tasks.json` 不存在则创建空结构，正常启动
- 工具：`create_task` / `update_task_state`（内部校验状态机合法性）/ `get_task` / `list_tasks` / `get_board`
- 降级行为：无该 MCP 时，Agent 在对话内跟踪任务，仅无持久化

#### git-ops：Git 操作

按探测结果分级注册工具：

```
启动探测：
  - git 命令不可用            → 不注册任何工具，跳过
  - 可用（基础工具恒注册）     → create_branch / changed_files / git_diff / run_command
  - userConfig.useWorktree=true → 额外注册 create_worktree / remove_worktree / merge_back
  - 检测到 GitLab remote       → 额外注册 create_merge_request / check_merge_status
```

- worktree 默认**不启用**；不启用时在用户当前目录直接建分支操作（对应桌面端"不使用 worktree 就在当前环境做"）
- run_command 承载 setup / lint / test / build 校验链
- 降级行为：无该 MCP 时，Agent 直接用 CLI 内置 Bash 工具操作 Git，仅缺结构化输出

### 4.3 plugin.json 骨架

```json
{
  "name": "task-pipeline",
  "version": "1.0.0",
  "description": "研发任务全生命周期管理：计划 → 实现 → 校验 → Review → 提交",
  "agents": "./agents/",
  "mcpServers": {
    "task-state": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/mcp-servers/task-state/index.js"],
      "env": { "TASK_DATA_DIR": "${user_config.task_data_dir}" }
    },
    "git-ops": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/mcp-servers/git-ops/index.js"],
      "env": { "USE_WORKTREE": "${user_config.use_worktree}" }
    }
  },
  "userConfig": {
    "task_data_dir": { "description": "任务数据存储目录（留空使用默认位置）", "sensitive": false },
    "use_worktree": {
      "description": "是否使用 Git worktree 隔离任务工作区（false 则在当前目录直接操作）",
      "sensitive": false
    }
  }
}
```

> `${PLUGIN_ROOT}` 为安装目录环境变量（CodeBuddy 为 `${CODEBUDDY_PLUGIN_ROOT}`）；`${user_config.KEY}` 为安装时用户配置。

## 五、与桌面端的能力差距

| 能力                             | 桌面端                       | 插件                      | 差距判定                    |
| -------------------------------- | ---------------------------- | ------------------------- | --------------------------- |
| 任务状态机                       | SQLite 持久化                | JSON 文件                 | 单用户场景无差异            |
| 计划生成                         | pi session / Qoder SDK       | Agent 提示词驱动          | 等价                        |
| 实现 + outcome 判定              | 正则解析 + 文件变更交叉验证  | Agent 提示词协议          | 交叉验证需 git-ops MCP 支撑 |
| Review                           | 多轮自动修订 + 阻断判定      | Agent 提示词 + 手动再触发 | 自动修订闭环弱化            |
| 测试生成                         | LLM 驱动 + 自动 commit       | Agent 提示词驱动          | 等价                        |
| Git worktree                     | 自动创建 / 清理              | userConfig 可选           | 降级为当前目录分支模式      |
| MR 提交 + 合并跟踪               | GitLab API + 轮询 + 自动完成 | 可选 MCP                  | 降级为手动                  |
| 看板 UI                          | React 实时看板               | `get_board` 文本输出      | 无 UI，数据可用             |
| Trace 回溯                       | 完整瀑布图                   | 无                        | 放弃                        |
| 对话 / HITL / Memory / CodeGraph | 完整能力                     | 无                        | 放弃（CLI 自身能力兜底）    |

## 六、工作量估算

| 模块                     | 内容                                            | 工时        |
| ------------------------ | ----------------------------------------------- | ----------- |
| 5 个 Agent Markdown      | 从现有代码提取提示词 + 适配 frontmatter         | 0.5 天      |
| task-state MCP           | JSON 持久化 + 状态机 + 5 个工具                 | 1.5 天      |
| git-ops MCP              | 分支/diff/命令 + 可选 worktree + 可选 GitLab MR | 2 天        |
| plugin.json + 双平台测试 | 清单 + 端到端验证                               | 0.5 天      |
| **合计**                 |                                                 | **~4.5 天** |

## 七、建议实施路径

1. **Phase 1（0.5 天）**：5 个 Agent Markdown + plugin.json 最小清单，本地目录安装验证提示词在 CLI Agent 下的执行效果（outcome 标记是否被主 Agent 遵循）。
2. **Phase 2（3.5 天）**：task-state + git-ops 两个 MCP Server，打通「创建 → 准备 → 实现 → 校验 → Review → 提交」闭环（当前目录模式先行，worktree 模式后补）。
3. **Phase 3（0.5 天）**：双平台发布（.qoder-plugin 与 .codebuddy-plugin 清单）、userConfig 完善、端到端回归。

开发期本地验证：`/plugin marketplace add ./my-marketplace` + `/plugin install task-pipeline@my-marketplace`（两平台命令同构）。
