# @task-pipeline/integrations

TaskPipeline 的外部系统集成层,依赖 `@task-pipeline/core`,被 `pi-package` 与 `desktop` 共用。

## 模块

| 模块                                   | 职责                                         |
| -------------------------------------- | -------------------------------------------- |
| `git.ts` / `gitlab.ts`                 | Git 操作与 GitLab API                        |
| `jira.ts` / `jira-mcp.ts`              | Jira REST / Atlassian MCP 任务同步与导入     |
| `mcp.ts`                               | 通用 MCP(stdio)客户端                        |
| `review.ts` / `review-orchestrator.ts` | 代码评审(OpenCodeReview / OpenAI 兼容)与编排 |
| `merge-status.ts`                      | 合并请求状态刷新                             |
| `delivery.ts`                          | 交付闭环服务                                 |
| `task-workflow.ts`                     | 任务工作流编排(Jira 同步、任务完成器)        |
| `editor-launcher.ts`                   | 在 IDE 中打开任务工作区                      |
| `docker.ts` / `process.ts`             | Docker 与子进程工具                          |

## 开发

```bash
npm run build -w @task-pipeline/integrations
npm run test -w @task-pipeline/integrations
```
