# 计划：Trace 展示页面（最终版）

> 状态：**已实施（P0–P4 完成）**（2026-08-07）
> 目标：在左侧菜单新增 **Trace** 页面，聚合展示所有对话与任务的完整执行轨迹。实时采集层以社区插件 **pi-trace-extension**（新方案）为主，同时保留 Pi 官方 session 文件解析作历史兜底；前端统一时间线展示，下钻复用现有 `Timeline` 组件。
> 方案选择：**新方案（集成 pi-trace-extension）为主**。理由：零自研钩子、数据粒度更高（step 级延迟 / tokens / cost / stop reason / 完整 LLM payload / 子代理嵌套 / 文件变更聚合）、附带 Langfuse 风格 `trace.html` 查看器。代价是引入一个社区实验性依赖；通过"解析器按事件只增不改编写 + 插件缺失优雅降级"控制风险，插件随时可换可弃。

---

## 0. 实施记录（P0–P4 已完成）

| 阶段 | 交付 | 验证 |
|---|---|---|
| P0 | `TraceKind / TraceEntry / TraceSummary`（`packages/core/src/types.ts`）+ `TraceService` 骨架 | `tsc` 通过 |
| P1 | `trace/pi-session-trace.ts`（官方 session 解析）+ `trace-service.ts` ① events ② chats 聚合 | 单测 11 项全过 |
| P2 | `trace/pi-trace-events.ts`（events.jsonl 解析 + 事件映射 + D6 关联） | 单测含事件映射 / 关联 / 损坏行容错 |
| P3 | `main.ts` `additionalExtensionPaths` 追加 pi-trace-extension 入口，缺失静默降级 | typecheck 通过 |
| P4 | `trace:list / trace:get` IPC（preload + api.ts + demo）；ActionBar「Trace」项；`/trace`、`/trace/:kind/:traceId` 路由；TracePage（列表/筛选/详情复用 Timeline/useTrace 实时刷新） | 组件测试 3 项 + 手动走查待执行 |

实际新增文件：`apps/desktop/electron/trace/{trace-service,pi-session-trace,pi-trace-events}.ts`（+ `trace-service.test.ts`）、`apps/desktop/src/pages/TracePage/{index.tsx, TracePage.test.tsx, hooks/useTrace.ts, components/{TraceFilters,TraceList,TraceDetail}.tsx}`。
预存问题（与本任务无关，未处理）：`main.ts:709/715` `event possibly undefined`、`qoder-task-agent.ts` hooks 类型不匹配、前端 `ai-elements/*` 若干类型错误、若干文件 prettier 格式不一致（stash 验证均为改动前已存在）。

---

## 1. 背景与现状

应用为 Electron + React 桌面编码 agent（monorepo：`apps/desktop` + `packages/{core,integrations,pi-package}`），Pi（`@earendil-works/pi-coding-agent`）以 SDK 内嵌方式在 `apps/desktop/electron/main.ts` 的 `startPi()` 中运行任务 agent。

### 1.1 现有数据源

| 数据源 | 位置 | 内容 | 现状 |
|---|---|---|---|
| ① 任务 + 事件 | SQLite `task-pipeline.db`：`tasks` / `events` 表 | 任务元数据 + 执行事件（`kind: message/tool/permission/command/diff/review/error/status`） | 已有，`store.listEvents(taskId)` |
| ② 对话 | `dataDir/chats-v3/chat-*.json` + `index.json` | 每条消息 `{id, role, createdAt, driverId, raw}` | 已有，`ChatStorage.listMetas/getConversation` |
| ③ Pi 官方 session | `dataDir/pi-sessions/*.jsonl`（JSONL v3，`SessionHeader` + 条目树） | 对话视角的完整会话流 | 已有，任务 `pi_session_path` 指回 |
| ④ pi-trace 事件 | `~/.pi/agent/traces/<session-id>/events.jsonl`（追加式 JSONL） | **执行视角** trace：`session → interaction → turn → step(llm) + tool` 树，含延迟/tokens/cost/payload/子代理 | 需接入（本计划 P2/P3） |

