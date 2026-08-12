# Trace 系统重构计划（v2）—— 参考 Mastra 的四层架构

> 状态：**已实施完成（2026-08）**。实现细节见 [docs/trace-page-plan.md](docs/trace-page-plan.md)。
> 废弃并移除 pi-trace-extension；全量替换 events 表；一次任务执行 = 一个 Trace；
> 旧 Trace 数据与旧实现已全部清理。
>
> 原则：**采集端不再被动等外部插件，而是自研埋点统一收口**；中间层做「关联 + 脱敏 + 预计算」；
> 存储层 JSONL 先行、接口可切库；展示层重写为「仪表盘 + 瀑布图 + Payload Inspector」。

---

## 1. 背景与目标

### 1.1 为什么要重做（现状问题清单）

| #   | 现状问题                                                                                                                                                                                                                                           | 后果                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | 数据源碎片化：`events` 表 / `openai_events` 表 / `chats-v3` / `pi-session` / `pi-trace-extension events.jsonl` / qoder 原始 JSONL，六路解析器（`trace-service` / `pi-session-trace` / `pi-trace-events` / `qoder-trace` / `chat-entries`）各写各的 | 同一执行过程被切成多份，跨源合并全靠"按时间排序"拼凑 |
| 2   | 依赖社区插件 pi-trace-extension（`main.ts:1796-1807` 加载其 events.jsonl），采集端在本仓库外、格式不可控                                                                                                                                           | 插件一升级格式就变；未安装则主数据源缺失             |
| 3   | 展示是**扁平时间线**（`TraceDetail.tsx` 纵向列表），无瀑布图、无父子缩进的时间轴、无执行树                                                                                                                                                         | 10+ 工具调用的长链路无法一眼看清"谁调用了谁、卡在哪" |
| 4   | **无 Trace ID 关联**：多次 LLM 调用、工具调用是事件流，不是树                                                                                                                                                                                      | 无法回答"这次提问背后经历了哪些步骤、耗时分布"       |
| 5   | **脱敏不完整**：`redactSecrets` 只覆盖 `emitPi`/`sendTaskEvent` 两个出口；`recordPiMessage`（args/result）、`log.ts:414-448`（工具 input/output）原样入库                                                                                          | password / api_key 等敏感字段可能落盘                |
| 6   | 指标散落各处、展示层重复计算：cost 有的表有、有的表没有；耗时有的有、有的没有                                                                                                                                                                      | 列表页算一次、详情页又算一次，口径不一致             |
| 7   | 无仪表盘：列表页只有徽章，没有"今日请求数 / 平均耗时 / 总成本"汇总卡片                                                                                                                                                                             | 第一屏看不到全局                                     |

### 1.2 新架构总览（Mastra 风格四层）

```
┌─────────────────────────────────────────────────────────────────┐
│ ① 埋点层 Instrumentation（自研，两路 SDK 适配器）                    │
│    OpenAI/Pi：ai-sdk streamText 流 + Pi Agent 事件流               │
│    Qoder：SDKMessage 流（对话 + 任务）                              │
│    → 统一输出标准化 AgentSpan（start / update / end 生命周期）       │
├─────────────────────────────────────────────────────────────────┤
│ ② 总线/处理层 Bus/Processor                                        │
│    2.1 执行树关联：traceId + parentSpanId，一次用户提问一棵树        │
│    2.2 数据脱敏（关键）：入库前统一递归过滤敏感字段                    │
│    2.3 指标预计算：span 级 + trace 级 耗时 / tokens / cost           │
│    → 持久化 + live 推送（保留 task:event 实时通道）                  │
├─────────────────────────────────────────────────────────────────┤
│ ③ 存储层 Storage（接口抽象，可切换）                                 │
│    默认 JSONL：dataDir/traces/events/<traceId>.jsonl + info/<id>.json│
│    预留 DatabaseStorage（SQLite）                                   │
├─────────────────────────────────────────────────────────────────┤
│ ④ 展示层 Presentation（TracePage 重写）                             │
│    仪表盘 List/Dashboard → 瀑布图 Waterfall → Payload Inspector     │
│    看板 CodingPage Timeline / ChatPage 消费同一管道                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 数据模型与存储设计

### 2.1 AgentSpan（埋点层标准产物，`packages/core/src/trace/types.ts`）

```ts
type SpanType = 'session.start' | 'task.run' | 'agent.run' | 'llm.generate' | 'tool.execute' | 'subtask.run'
type SpanStatus = 'started' | 'running' | 'completed' | 'error' | 'cancelled'

