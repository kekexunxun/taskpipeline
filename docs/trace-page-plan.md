# Trace 系统 v2 —— 架构与实现（参考 Mastra 四层）

> 状态：**已实施（v2 重构完成，2026-08）**
> 废弃：pi-trace-extension、pi-session 解析、events/openai_events/trace_events 作为 trace 数据源已全部移除；
> 一次用户提问 / 一次任务执行 = 一个 Trace，展示层为「仪表盘 + 瀑布图 + Payload Inspector」。
>
> 历史：v1（2026-08-07）基于 pi-trace-extension events.jsonl + 六路数据源聚合，已随 v2 重构整体删除。

---

## 1. 架构总览

```
① 埋点层 Instrumentation（自研，两路 SDK 适配器）
   OpenAI/Pi：ai-sdk streamText 流 + Pi Agent 事件流（emitPi）
   Qoder：SDKMessage 流（对话 qoder-chat-driver / 任务 qoder-task-agent）
   → 统一输出 AgentSpan（start / update / end 生命周期）

② 总线/处理层 Bus/Processor（TracePipeline）
   执行树关联：traceId + parentSpanId（span 栈自动挂父）
   数据脱敏：落盘前递归过滤 password / api_key / token / secret / Bearer 等
   指标预计算：span 级 durationMs/costUsd + trace 级 总耗时/总Token/总成本

③ 存储层 Storage（接口抽象，可切换）
   默认 JsonlTraceStorage：dataDir/traces/events/<traceId>.jsonl + info/<traceId>.json
   预留 TraceStorage 接口供 SQLite 等后端切换

④ 展示层 Presentation（TracePage）
   仪表盘（统计卡片 + 列表 + 筛选）→ 瀑布图 → Payload Inspector
   看板 CodingPage 执行 Tab 经 spansToAgentEvents 适配消费同一管道
```

## 2. 核心文件

| 层          | 文件                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| 类型/Schema | `packages/core/src/trace/types.ts`（AgentSpan/TraceSummary/TraceDashboardStats）                          |
| 存储        | `packages/core/src/trace/storage.ts`（TraceStorage 接口 + JsonlTraceStorage）                             |
| 脱敏        | `packages/core/src/trace/redact.ts`（redactSecretsDeep / redactSpan）                                     |
| 指标        | `packages/core/src/trace/stats.ts`（summarizeTrace）+ `cost-table.ts`（模型单价表）                       |
| Bus         | `apps/desktop/electron/trace/bus/trace-pipeline.ts`（TracePipeline）                                      |
| 适配器      | `apps/desktop/electron/trace/instrument/qoder-trace-builder.ts`、`pi-trace-builder.ts`                    |
| 查询        | `apps/desktop/electron/trace/trace-service.ts`（含 spansToAgentEvents 看板适配）                          |
| 展示        | `apps/desktop/src/pages/TracePage/**`（DashboardCards/TraceList/TraceFilters/Waterfall/PayloadInspector） |

## 3. 关键设计决策

- **Trace 单元**：一次用户提问 = 一个 Trace（对话，traceId=`chat-<chatId>-<msgId>`）；一次任务执行 = 一个 Trace（任务，traceId=`<taskId>`）。
- **执行树**：`parentSpanId` 栈顶自动挂载 —— llm.generate 下挂 tool.execute；subtask.run 下挂子 llm/tool；Pi 任务 tool 执行发生在 message_end 之后，父级为 agent.run。
- **脱敏时机**：TracePipeline.persist 统一出口（写盘前），input/output/meta/error 全字段递归；key 名匹配（password/api_key/token/secret/authorization…）+ 值模式（Bearer/sk-/JWT/私钥）。
- **指标预计算**：costUsd 优先 provider 显式返回（Qoder total_cost_usd / Pi sessionStats），缺失按内置单价表估算；trace 完成时 finalize 写 info/<traceId>.json，列表/仪表盘只读摘要不扫大文件。
- **实时性**：每条 span 写入同步 `sendTaskEvent({type:'trace_span'})`，TracePage 与看板增量刷新。
- **全量替换 events 表**：看板执行 Tab 改读任务 span 树（spansToAgentEvents 适配成 AgentEvent 形状，前端 Timeline 零改动）；events/openai_events/trace_events 停止写入；`DesktopEventSink`（workflow 层 review 评论收集）保留写库。

## 4. 测试

- `packages/core/src/trace/trace.test.ts`：存储/脱敏/成本/聚合（12 项）
- `apps/desktop/electron/trace/instrument/instrument.test.ts`：管线 + 两路适配器（9 项）
- `apps/desktop/electron/trace/trace-service.test.ts`：spansToAgentEvents 适配（5 项）
- `apps/desktop/src/pages/TracePage/TracePage.test.tsx`：展示层组件（5 项）