### 1.2 已核实的关键事实

- 左侧菜单：`apps/desktop/src/layout/ActionBar.tsx` 硬编码 `items`（对话 / 编码）；路由在 `AppShell.tsx:26-32`（`/chat`、`/coding`，均支持 `:id`）。
- 任务详情已复用时间线组件 `apps/desktop/src/pages/CodingPage/components/Timeline.tsx`（去重、折叠、review 评论渲染），Trace 详情直接复用它。
- Pi 实时事件管道：`main.ts:910` `emitPi()` → `task:event` IPC → 前端 `api.onTaskEvent()`（`preload.cts:46`、`useTasks.ts:100` 已有订阅先例）。
- 前端 IPC 桥：`preload.cts`（invoke 列表）+ `apps/desktop/src/api.ts`（`window.agentApi ?? demo`，demo 在 `api.ts:258`）。
- pi-trace-extension（npm `pi-trace-extension` v0.1.13，MIT，社区）：
  - 订阅 Pi 生命周期事件，本地落盘 `~/.pi/agent/traces/<session-id>/events.jsonl` + 自动生成 `trace.html`（Langfuse 风格单文件查看器）与跨会话 `index.html` dashboard。
  - 事件类型（v2，已读源码确认）：`session_start / interaction_start / turn_start / turn_end / step_start / llm_request / llm_response / step_end / tool_start / tool_end / file_change / turn_summary / session_shutdown`。每条事件含 `ts / sessionId / turnIndex / stepIndex`，**无 taskId**；长字符串截断 8KB，敏感 key 掩码。
  - 加载方式（本项目可用）：① `pi install npm:pi-trace-extension` 装到 `~/.pi/agent/npm/`，`DefaultResourceLoader` 自动发现 `~/.pi/agent/extensions/` 下 `*/index.ts`（已核实 `package-manager.js` `collectAutoExtensionEntries`）；② 更稳：`main.ts:1014` 的 `additionalExtensionPaths` 显式追加其入口（与现有 pi-package 同机制）。
  - 依赖：pi-agent ≥ 0.79、Node ≥ 18；`trace.html` 渲染需要 Python ≥ 3.8（可用 `PI_TRACE_PYTHON` 覆盖）——本项目展示不依赖 Python（TS 直接解析 events.jsonl）。

---

## 2. 决策记录（D）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 实时采集实现方式 | **集成 pi-trace-extension**（读取其 events.jsonl），不再自研钩子；备选：若插件不可用，退化为自写钩子（`packages/pi-package` 内）落同构 JSONL |
| D2 | 页面聚合范围 | 任务（events 表）、对话（chats-v3）、Pi 会话（官方 session + pi-trace events）统一进入一个 Trace 页面，按类型/时间筛选，下钻详情 |
| D3 | 归一化模型 | 新增 `TraceKind / TraceEntry / TraceSummary`（放 `packages/core/src/types.ts`），所有源映射为统一 `TraceEntry[]` |
| D4 | 详情渲染 | 复用 `Timeline.tsx`（映射 `TraceEntry → TimelineItem`），不新写时间线组件 |
| D5 | 实时刷新 | 复用现有 `onTaskEvent` 推送 + 页面轮询 `trace:list` 兜底，不新增推送通道 |
| D6 | 任务 ↔ Pi 会话关联 | `pi_session_path` basename（session 文件名即 sessionId）优先；时间窗（±5min）+ cwd 过滤兜底；匹配失败归入独立 "Pi 会话" 展示 |
| D7 | 插件缺失/升级 | 解析器按"未知事件类型优雅跳过"编写；P3 加载失败仅降级数据源④，页面不塌 |

---

## 3. 总体架构

