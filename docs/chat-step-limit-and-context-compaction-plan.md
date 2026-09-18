# Chat 步数截断与上下文压缩 · 解决方案设计

> 交接文档：供新开窗口/会话直接照此实现。本文件只描述**待实现**的两个问题；
> 已完成的相邻修复（悬空 tool-call 兜底、workspace 多根 roots、plan 模式关键词扩充、
> 普通模式 `planSuggestionGuidance`）不在本文范围，见各文件现状。

关联实证 trace：`chat-19ac67ed-bfef-4b80-826a-417e561cdee5`（deepseek / OpenAI driver）。
所有时间为本地 **UTC+8**（`events/*.jsonl` 存绝对 epoch ms；`info/*.json` 存 UTC ISO）。

---

## 背景与证据

同一条长技术对话里观察到两类"看起来像中断"的现象，根因不同，分别对应下面两个问题：

| 现象                                                                                                                | 定位                                                                   | 根因归类                 |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| 16:57 那轮（`#108`）回复只剩半句"…需要核实 ORM 行为才能给出可靠结论"，末尾停在"已查看 Model.php"                    | run `#108`：正好 **10 个 llm 步 / 26 次工具**，末步 `#143` 仅 81 token | **问题 1：步数上限**     |
| 单轮 input token 一路涨：`#148` 106k → `#152` 107.7k → `#156` 109.9k；整会话累计 input **260 万 token**、成本 $0.78 | 每轮全量重发历史、无任何裁剪                                           | **问题 2：上下文无压缩** |

对照组：健康的长答轮 `#96`（16:49）只用了 4 步、末步 5276 token 自然收尾——说明步数"没满"是因为模型在中途产出了"只回文本、不调工具"的一步。

关键代码位置（现状）：

- `apps/desktop/electron/chat/drivers/openai-chat-driver.ts`
  - L654-662：`streamText({ model, messages, system, tools: effectiveTools, stopWhen: stepCountIs(10) })`——**无 `prepareStep` / 无 `onStepFinish`**。
  - `historyToModelMessages(input.history)`：把整段 history 原样转 `ModelMessage[]`，无窗口。
- `apps/desktop/electron/chat/chat-service.ts`
  - L485-486：`historyRecords = [...messages.slice(0,-1), ...systemMessages, userRecord]`（`slice(0,-1)` 只是把 system 插到最后一条 user 之前，**不是裁剪**）；`history = historyRecords.map(deserializeRecord)` → 全量。
- ai-sdk `7.0.101`：
  - `stepCountIs === isStepCount`：`node_modules/ai/src/generate-text/stop-condition.ts:27` → `({ steps }) => steps.length === N`。
  - 主循环：`node_modules/ai/src/generate-text/generate-text.ts:1482-1489`（`do{ 调模型→执行本步全部工具→steps.push }while(本步有工具调用 && 工具执行完 && !stopCondition)`）。
  - `prepareStep?: PrepareStepFunction`（`stream-text.ts:569`），回调入参含 `stepNumber`、`messages`，返回可含 `{ tools, system, messages, model }`。
- 用量信号：`ChatUsage = { inputTokens, outputTokens, ... }`（`apps/desktop/src/api.ts:314`），driver 在 `done` chunk 带回、落 `StoredMessageRecord.usage` 与 trace。

---

## 问题 1：复杂多步查证被 `stepCountIs(10)` 提前掐断

### 根因（精确）

一个 "step" = **一次模型往返**（该步内模型可并行发多个 tool_call，工具执行算在步内），**不是**一次工具调用。循环只在两种情况退出：

1. 模型某步**只回文本、不再调工具** → 自然收尾；
2. `steps.length === 10` → 强制停。

`#108` 这轮 deepseek **每一步都在选择继续查证**（grep→read→grep→read…连续 10 步），从未出现"只回文本"的步，于是第 10 步执行完工具后被硬上限掐断——而"给出综合结论"本应是第 11 步，没给到。落盘的最终文本就是第 10 步那句没说完的叙述，UI 停在最后一个 `read_file`（Model.php）。步数预算**每轮独立、跨轮清零**，所以别的轮次的多次查看不会累加到这里。

### 目标

复杂任务允许**更多查证步**，且**任何情况下都以"完整结论"收尾**，不再出现半句截断停在工具调用。

### 方案（推荐）：抬高上限 + "末步强制收敛"（graceful wind-down）

1. 把硬上限做成**常量/可配置**：`MAX_CHAT_STEPS`，默认从 10 提到 **15**（或放 profile/modelParams 允许逐模型覆盖）。
2. 给 `streamText` 增加 `prepareStep`：当 `stepNumber >= MAX_CHAT_STEPS - 1`（即只剩最后一步）时，**摘掉工具并注入收尾指令**，逼模型基于已获取信息直接产出完整结论，而不是再开一步查证：

