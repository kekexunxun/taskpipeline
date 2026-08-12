# TaskPipeline

TaskPipeline 是一个面向研发交付流程的桌面端 Coding Agent 工作台:以任务看板为核心,串联 Jira 任务导入、专精 Agent 编排、代码评审、合并状态跟踪与交付闭环,并提供完整的 Agent 执行 Trace 回溯能力。

## 仓库结构

Monorepo,基于 npm workspaces 管理:

```
├── apps/
│   └── desktop/              # @task-pipeline/desktop  Electron 桌面应用(主进程 + React 渲染层)
├── packages/
│   ├── core/                 # @task-pipeline/core          领域模型、SQLite 存储、工作流状态机
│   ├── integrations/         # @task-pipeline/integrations  Git/Jira/MCP/评审/交付等外部集成
│   └── pi-package/           # @task-pipeline/pi-package    pi-coding-agent 扩展(沙箱/权限/计划模式)
├── docker/                   # 沙箱镜像相关
├── docs/                     # 设计文档
└── .github/workflows/        # 发布流水线(macOS / Windows 打包)
```

依赖方向:`desktop` → `pi-package` → `integrations` → `core`。

## 技术栈

- **运行时**:Node.js(npm@10.9.8),Electron 37
- **前端**:React 19 + Vite 6 + Tailwind CSS 4 + Radix UI
- **存储**:better-sqlite3(任务、审批、记忆)+ 本地 JSONL(`dataDir/traces/`,Trace 执行树)
- **Agent 引擎**:@earendil-works/pi-coding-agent、@qoder-ai/qoder-agent-sdk
- **质量**:ESLint + Prettier + Stylelint + Husky + lint-staged + Vitest

## 开发

```bash
npm install          # 安装依赖并链接工作区
npm run dev          # 重编译原生模块后启动 Electron 开发环境
npm run build        # 按依赖顺序构建全部工作区
npm run typecheck    # 全工作区类型检查
npm run test         # 全工作区测试(先按 Node ABI 重编译 better-sqlite3)
npm run lint:all     # ESLint + Stylelint
```

> 开发/测试前会自动执行 `@electron/rebuild` 或 `npm rebuild`,确保 better-sqlite3 原生二进制与当前运行时 ABI 匹配。

## 打包发布

```bash
npm run package:mac    # macOS DMG/ZIP
npm run package:win    # Windows NSIS
npm run package:linux  # Linux AppImage
```

产物输出至根目录 `release/`。打包前 `prepackage` 钩子会把 `packages/*/dist` 拷贝进 `apps/desktop/node_modules/@task-pipeline/*`,规避 npm workspace 符号链接导致的 asar 越界问题。

正式版本通过 `.github/workflows/release.yml` 发布:推送 `v*` tag 后在 macOS(Intel/ARM)与 Windows runner 上自动打包并上传产物。

## 数据目录

- 桌面应用:macOS 为 `~/Library/Application Support/TaskPipeline/data/task-pipeline.db`(主进程已用 `app.setName('TaskPipeline')` 固定 userData,dev 与打包版一致;可用环境变量 `TASK_PIPELINE_DATA_DIR` 覆盖)
- pi-package 独立运行时:`~/.task-pipeline/task-pipeline.db`

## 文档

- [pi-package 同步说明](docs/pi-package-sync.md)
- [Timeline 子任务交接](docs/timeline-subtask-handoff.md)
- [Trace 页面规划](docs/trace-page-plan.md)