```
                    ┌──────────── 数据源（四路）─────────────┐
                    │ ① tasks + events 表（SQLite）           │
                    │ ② chats-v3（对话 JSON）                 │
                    │ ③ pi-sessions/*.jsonl（官方，历史兜底） │
                    │ ④ pi-trace-extension events.jsonl（主） │
                    └──────────────┬────────────────────────┘
                                   ▼
              TraceService（主进程·聚合 + 归一化为 TraceEntry[]）
                                   ▼
        IPC：trace:list / trace:get   +   复用 task:event 实时刷新
                                   ▼
       TracePage（前端）
         ├─ 列表：TraceSummary[]（类型/时间/关键词筛选）
         └─ 详情：TraceDetail（复用 Timeline.tsx）
              └─ 增值："打开 trace.html"（shell:open-external）
```

---

## 4. 数据模型（代码级）

新增到 `packages/core/src/types.ts`：

```ts
export type TraceKind = "task" | "chat" | "pi_session";

export type TraceEntryType =
  | "session_start" | "session_end" | "message" | "thinking"
  | "tool_call" | "tool_result" | "status" | "error" | "review" | "diff";

export type TraceEntry = {
  id: string;                 // 全局唯一：`${source}-${traceId}-${seq}`
  traceId: string;            // taskId / chatId / piSessionId
  kind: TraceKind;
  type: TraceEntryType;
  title: string;
  detail?: string;
  payload?: unknown;          // 原始数据（Pi 消息 / SDK raw / events.jsonl 事件）
  createdAt: string;
  source: "events" | "chat" | "pi" | "pi_trace";
};

export type TraceSummary = {
  traceId: string;
  kind: TraceKind;
  title: string;              // 任务标题 / 对话标题 / session 文件名
  createdAt: string;
  updatedAt: string;
  entryCount: number;
  state?: string;             // 任务状态 / 对话状态
  stats?: { turns?: number; tokens?: { input: number; output: number; total: number }; costUsd?: number };
  lastEntry?: Pick<TraceEntry, "type" | "title" | "createdAt">;
  traceHtmlPath?: string;     // ④ 存在 trace.html 时给出（P5 增值用）
};
```

---

## 5. 数据源归一化规则

### 5.1 ① 任务（events 表）→ TraceEntry

`store.listEvents(taskId)` 直映射，`kind` 字段一一对应（message/tool/permission/command/diff/review/error/status），`source: "events"`。列表 summary 来自 `tasks` 表（`store.listTasks()`）+ `listEvents` 计数与首尾时间。

### 5.2 ② 对话（chats-v3）→ TraceEntry

`chatStorage.getConversation(id)`，每条 `StoredMessageRecord` 按 `driverId` 拆 `raw`：
- qoder：`thinking / tool-use / tool-result / text / session`
- openai：`tool-call / tool-result / text`

复用 `apps/desktop/src/pages/ChatPage/drivers/*` 的 part 提取逻辑（提取为共享纯函数，主进程侧用）。`source: "chat"`。

### 5.3 ③ Pi 官方 session（pi-sessions/*.jsonl）→ TraceEntry

用 `@earendil-works/pi-coding-agent` 的 `loadEntriesFromFile` / `SessionManager.list()` 解析，映射：
- `session` 头 → `session_start`
- `message` 条目 → `message`（user/assistant）、`thinking`（reasoning 部分）
- `custom` 条目 → 按内容映射 `status` / `tool_call` / `tool_result`
- 统计：`getSessionStats()` 或自算（tokens/cost/turns）

`source: "pi"`。此路为历史兜底（未装插件时仍有完整会话流）。

### 5.4 ④ pi-trace events.jsonl → TraceEntry（核心新增）

新增 `apps/desktop/electron/trace/pi-trace-events.ts`，读取 `~/.pi/agent/traces/*/events.jsonl`，按行解析。事件映射：

