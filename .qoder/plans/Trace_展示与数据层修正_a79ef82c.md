# Trace 展示与数据层修正计划

## 背景：核查结论（已用落盘数据验证）

数据目录 `~/Library/Application Support/TaskPipeline/data/traces/events/` 三条实测 trace 证实：

1. **执行 Tab 异常是渲染层问题**：底层 span 关系正确（`Agent planning` 的 parent 是 `task.run` 根，并非关键词 span）。异常来源：
   - `Timeline.renderGroup` 固定先渲染 children 再渲染 nested 子 Agent 卡 → 19:33 的 Explore 子卡排在 19:35 的 LLM 调用之后（时序错乱）；
   - 所有组卡统一 `ml-7 border-l-2` 缩进 → 顶层「Agent planning」视觉上像嵌套在关键词「LLM 调用」之下；
   - `addTaskEvent` 已退化为只发 live 通知不落库，工作流阶段事件（关键词提取/注入上下文/正在生成测试等）全部消失。
2. **OpenAI 工具互相嵌套**：`openai-chat-driver.ts` / `pi-trace-builder.ts` 建 tool span 未显式指定父级（挂栈顶）→ 同批并发工具逐个嵌套（grep⊂list_dir）；一次多步工具循环只产出一个 llm 巨 span（实测 14.5s）。
3. **Qoder 非流式路径时序失真**：agent-gen/reviewer 的裸 `query()` 未开 `includePartialMessages` → llm span 在 assistant 消息到达时才创建并立即结束（实测 1ms/0ms）；子 Agent 后段工具 tool_result 未送达时 span 悬到 `finish()` 才被强制收尾（实测 97s~111s 假时长、status=cancelled）。
4. **执行层核实**：planning/implementation/test_generation/review 各阶段是 main.ts 工作流按序驱动的独立 LLM 会话，**不是**主 agent 循环内委派的子 agent —— 执行层架构符合预期，无需改架构；但 **CodeReview 完全没接 trace 埋点**，阶段链数据缺失。
5. **原样落库核实**：JSONL append-only op 日志 ✓；读时转换（spansToAgentEvents/buildTree）不改存储 ✓；**例外**：`reparentSubtaskSpans` 事后改写已落盘 span 的 parentSpanId，且 SDK 原始 `parent_tool_use_id` 不落 meta（仅内存）——需上移渲染层。`redactSpan` 脱敏属安全必要，保留。

## 关键决策（已确认）

- 阶段链数据：**全部收敛到 span 体系**，执行 Tab 与 Trace 页统一由 span 树驱动，不恢复 events 表。
- OpenAI llm 粒度：**按 ai-sdk step 边界切分**（start-step/finish-step），每轮 API 调用一个 llm span。

## 一、埋点层修复（让数据贴近真实执行）

### 1. OpenAI 对话路径（`apps/desktop/electron/chat/drivers/openai-chat-driver.ts`）

- 消费 fullStream 的 `start-step`/`finish-step` chunk：每个 step 起一个 llm.generate span（首步 input 为 {messages, system}，后续步不重复记录全量 input；usage 取 finish-step 的 usage）。
- tool span 显式 `parentSpanId = 当前 step llm span`，同批并发工具平级，不再栈顶嵌套。
- 尾部 `finish` chunk 的总 usage 只用于兜底，不再建覆盖全程的巨 span。

### 2. OpenAI 任务路径（`electron/trace/instrument/pi-trace-builder.ts`）

- `startTool` 显式父级：`this.llmSpan?.spanId ?? this.agentSpan?.spanId`，杜绝工具互嵌。

### 3. Qoder 非流式路径（`main.ts` 的 `callQoderForAgentGeneration` / `callQoderReviewer`）

- `query()` options 增加 `includePartialMessages: true` → llm span 从首个 stream delta 开始计时，时序真实化。
- `callQoderReviewer` 增加 `onMessage` 透传，接入 QoderTraceBuilder（见第 5 点 review 阶段容器）。

### 4. QoderTraceBuilder 数据诚实化（`electron/trace/instrument/qoder-trace-builder.ts`）

- **移除 `reparentSubtaskSpans` 对已落盘 span 的 parentSpanId 改写**；改为在 span meta 原样记录 `parentToolUseId`（SDK 原始归属），重定向逻辑上移到渲染层。已落库的旧数据 parentSpanId 已被改写，渲染层双通路兼容（见二.1）。
- 跟踪 `lastMessageAt`（每条 SDK 消息到达时间）；`finish()` 强制收尾悬挂 span 时用 `lastMessageAt` 作 endedAt（`SpanEndPatch` 增加可选 `endedAt`，`TracePipeline.endSpan` 支持覆盖），消除 97s+ 假时长。
- `task_notification` / `result` 到达时，兜底收尾该子任务/会话内仍在途的工具 span（同样以 lastMessageAt 收尾）。
- llm span 补 input：builder 暂存最近一条 user 文本消息作为下一 llm span 的 input（子代理内部 user 消息均为 tool_result，不受影响）；对话主路径由 driver 显式传入用户输入。
- llm span 支持语义名：constructor 增加可选 label（来自 `streamChat` 的 `traceLabel`，如「关键词提取」「记忆整理」），写入 span.name 与 `meta.traceLabel`；`qoder-chat-driver.ts` 创建 builder 时传入。