type AgentSpan = {
  spanId: string // 全局唯一（traceId + seq，如 `evt-<traceId>-<seq>`）
  traceId: string // 一次用户提问 = 一个 Trace；任务路径 = 一次任务执行
  parentSpanId?: string // 执行树挂载点；undefined = 根 span
  type: SpanType
  name: string // 展示名：模型名 / 工具名 / 阶段名
  status: SpanStatus
  startedAt: number // epoch ms（瀑布图时间轴基准）
  endedAt?: number
  durationMs?: number // 预计算（2.3）
  input?: unknown // 已脱敏：LLM prompt / 工具参数 / user message
  output?: unknown // 已脱敏：completions / 工具原始结果
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheRead?: number
    cacheWrite?: number
    costUsd?: number
  }
  model?: string
  error?: { message: string; stack?: string }
  meta?: Record<string, unknown> // 保留 sdk 归属：subtaskId / parentTaskId / sdkSubtype / source / agentName
  sequence: number // trace 内写入序号
  createdAt: string
}
```

**关键设计**：

- 子任务字段（`meta.subtaskId / parentTaskId / sdkSubtype`）**必须保留** —— `SubTaskGroup.tsx:187-244` 折叠分组依赖它们，全量替换后前端仍要靠 `meta` 还原。
- `source`（`'pi' | 'qoder' | 'openai'`）进 `meta`，让列表可按 Agent 名/来源过滤（仪表盘需求）。

### 2.2 Trace 单元与执行树关联

| 路径               | Trace 边界                                             | 根 span                                                                                                       |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 对话（ChatPage）   | **一次用户消息 = 一个 Trace**                          | `session.start` → `llm.generate` / `tool.execute`                                                             |
| 任务（CodingPage） | **一次任务执行 = 一个 Trace**（创建/确认 → 完成/失败） | `task.run` → `agent.run`（planning/implementing/validating）→ `llm.generate` / `tool.execute` / `subtask.run` |

父 span 关联规则：

- Qoder：SDKMessage 的 `parent_tool_use_id`（顶层或 `message.message`）反查当前 span 栈 → 子工具/子 agent 自动挂到对应 `tool.execute` / `subtask.run` 之下；
- OpenAI/Pi：Pi Agent 事件的 `tool_execution_start/end` 天然成对，ai-sdk fullStream 的 `tool-call` → `tool-result` 成对，按 callId 挂到当前 `llm.generate` 之下；
- 无父信息时挂根（保证每棵树的根是 `session.start` / `task.run`）。

### 2.3 指标预计算

- span 级：`durationMs = endedAt - startedAt`；`usage.costUsd` 优先取 provider 返回值（Qoder `result.total_cost_usd`、Pi `getSessionStats().costUsd`），缺失时按内置模型单价表（`packages/core/src/trace/cost-table.ts`，按 model 前缀匹配，可配置）估算。
- trace 级（`TraceSummary`，`trace_end` 时算好落盘，展示层不再重复计算）：

```ts
type TraceSummary = {
  traceId: string
  kind: 'chat' | 'task'
  title: string // 用户提问摘要 / 任务标题
  agentName?: string
  model?: string
  status: 'success' | 'error' | 'running'
  startedAt: string
  endedAt?: string
  durationMs?: number // 总耗时
  tokens?: { input; output; total } // 总 Token
  costUsd?: number // 总成本
  spanCount: number
  errorCount: number
  toolStats?: Array<{ name: string; count: number; errors: number }>
  updatedAt: string
}
```

### 2.4 存储层（`packages/core/src/trace/storage.ts`）

```ts
interface TraceStorage {
  appendSpan(traceId: string, op: SpanOp, span: AgentSpan): void // op: 'start' | 'update' | 'end'
  finalize(traceId: string, summary: TraceSummary): void // trace 完成，写摘要
  getTrace(traceId: string): Promise<AgentSpan[] | undefined> // 详情（按 sequence 排序）
  listTraces(): Promise<TraceSummary[]> // 仪表盘（读 info/，不扫大文件）
  /** 预留：切换数据库时的等价实现 */
}
```

**JSONL 布局**（默认实现 `JsonlTraceStorage`，目录 `dataDir/traces/`，与旧目录同名但结构全新，旧文件由清理阶段删除）：

```
traces/
├── events/<traceId>.jsonl    每行 { op:'span_start'|'span_update'|'span_end', span }  追加写
└── info/<traceId>.json       完成时写入的 TraceSummary（列表/仪表盘直接读，避免扫大文件）
```

- 实时性：`appendSpan` 后同步 `sendTaskEvent({ type:'trace_span', ... })` 推送，前端看板/瀑布图增量更新。
- `running` 状态的 trace 在 `info/` 缺失，列表页标记 running（从 events 文件 mtime 兜底）。

---

## 3. 分阶段实施计划

### Phase 0 — 清理与骨架（0.5 天）

**清理（旧实现退役）**：

- `apps/desktop/electron/main.ts:1796-1807`：删除 pi-trace-extension 候选路径加载与 `additionalExtensionPaths` 追加。
- 删除解析器文件：`electron/trace/pi-trace-events.ts`、`pi-session-trace.ts`、`chat-entries.ts`、`qoder-trace.ts`（旧 JSONL 解析）、`trace-service.ts`（旧聚合）。
- 删除磁盘旧数据：`dataDir/traces/*`（qoder/qoder-chat 旧 JSONL）、`~/.pi/agent/traces`（pi-trace-extension 产物）、`~/.pi/agent/npm/pi-trace-extension`（插件包）。
- `main.ts:1673-1675` qoderTraceSink 落盘逻辑移除；`trace:list`/`trace:get` IPC 改为返回新管道空实现。

**骨架**：

- 新增 `packages/core/src/trace/`：`types.ts`（AgentSpan/TraceSummary）、`storage.ts`（接口 + `JsonlTraceStorage`）、`cost-table.ts`、`redact.ts`。
- 单测：JSONL 追加写/读、span 序列化、摘要 finalize。

**验收**：`npm run typecheck` 通过；旧 trace 页面无编译错误（新 IPC 空实现）；磁盘旧数据已清。

### Phase 1 — 埋点层 Instrumentation（1.5 天）

两路 SDK 适配器，统一产出 AgentSpan 生命周期：

| 适配器         | 接入点                                                                                                                                       | 产出                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| OpenAI/Pi 对话 | `chat/drivers/openai-chat-driver.ts:353` `streamText` fullStream：`text-delta`/`reasoning-delta`/`tool-call`/`tool-result`/`finish`(usage)   | `llm.generate`（start→update→end，input=prompt、output=completions、usage）与 `tool.execute` |
| OpenAI/Pi 任务 | `main.ts:1867` `session.subscribe(emitPi)`：`message_start/message_update/message_end/tool_execution_start/end/agent_start/end`              | 同上（任务 Trace 挂在 `agent.run` 下）                                                       |
| Qoder 对话     | `chat/drivers/qoder-chat-driver.ts:250` `onSdkMessage`                                                                                       | `llm.generate` / `tool.execute` / `subtask.run`                                              |
| Qoder 任务     | `task-agent/qoder-task-agent.ts:357-367` `onMessage`（复用 `log.ts` 的字段解析：usage/result.duration_ms/total_cost_usd/parent_tool_use_id） | 同上（挂 `task.run` → `agent.run`）                                                          |

- 实现方式：新建 `electron/trace/instrument/`（`openai-span-builder.ts`、`qoder-span-builder.ts`）+ 一个 `SpanEmitter`（持 TraceContext，负责生成 spanId、打时间戳、调 Bus）。
- 保留 `emitPi` 中**非写表**职责：`message_update` 规划文本累积（`activePlanText`）、`message_end` 错误标记（`activePlanError`）、`agent_end → finishImplementation` 状态机触发、`sendTaskEvent` live 推送。
- 单测：两个 builder 的 fixture 流 → 断言 span 序列正确、字段完整。

**验收**：对话/任务各跑一次，`traces/events/<traceId>.jsonl` 出现完整 span 流（llm/tool 成对、含 usage）。

### Phase 2 — Bus/Processor（1.5 天）

- **执行树关联** `electron/trace/bus/span-tree.ts`：TraceContext（`traceId` + span 栈）由 `SpanEmitter` 维护；`parent_tool_use_id` / 成对 callId 解析挂父；重放 events 文件时按 `parentSpanId` 重建树。
- **脱敏** `packages/core/src/trace/redact.ts`（升级现有 `redactSecrets`）：
  - key 名匹配（大小写不敏感）：`password` `passwd` `api_key` `apikey` `api-key` `token` `secret` `authorization` `auth` `credential` `private_key` `access_key` `bearer` `cookie` 等；
  - 值模式：`Bearer <token>`、JWT、sk- 前缀 key、长 base64/hex；
  - 递归处理 `input/output/meta/error` 全字段（JSON 树），替换为 `"[REDACTED]"`；
  - 保留长度/类型信息可选项（如 `"[REDACTED:32 chars]"`）。
- **指标预计算**：`trace/stats.ts`（span 级 + trace 级聚合，复用 Phase 0 的 cost-table）。
- **管线**：`SpanEmitter → Processor（脱敏→统计→finalize→live 推送）→ TraceStorage`。
- 单测：脱敏用例矩阵、树挂载（含无父兜底）、指标聚合对账。

**验收**：含 `api_key`/`password` 的输入输出落盘后为 `[REDACTED]`；summary 指标与手动对账一致。

### Phase 3 — 查询接口与 IPC（0.5 天）

- `electron/trace/trace-service-v2.ts`：`listTraces()`（读 info/，聚合仪表盘统计：今日请求数、平均耗时、总成本、按状态/Agent 过滤）、`getTrace(traceId)`（返回 span 树）。
- IPC：`trace:list` / `trace:get` 切到 v2；preload `preload.cts:96-97` 不变；`api.ts:456-457` 返回类型改为 `AgentSpan[]`/`TraceSummary[]`。

**验收**：Trace 页列表/详情走新数据，旧解析器文件已无引用。

### Phase 4 — 看板/对话切换（全量替换 events 表，2 天）★最大改动面

**移除写库点**（events 表 / openai_events 表 / trace_events 表停止写入）：

- `main.ts:319-322 addTaskEvent`、`main.ts:1546-1616 recordPiMessage`、`task-agent/log.ts` 的 `store.addEvent` 类调用、`main.ts:3193-3214/3310-3334` trace_events 两处、`updatePiUsage`（sessionUsage 改为由 Bus 指标写入）。
- `db.ts` 中 events/openai_events/trace_events 表定义保留（兼容旧库文件）但不再读写；**任务状态机、审批、`task.state` 流转不受影响**（它们由 workflow 层管理，事件通道仅作 UI 通知）。

**前端改读 span 树**：

- `api.ts:24-29 TaskDetail` 的 `events/openAiEvents` 改为 `spans: AgentSpan[]`（或保留 getTask 但由主进程从 span 树适配）；`pages/CodingPage/hooks/useTasks.ts:110-170`、`DetailPanel.tsx:132-136`、`Timeline.tsx` 同步。
- `Timeline.tsx` 增加 `span → TimelineItem` 适配层（`spanToTimelineItem`）：type 映射（`llm.generate`→thinking/message、`tool.execute`→tool_call+tool_result 合并行、`subtask.run`→子任务卡）；`meta.subtaskId/parentTaskId/sdkSubtype` 保持 `SubTaskGroup.tsx` 折叠逻辑可用。
- `ChatPage`：历史消息渲染不变（chats-v3 仍存消息本身）；**流式渲染不变**（DriverPart 通道保留）；新增"本条回答的执行树"入口（Trace 页跳转）。
- `planningEvent.ts` 按 title 过滤逻辑迁移到 span meta（`phase: 'planning'`）。

**验收**：看板执行 Tab、ChatPage 时间线、子任务折叠、实时推送全部走 span 树且行为一致；DB 不再新增 events 行。

### Phase 5 — 展示层重写 TracePage（2.5 天）

**5.1 仪表盘（`TraceList.tsx` / `index.tsx` 重写）**

- 顶部统计卡片：今日总请求数、平均耗时、总成本（$）（数据由 `trace:list` 聚合返回，前端不重复计算）。
- 列表列：Trace ID（缩写）、开始时间、总耗时、总 Token、状态（✅成功 / ❌失败 / 运行中）。
- 筛选：时间段（今天/本周）、状态（只看报错）、Agent 名称、模型、来源（Pi/Qoder）。
- 实时：`task:event` 订阅刷新（现有 `useTrace.ts:34-39` 机制保留）。

**5.2 瀑布图（`TraceDetail.tsx` 重写，核心）**

- 横向时间轴：根 span 起点为 0 基准，每个 span 一条色块（绝对定位），宽度 ∝ `durationMs`；hover 显示精确耗时（`Tooltip`，radix 已有）。
- 父子缩进：`agent.run` 下缩进 `llm.generate` / `tool.execute` / `subtask.run`，画树状连接线。
- 折叠/展开：根 span 默认展开、`llm.generate` 默认展开思考摘要、`tool.execute` 默认折叠（长链路一键折叠中间步骤，保留 `Collapsible` 语义）。
- 异常高亮：`status === 'error'` 色块红色 + 闪烁动画 + 错误数量角标。
- 颜色语义：`llm.generate`=紫、`tool.execute`=蓝、`subtask.run`=橙、error=红，深浅分 status。

**5.3 Payload Inspector（点击色块滑出面板）**

- 右侧/底部滑出（复用 `Sheet`/`Dialog` 或自建）：LLM 调用展示发送的 Prompt（可折叠）+ 模型返回 Completions；工具调用展示参数 + 原始结果 JSON（格式化高亮，`pre` + 语法高亮或简单转义）；成本标签（该 span 的 `usage.costUsd`，顶部累加）。

**验收**：长链路（10+ 工具）默认折叠、展开流畅；error span 高亮；点击任意 span 弹出详情且数据已脱敏。

### Phase 6 — 端到端验证与收尾（1 天）

- 全量 `npm run typecheck` / `npm run test` / `npm run lint`。
- 删除旧类型与残留：`core/src/types.ts` 中 `TraceEntry/TraceSummary/AgentEvent` 若不再被引用则迁移到新类型（保留 `Task`/`SessionUsage` 等业务类型）；`SubTaskGroup.tsx` 类型源切换。
- 文档：重写 `docs/trace-page-plan.md`（或标记废弃）、更新 README 的 trace 章节。
- 回归清单：对话/任务/看板/子任务折叠/实时推送/瀑布图/脱敏，逐项手动验证。

---

## 4. 关键风险与对策

| 风险                                               | 对策                                                                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全量替换 events 表牵动看板/详情/子任务折叠多处前端 | Phase 4 单独成阶段；`meta` 保留 subtaskId/parentTaskId/sdkSubtype；Timeline 适配层先行、逐步切换                                                    |
| 任务状态机 / 审批依赖事件通道                      | 明确边界：`task.state` 流转、Approval 由 workflow 层直接管理，不经过 events 表；`agent_end→finishImplementation`（main.ts:1677-1696）保留在事件通道 |
| 脱敏遗漏导致敏感数据落盘                           | 脱敏在 Bus 层统一执行（入库前唯一入口）；测试矩阵覆盖 key 名/值模式/嵌套结构                                                                        |
| 长链路 JSONL 文件大、列表变慢                      | 列表只读 `info/<traceId>.json`（预计算摘要），绝不整读 events 文件；文件按 traceId 隔离，单文件再大也只影响自身详情                                 |
| 实时性（看板流式刷新）                             | span 写入同步 live 推送（`task:event`），前端增量更新，保留现有 5s 去重策略                                                                         |
| 成本口径不一致                                     | provider 返回 cost 优先（Qoder/Pi 自带），缺省走内置单价表；预计算统一落 summary                                                                    |

## 5. 测试策略

- 单元：Storage（追加/读/摘要）、redact（矩阵）、span-tree（挂载/兜底）、stats（对账）、两个 builder（fixture 流）。
- 组件：TracePage 仪表盘/瀑布图/Payload（现有 `TracePage.test.tsx` 重写）、Timeline 适配层。
- 端到端（Phase 6 手动）：真实对话 + 任务各一条，验证落盘、脱敏、瀑布图、实时刷新。

## 6. 待定实现细节（默认方案，可调）

- cost 单价表初始值：按常用模型（gpt-4o/deepseek/qwen 等）硬编码 $/1K tokens，可被 `settings` 覆盖。
- 瀑布图交互：hover=Tooltip、点击=Sheet 滑出，均为 shadcn/radix 已有组件，不新增依赖。
- `traces/` 目录名沿用（旧文件已清），不引入新目录避免混淆。