| events.jsonl 事件 | TraceEntry type | title / detail 说明 |
|---|---|---|
| `session_start` | `session_start` | sessionId、cwd |
| `interaction_start` | `message` | prompt 摘要；payload 含 skillsLoaded、slashCommand、imagesCount |
| `turn_start` / `turn_end` | `status` | "Turn N 开始 / 结束"，含 durationMs |
| `step_start` / `llm_request` | `thinking` | "LLM 调用（step N）"；payload 只取 model + tools 名，不展开 messages（防卡） |
| `llm_response` | `status` | status、耗时、rateLimit（429 重试） |
| `step_end` | `message` + `thinking` | text 拆为 message，thinking 拆为 thinking；usage/stopReason/errorMessage 进 payload |
| `tool_start` / `tool_end` | `tool_call` / `tool_result` | title=toolName；detail=args / resultPreview（截断）；payload 含 durationMs、isError、subagent 嵌套信息 |
| `file_change` | `diff` | path + op（write/edit/delete） |
| `turn_summary` | `status` | 汇总：filesChanged、toolsUsed、tokens、cost、finalText |
| 含 `errorMessage` / `isError=true` | `error` | 错误详情 |
| 未知类型 | 跳过（不解析、不报错） | 兼容插件版本升级 |

**列表 summary 策略（防大文件卡顿）**：只读 `events.jsonl` 首行（`session_start`，取 sessionId/ts）+ 文件 mtime/大小估算 entryCount；详情页按需全量读取。目录扫描用 `fs.readdirSync` 过滤 `.html`/`subagents/` 等非事件文件。

### 5.5 任务 ↔ sessionId 关联（D6）

1. 遍历 `tasks` 表，取每条 `pi_session_path` 的 basename（session 文件名）→ 匹配 `traces/<session-id>`；
2. 未命中者按时间窗（±5min）匹配 events.jsonl 的 `session_start.ts`，同窗口取最接近者；
3. 仍失败 → 作为独立 `pi_session` 类型展示，不与任何任务绑定。

---

## 6. Pi 插件接入（P3）

### 6.1 安装与加载

```bash
pi install npm:pi-trace-extension   # 装到 ~/.pi/agent/npm/pi-trace-extension/
```

`apps/desktop/electron/main.ts` `startPi()`（:1013-1014）追加显式加载（与自动发现双保险）：

```ts
const extension = join(__dirname, "../../../packages/pi-package/dist/index.js");
const traceExtension = join(homedir(), ".pi", "agent", "npm", "pi-trace-extension", "extensions", "trace", "index.ts");
const additionalExtensionPaths = existsSync(traceExtension)
  ? [extension, traceExtension]
  : [extension];
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths });
```

- `agentDir` 可被 `piAgentDir` 设置覆盖（`main.ts:1007`），trace 目录路径需与插件实际输出一致（默认 `~/.pi/agent/traces/`；若用户自定义 agentDir，TraceService 从 `store.getSetting("piAgentDir")` 推导，找不到时优雅跳过）。
- 缺失/加载失败：仅数据源④不可用，其余三路照常，页面正常展示并提示"Pi 执行 trace 未启用"。

### 6.2 验证

启动任意任务 → 观察 `~/.pi/agent/traces/<session-id>/events.jsonl` 持续增长；`session_shutdown` 后同目录出现 `trace.html`。

---

## 7. 后端实现（主进程）

### 7.1 新模块

```
apps/desktop/electron/trace/
├── trace-service.ts        # 聚合四路数据源 → TraceSummary[] / TraceEntry[]（内存态，不建新表）
├── pi-session-trace.ts     # ③ pi-sessions/*.jsonl 解析（loadEntriesFromFile）
└── pi-trace-events.ts      # ④ pi-trace events.jsonl 解析（核心）
```

`TraceService` 接口：

```ts
class TraceService {
  constructor(store: TaskStore, chatStorage: ChatStorage, dataDir: string, agentDir: string) {}
  listSummaries(): TraceSummary[];      // 聚合 + 按 updatedAt 排序 + 类型/时间过滤
  getTrace(traceId: string, kind: TraceKind): TraceEntry[];  // 单条完整轨迹
  resolveSessionOwner(sessionId: string): string | undefined; // D6 关联
}
```

