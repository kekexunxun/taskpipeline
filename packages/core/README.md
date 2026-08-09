# @task-pipeline/core

TaskPipeline 的领域核心包,不依赖任何外部服务,被 `integrations` / `pi-package` / `desktop` 共同引用。

## 模块

| 模块                  | 职责                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `types.ts`            | 领域类型:Task、AgentEvent、AgentProfile、McpProfile、SessionUsage 等 |
| `db.ts`               | `TaskStore`:基于 better-sqlite3 的任务/事件/设置/Agent 持久化        |
| `workflow.ts`         | 任务状态机:`transitionTask`、`boardColumnFor` 等看板流转逻辑         |
| `memory.ts`           | 记忆的存储与检索                                                     |
| `crypto.ts`           | `LocalFileKeyStore` 等密钥/凭据加密存储                              |
| `event-sink.ts`       | `TaskEventSink` 抽象:事件落库 + 变更通知契约                         |
| `setting-resolver.ts` | 设置解析(任务级覆盖 → 全局设置)                                      |
| `plan-mode.ts`        | 计划模式抽象                                                         |

## 开发

```bash
npm run build -w @task-pipeline/core       # tsc 构建到 dist/
npm run test -w @task-pipeline/core        # vitest
```

## 注意

- 本包含 Node.js 原生依赖(better-sqlite3),**前端渲染层只能做 type-only 导入**,禁止值导入