### 5. 工作流阶段埋点（`main.ts` + `qoder-task-agent.ts`）

统一用 `agent.run` + `meta.phase` 作阶段容器（沿用现有「阶段容器」语义，不新增 SpanType）：

- `keyword` 阶段：`runPlan`/`runImplementation` 中包裹 `resolveMemoryContext + resolveAgentContext` 段，容器名「关键词提取并注入」，关键词 llm span 自然落入。
- `implementation` 重跑（ReExec）：auto-fix 循环再次 `runImplementation` 时写 `meta.round = reviewFixCount`，渲染层区分 Exec / ReExec #n。
- `review` 阶段：`callQoderOrOpenAIReviewer` 入口建容器（名 CodeReview，per repo 调用在容器内产 llm/tool span）；OpenAI reviewer 路径在调用前后手建 llm span（input=review prompt，output=review 结果，usage 取响应）。
- `finish` 终端标记：`finalizeTaskTrace` 在 endTrace 前写一个完结 span（名 Finish，meta 带最终任务状态）。
- 阶段显示名映射（渲染层共用）：keyword→关键词提取并注入 / planning→Plan / implementation→Exec（round≥1→ReExec #n）/ review→CodeReview / test_generation→TestCase / finish→Finish。

## 二、渲染层修正（视图模型优化，不改底层数据）

### 1. 归属重定向（`Waterfall.tsx buildTree` + `trace-service.ts spansToAgentEvents`）

- 新数据：按 `meta.parentToolUseId` 链解析（span → parentToolUseId → 委派工具 span(meta.toolCallId) → subtask(meta.toolUseId)），嵌套子代理沿链逐级上溯；兼容旧数据：保留现有 parentSpanId 走查。
- 此逻辑两端各一份现状不改，本次抽到共享函数（放 `packages/core` 或前端 utils），Waterfall 与 spansToAgentEvents 共用，避免两处规则漂移。

### 2. Waterfall（`TracePage/components/Waterfall.tsx`）

- 根 span（task.run/session.start）不渲染行，子项提升为顶层 roots（数据保留，仅展示拍平）。
- agent.run 行的类型标签按 `meta.phase` 显示阶段名（不再是笼统的 Agent）。
- cancelled span 弱化展示（灰色/斜纹 + tooltip 标注「未正常收尾」），不再伪装成正常长条。

### 3. 执行 Tab（`trace-service.ts` + `Timeline.tsx` + `SubTaskGroup.tsx`）

- `spansToAgentEvents`：task.run/session.start 不再产出事件；llm 事件标题用 `meta.traceLabel`（关键词提取等），否则「LLM 调用 · 模型名」。
- `Timeline.renderGroup`：顶层阶段卡去掉 `ml-7 border-l-2` 缩进（仅嵌套子 Agent 卡保留缩进）；children 与 nested 子卡按 createdAt 合并排序渲染（被吸收委派工具的位置即子卡位置）——修复时序。
- `normalizeTimelineItems`：5 秒内容去重仅对无 span payload 的遗留事件生效，span 来源事件按 spanId 豁免（避免吞掉相邻的纯 thinking 记录）。

## 三、测试与验证

- 更新单测：`trace-service.test.ts`（重定向/阶段归属）、`instrument.test.ts`（parentToolUseId 落盘、lastMessageAt 收尾）、`Timeline.test.tsx`（顶层不缩进、时间序合并）、`TracePage.test.tsx`（根拍平、阶段标签）；新增 OpenAI per-step 切分用例。
- 用 `inspect-trace.mjs` 复跑现存三条 trace 验证渲染输入；再真实跑一个 Qoder 任务（plan→exec）+ 一次 OpenAI 对话，确认：阶段顶层平铺、工具平级不互嵌、llm 时长真实、CodeReview 出现在阶段链中。

## 附带发现（不在本次范围，供你决策）

1. **关键词提取会话串扰**：`extractKeywords` 固定用 conversationId `memory-keyword-extract`，Qoder driver 会复用该常驻会话 → 跨任务关键词提取共享上下文，可能影响提取质量与 trace 内容独立性。
2. **会话消耗面板 0 Token**：截图 3 中总 Token/输入/输出均 0（轮次 9），疑似 UsageSection 数据源在本次重构中断了，未排查。

## 假设

- 根 span 数据保留、仅渲染拍平；`redactSpan` 脱敏保留（安全豁免「原样」原则）。
- 存量旧 trace（parentSpanId 已被改写）由渲染层双通路兼容，不做数据迁移。
