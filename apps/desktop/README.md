# @task-pipeline/desktop

TaskPipeline 桌面应用,基于 Electron 37 + React 19 + Vite。

## 目录结构

```
├── electron/            # 主进程(TypeScript,产物 dist-electron/)
│   ├── main.ts          # 应用入口与 IPC 注册
│   ├── preload.cts      # preload 桥接
│   ├── agents/          # 专精 Agent 配置管理与生成
│   ├── chat/            # 聊天服务、驱动(OpenAI 兼容)与任务后端(Jira)
│   ├── memory/          # 记忆抽取与检索
│   ├── repowiki/        # 仓库知识索引
│   ├── task-agent/      # Qoder 任务 Agent 与计划模式
│   ├── trace/           # Agent 执行 Trace 记录与查询
│   └── ocr.ts           # OCR 能力
├── src/                 # 渲染进程(React)
│   ├── pages/CodingPage # 任务看板:Board / Timeline / 计划 / 审批 / 交付
│   ├── pages/TracePage  # Trace 列表与详情回溯
│   ├── pages/ChatPage   # 聊天页
│   ├── components/      # 通用组件(ai-elements 等)
│   └── api.ts           # preload API 封装
├── scripts/             # 构建辅助脚本(monorepo 拷贝、qodercli 拷贝)
└── qoder-bin/           # qodercli 二进制
```

## 常用命令

```bash
npm run dev          # Vite + tsc watch + Electron(由根目录 npm run dev 触发)
npm run build        # vite build + 主进程 tsc
npm run typecheck    # 渲染层 + 主进程类型检查
npm run test         # vitest
npm run package:mac  # 打包(其余变体见 package.json)
```

## 打包要点

- `prepackage*` 钩子执行 `scripts/copy-monorepo-packages.mjs`,将 `@task-pipeline/*` 工作区真实拷贝进本应用 `node_modules`,规避符号链接导致的 asar 越界错误
- `asarUnpack` 仅解包原生模块(.node、better-sqlite3)、qoder-agent-sdk(含 qodercli)与 OCR 平台包
- 产物输出到根目录 `release/`,命名 `TaskPipeline-<version>-<os>-<arch>.<ext>`

## 注意事项

- 渲染层禁止从 `@task-pipeline/core` 做值导入(会把 better-sqlite3 拖进浏览器 bundle),只允许 type-only 导入 + 本地常量
- Electron 主进程加载 `@task-pipeline/pi-package` 必须走 `createRequire(import.meta.url).resolve(...)`,不要写死相对路径