```ts
// openai-chat-driver.ts，streamText({ ... }) 内新增：
const MAX_CHAT_STEPS = 15 // TODO: 可后续接到 profile/设置项
result = streamText({
  model,
  messages,
  abortSignal: input.signal,
  ...(system ? { system } : {}),
  ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
  ...(effectiveTools ? { tools: effectiveTools, stopWhen: stepCountIs(MAX_CHAT_STEPS) } : {}),
  // 末步收敛：倒数第二步起禁工具 + 追加强制总结指令，确保以完整文本收尾。
  ...(effectiveTools
    ? {
        prepareStep: ({ stepNumber }: { stepNumber: number }) => {
          if (stepNumber < MAX_CHAT_STEPS - 1) return {}
          return {
            tools: {}, // 禁工具 → 本步只能出文本 → while 条件(本步有工具调用)为假 → 循环自然停
            system: `${system ?? ''}\n\n【收尾】已达到工具调用上限，禁止再调用任何工具；请基于以上已核实的信息，立即输出完整、可交付的最终结论。`
          }
        }
      }
    : {})
})
```

> 说明：`prepareStep` 返回 `tools: {}` 使最后一步不再产生 tool_call，循环据此**自然退出**（而非撞上 `stepCountIs` 的硬停），从而把"最后一格"留给综合结论。这与把 `stepCountIs` 单独调到很大不同——后者只多给步数、仍可能停在工具上。

3.（可选，行为层）配合普通模式 `planSuggestionGuidance`（`packages/core/src/plan-mode.ts`），或追加一条"对已明确需求连续推进到可交付产出、不要中途停下等确认"的指引——已有一条用户偏好记忆佐证（本 trace `#158` 抽出："期望助手自主推进不中断"）。此项独立于步数，视需要再加。

### 备选与取舍

- **仅把 10 调大（如 25）**：改动最小，但① 每步重发全量历史 → 成本/时延随步数**近线性上涨**（见问题 2，input 已 100k+/步）；② 仍可能在步数用尽时停在工具上，没根治"半句截断"。**不推荐单用。**
- **检测撞上限后补一次"无工具总结"调用**：能收尾但要额外一次往返与代码分支；`prepareStep` 方案在同一次 `streamText` 内解决，更省。
- **摘工具改 `activeTools`/`toolChoice:'none'`**：等价手段之一；用 `prepareStep` 返回 `tools:{}` 最贴合版本 API。

### 验收标准

- 构造"需要 >10 步查证"的脚本化多轮 tool-call（复用 `aiMock.__pushStreamScript` / `__streamCalls`，见 `openai-chat-driver.test.ts`）：
  - 断言 `prepareStep` 在 `stepNumber === MAX_CHAT_STEPS-1` 时返回 `tools` 为空；
  - 断言该轮最终 `parts` 以 **非空 text part** 收尾（末步不是纯 tool-call/tool-result）。
- 现有 `openai-chat-driver.test.ts` 全绿；tsc(electron)+eslint 0 error。

### 风险

- deepseek 对"禁工具后是否老实输出结论"依赖其指令遵循；故 `prepareStep` 的 system 文案要显式、置后。
- 步数上限是**每轮**语义，勿误改成跨轮累计。

---

## 问题 2：长对话上下文无自动压缩

### 根因（精确）

OpenAI/deepseek chat 路径**没有任何** `pruneMessages` / token 截断 / 滑动窗口 / 摘要压缩。每轮 `history = 全部历史消息`，且 agentic 循环内**每一步**都把"全量历史 + 本轮已生成消息"重发 → input token 单调上涨；本会话已 ~110k，逼近 deepseek 窗口上限时**不会自动裁剪，只会 provider 报"上下文超长"**。

- 每轮"记忆整理"**只生成结构化记忆供以后检索**，不缩小当轮请求体。
- `CONTEXT_BUDGET_RATIO=0.6` / `context_usage_ratio` 那套只在 **Qoder 任务链路**（`pi-extension/qoder/qoder-task-agent.ts`），管 fork 新会话的时机，且 headless 下 `autoCompact` 关闭；**deepseek chat 不走它**。

### 目标

在**不明显损失技术细节**的前提下，把单轮请求 input 控制在模型上下文预算内，避免爆窗并压成本。

### 方案（推荐）：token 预算驱动的"滚动摘要 + 保留窗口"

分两层，先做兜底层，再做摘要层。

**A. 兜底层（廉价、必做）——按 token 预算裁剪到保留窗口**