### 7.2 IPC

- `apps/desktop/electron/preload.cts`：
  ```ts
  listTrace: () => ipcRenderer.invoke("trace:list"),
  getTrace: (kind: string, traceId: string) => ipcRenderer.invoke("trace:get", kind, traceId),
  ```
- `apps/desktop/electron/main.ts` `registerIpcHandlers`：
  ```ts
  ipcMain.handle("trace:list", () => traceService.listSummaries());
  ipcMain.handle("trace:get", (_e, kind: TraceKind, traceId: string) => traceService.getTrace(traceId, kind));
  ```
- `apps/desktop/src/api.ts`：`AgentApi` 接口加两方法 + demo 实现（`api.ts:258` 处补空实现：`listTrace() { return []; }`、`getTrace() { return []; }`）。
- 实时刷新：不新增通道，Trace 页订阅现有 `api.onTaskEvent()`（D5）。

### 7.3 TraceService 生命周期

- 随主进程初始化一次（依赖 `store`、`chatStorage`、`dataDir`、`agentDir`）。
- `listSummaries` 每次调用实时聚合（数据量可控；若卡顿再引入目录索引缓存 + mtime 失效）。

---

## 8. 前端实现

### 8.1 菜单与路由

- `apps/desktop/src/layout/ActionBar.tsx`：`items` 追加 `{ label: "Trace", to: "/trace", icon: ActivityIcon }`（`lucide-react` 已有）。
- `apps/desktop/src/layout/AppShell.tsx`：
  ```tsx
  const TracePage = lazy(() => import("../pages/TracePage/index"));
  <Route path="/trace" element={<TracePage />} />
  <Route path="/trace/:kind/:traceId" element={<TracePage />} />
  ```

### 8.2 页面结构

```
apps/desktop/src/pages/TracePage/
├── index.tsx                  # 页面骨架：路由参数 → 列表 + 详情两栏
├── hooks/useTrace.ts          # api.listTrace() / api.getTrace() + onTaskEvent 订阅刷新
└── components/
    ├── TraceList.tsx          # 列表：kind 图标、标题、时间、entryCount、状态 Badge、tokens/cost 摘要
    ├── TraceDetail.tsx        # 详情：TraceEntry[] → TimelineItem[]（复用 Timeline.tsx）；未匹配任务时显示"Pi 会话（未关联任务）"
    └── TraceFilters.tsx       # 筛选：kind 切换、时间范围、关键词搜索
```

- `TraceDetail` 映射：`TraceEntry.type → TimelineItem.kind`（`message/tool_call→tool`、`tool_result→tool`、`thinking→message`、`status→status`、`error→error`、`diff→diff`、`session_start/end→status`）。`Timeline.tsx` 已内置去重/折叠，大 trace 不卡。
- 跳转联动：详情头部 `<Link to={`/coding/${taskId}`}>`（kind=task）、`<Link to={`/chat/${chatId}`}>`（kind=chat）。
- 增值按钮（P5）：kind=pi_session 且 `traceHtmlPath` 存在 → "打开 trace.html"（`api.openExternal`）。

---

## 9. 分阶段实施步骤

