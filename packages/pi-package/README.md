# @task-pipeline/pi-package

面向 [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的扩展包,把 TaskPipeline 的任务体系接入 Pi Agent 运行时。

## 模块

| 模块            | 职责                                                                 |
| --------------- | -------------------------------------------------------------------- |
| `index.ts`      | Extension 入口:注册任务工具、事件落库(`PiEventSink`)、Agent 会话接线 |
| `sandbox.ts`    | `DockerToolRouter`:工具调用路由到 Docker 沙箱执行                    |
| `permission.ts` | 工具权限评估                                                         |
| `plan-mode.ts`  | `PiAgentPlanModeProvider`:计划模式(含敏感环境变量过滤)               |

`package.json` 的 `pi.extensions` 声明了扩展入口 `./dist/index.js`。

## 运行方式

- **desktop 内**:由 Electron 主进程通过 `createRequire(import.meta.url).resolve('@task-pipeline/pi-package')` 加载,数据目录为 `<userData>/data`
- **独立运行**:数据目录默认 `~/.task-pipeline`(可用 `TASK_PIPELINE_DATA_DIR` 覆盖)

## 开发

```bash
npm run build -w @task-pipeline/pi-package
npm run test -w @task-pipeline/pi-package
```

同步上游 pi-coding-agent 版本时参见 [docs/pi-package-sync.md](../../docs/pi-package-sync.md)。