- 发送前估算 `projectedInputTokens ≈ lastUsage.inputTokens + 本轮新增消息` 的字符/token 粗估（字符/4 起步即可；`lastUsage` 取该对话最近一条 assistant 的 `usage.inputTokens`）。
- 设定预算 `CHAT_CONTEXT_BUDGET = contextWindowTokens * ratio`（`ratio≈0.75`，`contextWindowTokens` 走 profile 配置，缺省按模型族给保守默认，如 deepseek=64k/128k）。
- 超预算时：始终保留 `system` + **最近 K 轮**（user/assistant 成对，含其 tool-call/tool-result parts）逐字，**丢弃更早的轮次**，把被丢弃轮次交给 B 层摘要；A 层若 B 未就绪则先直接丢弃（保证不爆窗优先于信息完整）。

**B. 摘要层（增强）——滚动摘要注入为 system**

- 在 `ChatConversation` 增加 `compaction?: { summary: string; coveredUntilMessageId: string; updatedAt: string }`（存进 `chats-v4/<id>.json`，见 `chat-storage.ts`）。
- 触发：当"待丢弃"的旧轮次累积到阈值（如 ≥ N 轮或 ≥ M tokens），跑一次**辅助 LLM 调用**把 `compaction.summary + 新溢出轮次` 压成新的 `summary`（沿用现有关键词/记忆整理同类模式：join 同一回合 trace、失败不阻断对话）。
- 组装：`history = [summaryAsSystemRecord] + 未被 covered 的最近轮次`。摘要覆盖的消息（`id <= coveredUntilMessageId`）在重建 history 时排除。
- 可复用信号：`ChatUsage.inputTokens`（已有）决定何时溢出；记忆整理的产物可作为摘要的补充素材（非必需）。

> 为什么不是"只靠检索记忆"：这些轮是密集技术分析，直接丢老轮靠 keyword/记忆检索会丢**verbatim 结论与代码细节**；故保留窗口 + 显式滚动摘要更稳。纯靠已注入的 `memoryContext` 兜底可作为极端预算下的降级项。

### 代码触点

- 裁剪/组装放 `chat-service.ts`（构造 `history` 处 L483-487 之前），driver 的 `historyToModelMessages` 保持"给什么转什么"，职责清晰。
- 摘要用的辅助调用 + compaction 读写：新增小模块或在 `ChatService` 私有方法内聚；`ChatConversation` 类型加 `compaction` 字段（electron `chat-types.ts` 与前端 `src/api.ts` **同步**，历史上 DriverPart 类型两处各一份导致过渲染分叉，注意）。
- token 估算工具函数放 `chat/lib` 或 driver 邻近；提供 `contextWindowTokens` 的 profile 配置项（`readProfiles` 链路）。

### 验收标准

- 单测：给定超预算历史，断言组装后 `history` 轮次数下降、system 含 `summary`、最近 K 轮逐字保留、`coveredUntilMessageId` 之后消息不丢失。
- 单测：摘要触发/失败降级（辅助调用抛错→仅走 A 层裁剪，对话不中断）。
- 回归：短对话（未超预算）行为不变（不触发裁剪/摘要）。
- tsc(electron)+全量 chat 测试通过。

### 风险

- 摘要本身要一次模型调用（成本/延迟），必须阈值触发、别每轮做。
- `coveredUntilMessageId` 边界要稳，避免把用户关心的最近上下文摘要掉；保留窗口 K 取偏保守。
- 保留窗口按"轮"而非"消息"成对丢弃，避免悬空 tool-call（与已修的 tool-result 配对逻辑相互印证，勿破坏）。

---

## 实施顺序（里程碑）

1. **问题 1**：`MAX_CHAT_STEPS` 常量 + `prepareStep` 末步收敛 + 单测。（小、独立、先止血"半句截断"）
2. **问题 2-A**：token 估算 + 预算裁剪到保留窗口（system + 最近 K 轮）。（防爆窗优先）
3. **问题 2-B**：`compaction.summary` 字段 + 阈值触发的滚动摘要 + history 组装 + 类型双端同步。
4. 全量 `npm run test`（桌面端）回归。

## 实施状态（落地记录）

- ✅ **问题 1（已落地）**：`openai-chat-driver.ts` 新增导出常量 `MAX_CHAT_STEPS = 15` 与 `WIND_DOWN_INSTRUCTION`；
  `streamText` 的 `stopWhen` 改用 `stepCountIs(MAX_CHAT_STEPS)`，并在 `effectiveTools` 存在时加 `prepareStep`：
  `stepNumber >= MAX_CHAT_STEPS - 1` 返回 `{ tools: {}, system: 收尾指令 }`。单测：`openai-chat-driver.test.ts`
  两条（stopWhen=MAX；prepareStep 末步摘工具 + 收尾文案）。