| 阶段 | 内容 | 改动文件 | 验证 |
|---|---|---|---|
| **P0 基建** | `TraceKind/TraceEntry/TraceSummary` 类型；`TraceService` 骨架 | `packages/core/src/types.ts`、`apps/desktop/electron/trace/trace-service.ts` | `npm run typecheck -w @task-pipeline/desktop` |
| **P1 三路历史聚合** | ① events 表直映射；② chats-v3 按 driverId 拆 parts；③ pi-sessions JSONL 解析 | `trace/pi-session-trace.ts`、`trace-service.ts` | 单测（fixture 假 store + 假 chats + 样例 session JSONL），`npm run test -w @task-pipeline/desktop` |
| **P2 pi-trace 解析** | `trace/pi-trace-events.ts`：目录扫描 + events.jsonl 逐行解析 + 事件映射 + D6 关联 | `trace/pi-trace-events.ts`、`trace-service.ts` | 单测（样例 events.jsonl fixture 断言映射与关联）；样例文件放 `apps/desktop/electron/trace/__fixtures__/` |
| **P3 插件接入** | 安装文档 + `main.ts` `additionalExtensionPaths` 追加；缺失降级 | `main.ts`、`docs/` | 起任务 → `~/.pi/agent/traces/` 出现 events.jsonl；卸载路径后仍能启动 |
| **P4 IPC + 前端** | `trace:list/trace:get`（preload + api.ts + demo）；ActionBar、路由、TracePage（列表/详情/筛选/useTrace） | `preload.cts`、`api.ts`、`ActionBar.tsx`、`AppShell.tsx`、`pages/TracePage/*` | 组件测试（参照 `TaskCard.test.tsx`）+ `npm run dev` 手动走查：三条数据源各造一条可点开 |
| **P5 增值（可选）** | "打开 trace.html"、tokens/cost 汇总卡片、深链 `/trace/:kind/:traceId` 直达 | TracePage、trace-service | 手动验证 |

每阶段结束跑：`npm run typecheck`、`npm run lint`、`npm run test -w @task-pipeline/desktop`（涉及前端组件时）。

---

## 10. 验收标准

1. 左侧菜单出现 **Trace** 图标项，`/trace` 可访问；`/trace/pi_session/xxx` 等深链直达详情。
2. 列表聚合展示全部任务、对话与 Pi 会话，含历史数据；每项有时间、状态、事件数；kind 可筛选。
3. 详情展示完整执行轨迹（状态流转、消息、thinking、工具调用/结果、文件变更、错误），复用 Timeline 渲染效果与 CodingPage 一致。
4. 已安装 pi-trace-extension 时，Pi 任务详情能看到 step 级执行树（LLM 调用 / tool / tokens / cost / 子代理）。
5. 任务运行中打开 Trace 页，新事件实时追加（复用 `onTaskEvent`）。
6. 未安装 pi-trace-extension 时页面正常，仅缺 Pi 执行 trace 数据源，其余三路完好。
7. `npm run typecheck`、`npm run lint` 全绿；新增单测通过；`/chat`、`/coding` 功能无回归。

---

## 11. 风险与备选

| 风险 | 影响 | 应对 |
|---|---|---|
| pi-trace-extension 为社区实验性项目 | 事件格式可能变 | P2 解析器按"事件只增不改 + 未知类型跳过"编写（插件自身 PR bar 也承诺 additive） |
| events.jsonl 大文件卡顿 | 详情/列表慢 | 列表只读首行 + mtime；详情懒加载 + Timeline 折叠；必要时分页 |
| taskId ↔ sessionId 关联失败 | 无法从任务点进 trace | D6 双保险 + 独立 "Pi 会话" 类型展示（本就在列表范围） |
| trace.html 渲染需 Python | 增值功能不可用 | 核心展示纯 TS 解析，零 Python；`PI_TRACE_PYTHON` 可覆盖路径 |
| 隐私（prompt/tool 输出含敏感信息） | 本地文件泄露面 | 仅本地展示；文档注明插件仅做 key 名掩码，分享 trace.html 前需人工检查 |
| 插件完全不可用（被弃/不兼容） | 数据源④缺失 | 备选：在 `packages/pi-package` 自写钩子落同构 JSONL，TraceService 接口不变（仅解析路径切换） |

## 12. 明确不做（范围外）

- 不做跨任务聚合分析图表（趋势/成本分布），P5 仅做每 trace 的 tokens/cost 摘要卡片。
- 不做 trace 数据自动轮转/清理（events.jsonl 由插件管理；本页面只读）。
- 不做 OTLP/Langfuse 等外部上报（本地优先是本项目基调）。
- 不改动现有 `events` 表写入逻辑与 `chats-v3` 存储格式。