- ✅ **问题 2-A（已落地）**：新增 `chat/context-budget.ts`（`estimateTokens`/`estimateRecordTokens`/
  `contextWindowForModel`/`budgetForModel`/`trimHistoryToBudget`），`chat-service.ts` 构造 `history` 处接入：
  取最近一轮 assistant 的 `usage.inputTokens` 作触发下限，按轮裁剪到 `system + 最近若干轮`（末轮强制保留、
  保持原序）。常量 `CHAT_CONTEXT_BUDGET_RATIO=0.75`、`DEFAULT_CONTEXT_WINDOW_TOKENS=128_000`（profile 可加
  `contextWindowTokens` 覆盖）。单测：`context-budget.test.ts` 5 条（短对话不变 / 成对丢弃 / 保留 system /
  lastUsage 触发 / 末轮强留）。回归：`electron/chat` 全绿（140）、tsc(electron)+eslint 0 error。
- ✅ **问题 2-B（已落地）**：`chat-types.ts` 与 `src/api.ts` 双端同步新增 `ChatCompaction` 类型与
  `ChatConversationMeta.compaction?` 字段（可选，旧对话无该字段自动视为未压缩，无需 migration/版本号提升）。
  新增 `chat/context-compaction.ts`：`excludeCoveredRecords`（按 `coveredUntilMessageId` 排除已覆盖的非 system 轮次、
  保留 system 与更新消息）、`makeSummarySystemRecord`（摘要作为 system 注入）、`shouldCompact`（阈值
  `COMPACTION_TRIGGER_TOKENS=4000`）、`summarizeOverflow`（一次性会话 + `traceLabel:'上下文摘要'` join 同回合
  trace、失败/异常返回 undefined）、`buildCompactionTranscript`/`buildCompaction`。`chat-service.ts` 组装
  history 时先排除已覆盖轮次、摘要注入最前、再过 2-A 裁剪；回合结束（status=done）后在 memory 阶段同侧
  fire-and-forget 调 `maybeCompactConversation`，溢出达阈值才跑摘要并 `updateMeta({ compaction })`。单测：
  `context-compaction.test.ts` 13 条（阈值/排除/摘要注入/覆盖边界/失败降级/组装不变量）。回归：`electron/chat` 全绿（153）。
- ✅ **压缩触发补充（已落地）**：除旧的「溢出攒批 ≥ `COMPACTION_TRIGGER_TOKENS=4000`」外，新增**上下文占用达窗口 80%**
  （`COMPACT_CONTEXT_USAGE_RATIO=0.8`）即触发：`chat-service.ts` 组装 history 时以「实测上轮 input 与裁剪前全量估算
  取大」对比 `contextWindowForModel` 的 80% 标记 `contextReachedLimit`，回合结束传入 `shouldCompact(overflow, { contextReached })`；
  达阈时只要有溢出轮次就立即摘要，不再等攒批（无溢出则仍不触发，无事可摘）。

> 2-B 未走新主进程回调管线：`ChatService` 已持有本轮 `driver`，摘要直接复用 `driver.streamChat`（同 `extractMemories`），
> 无需 `main.ts`/`chat-init.ts` 接线与依赖注入，blast radius 更小。

> 生效前提不变（见文末）：改 `electron/**` 需彻底重启 `npm run dev`；本次未改 `packages/core`，无需 stage。

## 非目标 / 边界

- 不改 Qoder 任务链路的 fork/autoCompact 逻辑（独立体系）。
- 不动已完成的悬空 tool-call 兜底、roots、plan 关键词、`planSuggestionGuidance`。
- "把 chat 回复真正写成文件"属任务/执行链路能力，非本文范围（chat 沙箱只读）。

## ⚠️ 生效前提（两个通用坑，务必带上）

1. **Electron 主进程不热更新**：改 `electron/**/*.ts` 后 `tsc --watch` 只更新磁盘 `dist-electron`，运行中的主进程不换血；必须**彻底退出并重启 `npm run dev`**（macOS 关窗口/点 Dock 不退出进程，要 `Cmd+Q` 到 pid 消失，或 `kill <electronPid>` 让 `concurrently -k` 带停整组）。会话还有内存缓存，不重启连数据改动都读不到。
2. **改了 `packages/core` 要 stage**：`apps/desktop/node_modules/@task-pipeline/*` 是打包 staging 的**物理拷贝**、会遮蔽 workspace 软链；desktop `predev` 只 `build -w core` **不重新 stage**。若本方案把常量/类型放进 core，需 `npm run build -w @task-pipeline/core && npm run stage:monorepo -w @task-pipeline/desktop`，否则桌面端读不到新 core。
