# 任务阶段会话边界方案（Stage / Session Boundary）

> 状态：P0–P4 已落地（§7.5 是落地记录，含与本文件的差异） · 范围：Task Pipeline 的 Plan / Implementation / Test 三段会话归属与阶段间交接
> 前置阅读：`docs/task-fixed-pipeline-plan.md`（§2.1 七段链路、§1.2 代价 3「链路漂移」）
> 本方案的所有关键前提都已在本机实测（见 §1），不再依赖推断。

## 0. 一句话结论

把会话粒度从「一任务一常驻会话」改成「**一阶段实例一 fork 会话**」：阶段内续接、阶段间分叉；
fork 负责上下文继承，`dataDir` 阶段产物负责跨人工闸门的真值；同时把 Plan 阶段的写权限收掉。

## 1. 验证结论（全部实测，可复现）

验证方式：用本机已存 Qoder Token 起独立 SDK 进程，在 codingagent 仓库 cwd 下跑合成会话
（两条 user turn 各埋关键词 A=`GLYPH-7734` / B=`ZEPHYR-2210`），再对同一父会话做 fork / 截断。

| #   | 待验假设                                | 实测结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 对方案的影响                                                                                                                             |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | fork 原语是否只是 SDK 类型里的空头承诺  | **真实可用**。binary `1.1.23`、`protocol_version 1.2.0`、`capabilities = interrupt_receipt_v1, interrupt_cancel_queued_v1, msg_lifecycle_v1, session_rewind_v1, background_tasks_v1, side_question_v1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 方案可以依赖 rewind / interrupt                                                                                                          |
| V2  | `resume + forkSession` 是否继承父上下文 | **完整继承**。新 sessionId，回答同时含 A 与 B                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 跨阶段继承不需要重读文件                                                                                                                 |
| V3  | `resumeSessionAt` 截断语义              | 指向「被保留 turn 的最后一条」时生效（ sees A、不含 B）；指向该 turn 的 user 条目时 **exit 42**，stderr 给出精确原因：`Resume rejected by --resume-drops-turn: range does not start with the declared turn prompt; first discarded entry 0 [type=assistant, uuid=…]`                                                                                                                                                                                                                                                                                                                                                                                                                                             | 截断必须按算法取 entry；拒绝路径要单独分类                                                                                               |
| V4  | `resumeDropsTurn` 是否必需              | 不必需。`resumeSessionAt` 单用即截断成功，加上 dropsTurn 结果一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 首版只用 `resumeSessionAt`，`resumeDropsTurn` 留给「丢弃被推翻轮次」                                                                     |
| V5  | 会话文件形态                            | 位于 `~/.qoder/projects/<cwd 路径编码>/<sessionId>.jsonl`，是**树**不是线性 log：条目类型 `user / assistant / runtime-config / workspace-directories / last-prompt / active-leaf(leafUuid,explicit)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `resumeSessionAt` 本质是移动 active-leaf；同一父会话可分叉多支                                                                           |
| V6  | worktree 删除后会话是否失联             | **不会**。worktree 移除后从主仓 cwd 仍能按 id resume 并正确答出关键词；`listSessions({dir: 已删目录})` 仍能列出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | fork 不受 worktree 生命周期约束；但反过来 `~/.qoder` 会永久累积（实测 `-` 目录 266 个、本仓库 88 个会话，我们无任何清理路径）            |
| V7  | usage 是否可用作成本判据                | **token 恒 0**：`auto` 与 `performance` 两种模型下 `input_tokens / cache_read_input_tokens / total_cost_usd` 全为 0，`contextWindow` 也是 0。唯一可靠信号是 `result.usage.context_usage_ratio`（实测 0.0747–0.0800 逐轮变化）与 `result.modelUsage[model].credits`（auto 单轮无工具 = 0.2024）                                                                                                                                                                                                                                                                                                                                                                                                                   | 预算与可观测只能用 ratio + credits；不要用 token                                                                                         |
| V8  | 阶段间共享是否会被自动压缩救场          | **不会**。`getContextUsage().autoCompact = { enabled: false, thresholdPercentage: 83.5 }`，且 `categories` 实测 `system_prompt 1.8% / system_tools 6.3% / skills 0.1% / messages 0% / free 75.5% / auto_compact 16.5%`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | headless 会话上下文只涨不缩；长任务的膨胀担忧成立                                                                                        |
| V9  | 用户环境是否污染任务会话                | **已污染**。`skills` 4 项里 1 项 `source: 'user'`（naiveui-refactor-helper）、3 项 `source: 'plugin'`。传 `settingSources:['project'] + skills:[]` 后 user 项消失、**plugin 三项仍在**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 隔离有官方旋钮但不完整；plugin 需要单独处理                                                                                              |
| V10 | Plan 阶段是否真只读                     | 否。init `tools` 18 项含 `Edit/Write/NotebookEdit/WebFetch/Bash`，`permissionMode: acceptEdits` 全阶段贯通                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 必须按阶段切权限（§5）                                                                                                                   |
| V11 | 无效 model 名的行为                     | 传 `claude-sonnet-4.5`（不在 18 个别名内）**静默回落 auto**，不报错；`runtime-config.model` 仍记录传入值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 模型可用性校验必须保留（`isModelAvailable`），不能只靠 CLI 报错                                                                          |
| V12 | 我们跑的是哪个 transport                | **复核已修正（P0-5）**：SDK 的隐式选择是「显式 transport > `pathToQoderCLIExecutable` > `executable*` / `spawnQoderCLIProcess` > 环境变量 `QODERCLI_PATH` > 包默认（本发行包 = `worker`）」。我们一直在 `init/qodercli-path.ts` 里设 `QODERCLI_PATH` —— 它不只是路径提示，而是把 transport 切到 **`process`**。所以**线上跑 ProcessTransport，而 §1 的 fork / anchor / usage 实测跑的是 WorkerTransport**（脚本环境没有 `QODERCLI_PATH`）。两者同为 qodercli `1.1.23`（`qoder-bin/qodercli --version` 与 manifest / worker `runtime-info.json` 一致），差异只在运行边界                                                                                                                                          | 不再靠猜：`transport` 已与会话版本一起写进阶段 span meta（P0-4）；P1 的 fork 降级链必须能在 process transport 上跑通，否则退化路径要兜住 |
| V13 | Pi 侧是否真能对称分叉（§6 的前提）      | **能，且与 Qoder 同形**（`node scripts/pi-fork-probe.mjs`，纯文件层、不需模型凭据）：`SessionManager.forkFrom(parentFile, cwd, sessionDir)` 产新文件、条目 id 与父**完全一致**（整段继承）、`header.parentSession` 指向父文件；`createBranchedSession(leafId)` 按叶子截断（leafId = 第一轮 assistant 时 → 只留 2 条，看得到第一埋词、看不到第二轮），即 leaf **含自身**，与 V3 的「保留区间最后一条」是同一条规则；同一父会话可重复 fork，两支互不互斥                                                                                                                                                                                                                                                           | Pi 不需要「阶段内共享会话」变通；`fork` / `newSession` / `switchSession` 的 `{cancelled:true}` stub 可以直接解除（P3）                   |
| V14 | 会话存储能不能安全回收（sweep 前提）    | **可以，但有四条硬约束**（`node scripts/qoder-session-store-probe.mjs list`）：① `listSessions()` 不带 dir 就是跨全部项目聚合（本机 385 条 / 42 个 distinct cwd / cwd 缺失 0 条），且与磁盘 jsonl **一一对应**（`~/.qoder/projects` 里 32 个任务工作区桶 / 53 个会话文件，53 条全在 list 里）→ 不存在「列不出来但存在」的死角；② 真实 cwd 是 `<appData>/data/workspaces/<taskId>/<repoName>`，**工作区根下面还有一层仓库名**；③ `deleteSession(id, {dir})` 的 `dir` 必传（不传抛错），id 必须是 UUID，而项目目录名是 cwd 的有损编码（非字母数字 → `-`）**不可反解** —— 只能把 list 拿到的 cwd 原样回传；④ 本机这批会话 26–48 天未动，其中 36/53 条的 cwd 还指向产品改名前的旧 dataDir（`@coding-agent/desktop`） | sweep 的归因算法（相对 root 取第一段）、roots 可配多个、以及「只处理我们自己的 dataDir」的护栏都来自这条                                 |

## 2. 为什么要改（三条，都被实测支撑）

1. **人工闸门本身就是上下文接口，共享会话会让它失效。**
   `EditPlanDialog` → `api.updateTaskPlan` 会改写 `task.planContent`，而有会话时 Exec 的 prompt 只有
   「严格按照上轮 Plan 制定的方案执行」，**不注入 planContent**（[qoder-task-agent.ts#L305-L327](../apps/desktop/electron/pi-extension/qoder/qoder-task-agent.ts)）——
   用户手改的条目在执行期被静默丢弃，人批的是文本、模型跑的是对话，两者不一致。
2. **链路可比性要求阶段输入可比。**
   `docs/task-fixed-pipeline-plan.md` §1.2 代价 3 讲的是同一个问题：共享会话使「阶段」退化为「一条提示词」，
   Trace 上阶段 span 的输入无法横向比较，重跑/对照实验失去意义。
3. **共享会话把权限、脏轨迹、审批三件事一起粘住。**
   V10 的只读缺失、超时中断后脏轨迹被下一阶段继承（`runTurn` finally 不关会话）、
   HITL 审批跨阶段串味——都是同一个根因：会话边界 ≠ 阶段边界。

而共享唯一的正当收益「省下重新探索」已经被 V2 的 fork 拿走，「省进程」也不再成立（V12 显示我们根本
不在 process transport 上，一个 warm runtime 可派生多个 session）。

## 3. 会话模型

### 3.1 概念

```ts
/** 一次阶段执行 = 一个阶段实例。会话绑阶段实例，不绑任务。 */
type StageInstanceId = `${taskId}:${phase}:${attempt}:${seq}`

type StageSession = {
  stageInstanceId: string
  qoderSessionId?: string // 本阶段自己的会话（fork 出来的新 id）
  parentSessionId?: string // 上一阶段实例的会话，用于 fork；无则全量 prompt 重放
  anchorEntryUuid?: string // fork 点：被保留的最后一个 turn 的「最后一条 entry」uuid
}
```

`task.qoderSessionId` 语义改为「**最后一个成功结束的阶段实例的会话指针**」，不再当"任务会话"用。

### 3.2 断/连判据（三条同时满足才共享）

1. 两阶段之间有**无可编辑的产物接口**？有 → 断（Plan→Exec 有 planContent，必断）。
2. 重做的成本是**重读还是重推理**？重读为主 → 断（fork 前缀继承已覆盖）；重推理为主 → 连。
3. 两阶段之间是否发生**状态突变**（人工编辑 / 外部评审意见 / 文件回滚）？是 → 断。

### 3.3 各阶段归属

| 链路位置                          | 会话动作                                             | 输入                                        | 说明                                                                 |
| --------------------------------- | ---------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| Plan 首次                         | 新建会话                                             | 全量任务 prompt                             | 任务起点                                                             |
| Plan 重跑 / 用户追问              | **同会话续接**（resume）                             | 增量指令                                    | 实测同阶段重跑重复读文件率 60–80%，必须续接                          |
| Plan → Exec                       | **fork**（`resume + forkSession + resumeSessionAt`） | plan.md + 已定位文件清单                    | 阶段间必断，见 §3.2 判据 1、3                                        |
| Exec auto-fix                     | 同会话续接                                           | review comments + `taskChangedFiles()` diff | 属同阶段内的修正轮次                                                 |
| Exec 崩溃重试                     | 同会话续接，但按 V3 丢弃被中断轮                     | 同上                                        | 用 `resumeSessionAt` 回到最后一个干净 turn，替代现在的「脏轨迹继承」 |
| Exec → Test                       | **fork**                                             | changedFiles + 测试约定                     | 与 Plan→Exec 同理                                                    |
| Review / Validate / MR / 记忆整理 | 无会话（现状保持）                                   | 产物 + 裸 HTTP / 一次性 query               | `persistSession:false` 不变                                          |

### 3.4 fork 点选取算法（必须照抄，否则 exit 42）

```ts
const entries = await getSessionMessages(parentSessionId, { dir: repoCwd })
// 按 user 条目切 turn；anchor = 最后一个「要保留的 turn」里的最后一条 entry
const lastUserIdx = entries
  .map((e, i) => ({ e, i }))
  .filter(({ e }) => e.type === 'user')
  .at(-1)!.i
const anchor = entries
  .slice(lastUserIdx)
  .filter((e) => e.type === 'assistant' || e.type === 'user')
  .at(-1)!.uuid
// options: { resume: parentSessionId, forkSession: true, resumeSessionAt: anchor }
```

降级链（每次降级都要落 Trace 事件，禁止静默）：

```
fork(anchor) → 被 CLI 拒绝(V3) → fork(无 anchor，全量继承) → 会话不存在(V6 之外) → 全量 prompt 重放（现有兜底）
                                    ↘ capabilities 不含所需项 → 直接退化为「同任务单会话」（旧行为）
```

## 4. 阶段产物契约（dataDir handoff）

### 4.1 目录与文件

```
<dataDir>/tasks/<taskId>/
  plan.v<n>.md              # 计划正文（人可读、可 diff、可被 Read/Grep 局部取用）
  plan.v<n>.json            # { outcome, revision, sha256, editedBy, sessionAnchor, cliVersion }
  exec.summary.md           # 实际改动摘要（与 git diff 对账后的结果）
  test.cases.json           # 用例清单
  stages/<stageInstanceId>.json  # 该阶段实例的输入快照（fork 点、注入片段、降级原因）
```

- **绝不写 worktree**——已踩过的坑：工具产物落进任务 worktree 会污染提交并阻断合并。
- **DB 仍是真值**，md 是导出视图 + 阶段输入。理由：`parsePlanDecision` 现在靠 148 行兜底正则救模型输出的破
  JSON（[plan-content.ts#L82-L147](../apps/desktop/electron/task/plan-content.ts)）；若 md 成主链路真值，故障面从「一次解析」变成「解析+写文件+读回+合并人工编辑」。

### 4.2 一致性规则

- 写 `plan.v<n>.md` 时算 `sha256`，**存在同 revision 的 `plan.v<n>.json` 里**（P2 实现修订：不加 DB 列，避免为审计字段开一次 schema 迁移；产物按 revision 分版本，所以「只有同一 revision 内容不同」才算异常）。Exec 起跑前比对：**文件 ≠ DB 即报错**，不允许静默取其一（这是当前缺陷的根治点）。
- 人工编辑走 `updateTaskPlan` → `revision++` → 重新导出 md → 记 `editedBy: 'user'`，Exec prompt 必须显式包含「用户已编辑，以 plan.v<n>.md 为准」。
- 阶段实例的输入快照落 `stages/*.json`，Trace span 的 `output` 指向它，实现「点阶段看它到底读了什么」。

### 4.3 plan.md 强制新增三段（否则 fork 省下的探索会回来）

```
## 已定位文件与依据      （路径 + 为什么相关：Exec 据此免重复检索）
## 已否决方案与理由      （防止 Exec 重新走回头路）
## 验证方式              （Test 阶段的输入，也让 Review 有对账基准）
```

存量任务没有这三段 → **首版规则：三段缺省则不拆 Exec（继续共享），只在 Trace 标 `fallback: plan_schema_incomplete`**。
新产物先还债，再拆边界。

### 4.4 清理

任务删除 / reset 时级联：删 `<dataDir>/tasks/<taskId>/` + 对每个 `stageInstanceId` 调 `deleteSession(qoderSessionId)`。
顺带治历史：`~/.qoder/projects/**` 目前无人回收（V6），需要一个启动期低频 sweep（只删超过 N 天且无对应任务的会话）。

**已落地（P4-4）**：`apps/desktop/electron/pi-extension/qoder/session-sweep.ts` 两个入口 —— 任务级
`purgeTaskSessions(dirs)`（删除 / reimplement 级联）与全局 `sweepOrphanTaskSessions()`（`main.ts` 启动 60s 后首跑 +
12h 周期，两个 timer 都 `unref()`，不拖住退出）。护栏五道，全部由 V14 直接推出：cwd 必须能归因到
`<dataDir>/workspaces|worktrees` 根下（相对路径取第一段 = taskId）、该 taskId 不在活任务集合、`lastModified`
超 `DEFAULT_MAX_AGE_DAYS = 14`、sessionId 存在且是 UUID、删除必带 `{dir: cwd}`。**不满足任何一条就跳过而不是猜**。

**当时剩下的缺口（本节初稿只做了 Qoder 侧）**：`<dataDir>/pi-sessions/*.jsonl` 的文件名是 `<ISO时间>_<uuid>.jsonl`，**不含任务 id**，
且一个任务只有一个会话指针 `task.piSessionPath`（`forkPiStage` 每次把它换成新文件），父文件就地变孤儿。

> 更正（P4 落地后复测）：上一版这里写的「无任何任务归属信息、无法安全回收」**不成立**。
> 归属信息在文件**首行 header 的 `cwd`** 里，且 `forkFrom` / `createBranchedSession` 的产物同样带
> `cwd` + `parentSession`（临时目录实测）；header 字段集固定为 `type,version,id,timestamp,cwd[,parentSession]`。
> cwd 形态与 Qoder 侧一致（`<dataDir>/workspaces/<taskId>/<repoName>`），所以 §4.4 的
> `taskOwnerOfCwd()` 可以直接复用 —— 不需要新建归属索引。
> 本机现状佐证：3 个 pi-sessions 文件对应 2 个任务，而两个任务的 `pi_session_path` **都是空**
> → 100% 孤儿，靠 DB 指针根本管不到它们。

**已落地（P4-4 补做，Pi 侧）**：`apps/desktop/electron/task/pi-session-sweep.ts`。它单独一个文件而不是塞进
`session-sweep.ts`：Pi 会话不在 `~/.qoder/projects/**`，没有 `listSessions` 可列，只能扫目录 + 读首行。
两个入口与 Qoder 侧一一对应：`sweepOrphanPiSessions()` 挂在 `main.ts` 同一个 `runSessionSweep`（60s 首跑 + 12h 周期），
`purgePiTaskSessionFiles(taskId)` 挂在 `purgeTaskSessionsFor()`，且**排在 `deletePiTaskSessionFile()` 之前** ——
先按 header 归因删（能盖到 fork 前驱），再按 DB 指针补删（header 解析失败时的兜底），两边的失败合并成一条任务事件。
护栏与 Qoder 侧同源：复用 `taskOwnerOfCwd()` + `isAgedOut()`，`scanned` 只算 `.jsonl`，header 解析不出 cwd、
`stat` 抛错、归因到工作区根之外 —— 一律保留（宁可留垃圾，不可删错）。

## 5. 权限与上下文治理

| 阶段           | permissionMode | 工具                                               | 备注                          |
| -------------- | -------------- | -------------------------------------------------- | ----------------------------- |
| Plan           | `default`      | `disallowedTools: ['Edit','Write','NotebookEdit']` | V10 的硬边界，不能只靠 prompt |
| Implementation | `acceptEdits`  | 现有 `allowedTools:['Agent']` 保持                 |                               |
| Test           | `acceptEdits`  | 限定测试路径                                       |                               |

- 会话绑阶段实例后，权限在 `query()` 创建时确定，**不再需要** `setPermissionMode` 中途切（可用但会重建 tools、破 prompt cache）。
  —— 已落地（P4-1）：`permissionsForStage(phase)` 在 `ensureSession` 里展开进 `query()` options；
  工具名以 init 回报的 `tools` 为准（V10：SDK 里**没有** `MultiEdit`，名字写错只静默不禁），
  所以 `PLAN_DISALLOWED_TOOLS = ['Edit','Write','NotebookEdit']` 三项都在 V10 清单里。
  Test 阶段不做工具级禁用：它要写测试文件，路径级约束归 core L1（下面那条），否则一并杀毙「写」。
- `evaluateExecutionPermission(toolName, input, { roots, cwd })` 增 `phase` 入参（[permissions.ts#L177-L181](../../packages/core/src/permissions.ts)），
  把只读判断从「口头约束」变成 L1 判定的一部分。
  —— 已落地（P4-2）：phase 由 `executionPhaseOf(task.state)` 从状态机推导（不新增入库字段），
  两个入口都传：Pi 的 `tool_call` hook 与 Qoder orchestrator 的 `onPermissionRequest`；
  `phase: 'planning'` 下写类工具直接 deny，`phase: 'test'` 下只允许测试产物路径（判定改用
  **仓库相对路径**，否则工作区目录名自带 `test` 字样会把整仓洗成「测试目录」）。
- 上下文预算：阶段结束读 `context_usage_ratio` 写进 span meta；单任务链路累计超阈值（建议 0.6）时，下一实例改用
  「产物 + 摘要」重建而非继续 fork。credits 作为成本口径（V7），不要用 token。
  —— 已落地（P4-3）：`CONTEXT_BUDGET_RATIO = 0.6`（deps 可注入，仅单测拿边界值），按 `stageInstanceId` 记 ratio；
  判定发在下一阶段**起跑前**（fork 方案算好之后、读盘之前），超阈值 → `mode:'new'` +
  `fallback:'context-budget'` + 一条任务事件（降级不许静默）。注意 V8：headless 会话不自动压缩，
  所以 fork 是「继承前缀」而不是「丢弃前缀」—— 父会话过满时全量重建才是便宜的那条。
- 隔离：所有 task 会话显式 `settingSources: ['project']` + `skills` 白名单（V9 能去掉 user 级）；
  plugin 级注入本轮**只登记不处理**，需要确认 `--strict-mcp-config` / `plugins` option 能否覆盖。
  —— **结论修正：这条不应该照原样做**，原因是实测收益与代价严重不匹配：
  ① 收益只有 0.1% 上下文（V8 的 `categories.skills = 0.1%`；本机用户级技能就 1 条 `~/.qoder/skills/naiveui-refactor-helper`）；
  ② SDK 注释明写 `skills` 是 **context filter, not a security boundary**（unlisted 技能的文件仍在盘上、可被 Read/Bash 读），
  所以它不构成安全边界，不该被当成 P4 权限的一部分；
  ③ V9 已证明 plugin 级（3 项）**压不掉**，`settingSources` 只管 user/project/local 三源；
  ④ 任务会话不传 `mcpServers` / `settings`（代码 grep = 0，只有 driver 与 task-intake 传），而 SDK 里
  `settingSources` 与 `strictMcpConfig` 是**两个独立开关** —— 说明 `settingSources` 只管
  `user/project/local` 三类 filesystem settings，**不管 MCP 配置**（否则 `strictMcpConfig` 多余）。
  所以「切 project 会不会连带把用户 `~/.qoder/mcp.json` 里的 server 弄没了」**尚未实测**，
  属于补做之前必须先跑的一条（暂定 V15）；本文不拿它当结论。
  ⑤ 对话侧的技能根机制也不适用：它靠 `env.QODER_CONFIG_DIR = dataDir`（[qoder-chat-driver.ts#L413-L419](../apps/desktop/electron/pi-extension/qoder/qoder-chat-driver.ts)），
  而整个 `QODER_CONFIG_DIR` 一换，会话存储根也跟着换（V14 的 sweep 就不再命中）。
  所以本项从「待落地」改为「先可观测」：把 init 回报的 `skills` 名单随 `cliVersion` / `capabilities` 一起落进阶段 span meta
  （字段位置已有，[qoder-task-agent.ts#L1150-L1152](../apps/desktop/electron/pi-extension/qoder/qoder-task-agent.ts)），
  等能看到“任务会话里实际混进了几条”再决定要不要动旋钮。
  —— **可观测这半步已落地**：span meta 增 `skills`（仅在回报非空时写，不给 Trace 添空字段）。
  剩下的只有 V15（`settingSources:['project']` 对 MCP 的实际影响），在拿到数据前不动旋钮。

## 6. Pi / Qoder 一致化

**结论：两条运行时在会话原语上是对称的**，之前不对称的是我们自己的桥接层。

- Qoder：`resume / forkSession / resumeSessionAt`（§1 V1–V4 已验）。
- Pi：`SessionManager.forkFrom(sourcePath, targetCwd, sessionDir, options)`、
  `createBranchedSession(leafId)`、`SessionManager.inMemory(cwd)` —— **原生就有**分叉与按叶子分支，
  而我们在 [pi-session.ts#L450-L460](../apps/desktop/electron/task/pi-session.ts) 把 `fork` / `newSession` / `switchSession`
  全 stub 成 `{ cancelled: true }`。

接口收敛为一次「按阶段实例执行」：

```ts
type StagePhase = 'plan' | 'implementation' | 'test'

interface TaskAgentDriver {
  /** driver 声明自己支持的能力，编排层据此选降级链，不再靠 throw 协商。 */
  capabilities(): { fork: boolean; truncateAt: boolean; perPhasePermission: boolean }
  runStage(ctx: {
    task: Task
    phase: StagePhase
    stageInstanceId: string
    parent?: { sessionId: string; anchorEntryUuid?: string } // 缺省 → 全量 prompt 重放
    input: { planPath: string; changedFiles: string[]; instructions: string }
    signal: AbortSignal
  }): Promise<StageOutcome>
  collectResult(stageInstanceId: string): StageOutcome
  dispose(stageInstanceId: string): void // 从 dispose(taskId) 改过来
}
```

顺序（每步都能独立发布）：

1. **Pi 会话 registry 化**：去掉 `activeTaskId` / `activePlanningTaskId` / `activePlanText` 三个进程级单例
   （[pi-session.ts#L66-L71](../apps/desktop/electron/task/pi-session.ts)），否则统一接口只会得到满是可选方法的假抽象。
2. driver 接口切到 `runStage`，Qoder 先实现 fork，Pi 用 `forkFrom` 对齐；`runPlan/runImplementation/runTestGeneration?` 三个方法退役。
3. 删 `main.ts` 里 9 处 `runtimeProvider(task) === 'qoder'` 分支中的阶段相关项（阶段级差异由 capabilities 承担）。

## 7. 分期

### P0 — 与方案无关，立刻可合（各一处改动）

- Exec 注入 `planContent`（修 §2.1 的静默丢弃）：[qoder-task-agent.ts#L305-L327](../apps/desktop/electron/pi-extension/qoder/qoder-task-agent.ts)
- Pi 任务的 Test 阶段补 provider 分支，停止借用 Qoder 运行时：[task-lifecycle.ts#L421-L435](../apps/desktop/electron/task/task-lifecycle.ts)
- reset 时同时清 `qoderSessionId`（现在只清 `piSessionPath`）：[task-workflow.ts#L551-L561](../../packages/integrations/src/task-workflow.ts)
- Trace span meta 增 `cliVersion` / `capabilities` / `contextUsageRatio` / `credits`（跨机器对不上的根因治理）
- 复核 V12：确认打包环境实际 transport，必要时显式 `transport` 并回归 asar 相关修复

### P1 — 阶段实例化（不改产物契约）

`StageInstance` 标识 + Plan→Exec fork + anchor 算法 + 三级降级链 + 清理 `qoderSessionId` 语义。
同步改测试断言（`qoder-task-agent.test.ts` 的「三阶段共享会话 / `__queryCalls.length === 1`」需要反过来锁）。

### P2 — 交接契约

`<dataDir>/tasks/<taskId>/` 落盘 + sha256 对账 + plan.md 三段扩容 + 存量缺省降级 + Exec→Test fork。

### P3 — Pi 对齐与接口收敛

Pi registry 化 → `runStage` → 删 provider 分支 → 解除 `fork` stub。

### P4 — 权限与治理

阶段级 permissionMode / disallowedTools、`evaluateExecutionPermission` 加 phase、上下文预算、会话 sweep。

### 7.5 落地记录（P0–P4 已合入，逐条对照本方案）

状态：P0–P4 全部完成（含 P4 复测后补做的三项，见表末与 §4.4 / §5 / §6 的对应段落）。下面是**实现与本文件的差异**
（其余项按原文完成），只记不一致的地方，不重述设计。

| 项            | 与原方案的差异                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3.1 实例标识 | 实际是 `${taskId}:${phase}:${seq}`（**没有 `attempt` 段**）：attempt 与重跑在阶段实例内统一用 `continue`/`resume`，不入 id；否则一个阶段实例会因重跑而分裂，锁不住「阶段 = 会话」。                                                                                                                                                                                            |
| §6 接口       | `runStage(input)` 的入参形状保留驱动层现状（`phase` 用 `TaskAgentPhase`，`test_generation` 经 `stagePhaseOf()` 映到 `'test'`）；`dispose(stageInstanceId)` 落地为 `releaseStage(stageInstanceId)` + 任务级 `closeSession(taskId)`。`capabilities()` 三项已接，Qoder 报 `{fork:true, truncateAt:true, perPhasePermission:true}`。                                               |
| §4.3 三段     | 三段齐才拆 Exec 的规则只用于**创建时**；存量计划缺三段时，P4-1 带来一个必须改的旧行为：不能把只读的活 plan 会话直接交给实现阶段（它改不了文件）。现修法：关旧会话 + 按 `sessionId` resume（前缀照样继承，只重建工具权限）。                                                                                                                                                    |
| §7 P1         | 额外加了两条降级档：`session-lost` / `plan_schema_incomplete`，P4 再加 `context-budget`（都是「起跑前就能判定」的档，不占重试名额）。                                                                                                                                                                                                                                          |
| §6 Pi fork    | 「解除 fork stub」原文没规定**失败形态**。实测 `SessionManager.forkFrom` 在源文件不合法时直接抛 `Cannot fork: source session file is empty or invalid`（V13），会一路上抛打断阶段执行。现修法：`forkPiStage()` 返回 `{file?}/{error?}` 且不抛，driver 退化成新开会话（`sessionMode:'new'`，不谎报 fork）+ 一条 `logStage` 带原因 —— 与 Qoder 侧「fork 失败只降级不失败」对齐。 |
| §5 上下文预算 | 只做了 Qoder 侧：`context_usage_ratio` 是 qodercli 才有的字段，Pi 会话没有同名信号（用量走 `session_usage`，另一条口径）。所以下游实例超预算重建仅在 Qoder 链路上成立，Pi 侧 `capabilities()` 不报这一项。                                                                                                                                                                     |

一个实现层细节值得钉住：`planLaunch` 里「关上一阶段会话」必须排在**任何 `await` 之前**。先 `await` 再关，
旧会话会趁让出的那一拍继续读自己的输出流，把本该属于新会话的内容吃进已废弃的回合缓冲（单测里直接
表现为新会话挂死）。

另一条同类坑，落地后核对时才发现的：`forkPiStage` 从 `string | undefined` 改成 `{file?}/{error?}` 时，
除了 driver 还有**第二个消费点** —— Pi 内置命令 `/fork` 的 `commandContextActions.fork`（[pi-session.ts](../apps/desktop/electron/task/pi-session.ts)）。
它原先按 `if (!forked) return { cancelled: true }` 判空，改成对象后 `{error}` 也是 truthy → 失败时反而对外报「已分叉」
并在不换会话文件的前提下重开会话。现在按 `!forked.file` 判。**把「返回 undefined」改成「返回对象」时，
判空点必须全仓 grep**，单测只盖住 driver 那条路径。

一条已知限制，别当成已做完：两条 sweep 的工作区根都只取**当前** `dataDir`。改过应用名之后的历史会话
（V14：Qoder 侧 36 条 cwd 还指向旧 `@coding-agent/desktop`）归因不到任务，会永远保留 —— 它们不匹配「本应用任务
工作区」这条护栏，删不了也不能猜。真要清就得先加一份旧 dataDir 根列表，本轮不做。
本机 Pi 侧不在这条限制里：现存 3 个文件的 header.cwd 都指向当前 `TaskPipeline/data/workspaces/`，且三个 taskId
（`129f5874…` / `7a3dd498…` / `440d876b…`）都不在 DB 的 2 个任务里、mtime 超过 14 天 → 下次启动 sweep 会全部清掉。

Pi 侧还有一个**覆盖不到而不是写错了**的形状：`piWorkspaceCwd(taskId)` 在没有 worktree 时会退到
`repo.localPath`（用户仓库本身），这种会话文件的 header.cwd 就不在任务工作区根下 → 按护栏必须保留，
任务删除时的即时级联对它无效（只能等 `deletePiTaskSessionFile` 按指针删当前那一份）。不能改成“按 localPath 也删”：
那会直接撞上用户自己的对话会话（§4.4 那条护栏的原始理由）。

### 7.6 未落地 / P5 候选

P4 复测后新识别的三项 —— Pi 会话孤儿 sweep、`forkPiStage` 降级链、`skills` 落进 span meta —— **已补做完成**，
分别归位到 §4.4 / §6 / §5，不再挂在待办里。剩下的三条都是「等条件」而不是「等实施」：

1. V15：`settingSources: ['project']` 会不会连带切断用户级 MCP。§5 的隔离旋钮在拿到这条结论前不动；
   `skills` 的可观测已就位，先看真实任务会话里实际混进几条，再判要不要继续推。
2. 旧任务的三段补写（一次性迁移）：目前靠 `plan_schema_incomplete` 降级，不拆边界也不拆权限。
3. §7 验收指标的真实数值：需要一个带真凭证的任务链路跑一轮才能填。
4. `collectResult(taskId, phase)` 收尾：接口上已注明「新代码应直接用 `runStage` 返回值」，而 grep 确认
   **线上零真实调用方**：只有 `qoder-task-agent.test.ts`（13 处断言）在调，加上 `QoderOrchestrator.collectResult`
   那个转发壳（它自己也没人调）——两个都是死层。要么删干净并改测试断言，要么就别留在接口上。
   本轮没动：它是 P3 接口收敛的唯一尾巴，删它会连带动 13 处测试与一个 orchestrator 方法，与本期目标无关。

### 验收指标（都用 V7 确认可拿到的字段）

| 指标                                   | 现基线                       | 目标                                      |
| -------------------------------------- | ---------------------------- | ----------------------------------------- |
| 阶段首条 span 的 `context_usage_ratio` | 未采集                       | 采集后定基线；Exec 不该显著高于 Plan 尾值 |
| 阶段内 Read 重复率                     | 同阶段重跑 60–80%            | fork 后跨阶段重复 → 0                     |
| 已批准计划 vs 实际改动偏差条数         | 无法测（planContent 未注入） | 每条人工编辑都能对账                      |
| `credits` / 任务                       | 未采集                       | 定阈值，超阈值告警                        |
| fork 失败降级率                        | —                            | < 5%，且降级原因 100% 有 Trace 事件       |

## 8. 不做什么

- 不引入 codegraph / 代码索引：上一轮它是**零使用**被删的（工具调用次数 0，旧包无 Vue 支持），且候选方案自报
  「省 62% token 但 +80% 上下文残留」，与阶段边界目标相反。等 §7 指标证明前缀没继承住再重议。
- 不改用系统环境 qodercli（已明确搁置）。
- 不做「跨阶段追问」（"Exec 你为什么没按第 3 条做"）——那是产物对账要解决的，不是共享会话。
- 不动 Review / Validate / Deliver / 记忆整理的无会话模型。

## 9. 风险与推翻条件

| 风险                                                              | 处置                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| fork 是否保住 prompt prefix cache **无法证实**（没有 token 数据） | 用 `credits` 间接观察；若阶段拆分使单任务 credits 上升 > 30%，回退为「Plan+Exec 共享」但**保留产物契约**（§4 独立有价值） |
| `WorkerTransport` 下会话/权限行为与打包后不一致（V12）            | P0 复核项；若两条 transport 语义分叉，则 fork 必须锁定在验证过的那条上                                                    |
| 阶段实例数膨胀（auto-fix 多轮 × 重试）导致会话文件暴涨            | `stages/*.json` + `deleteSession` 级联清理；必要时同阶段续接改为「摘要 + 新会话」                                         |
| anchor 算法在真实长会话（含子 Agent、queued prompt）上被 V3 拒绝  | 降级链第 2 档已覆盖；拒绝原因要落 `plan` 事件供复盘                                                                       |
| Lite/auto 之外的模型开始上报 token（V7 口径变化）                 | `context_usage_ratio` 与 credits 继续可用，不阻塞；预算判据届时重算一次                                                   |

## 附录：复现验证

一次性验证脚本已入仓（都只读写临时目录，`list` 模式对真实数据只读）：

```bash
node scripts/pi-fork-probe.mjs                       # V13：Pi forkFrom / createBranchedSession 语义
node scripts/qoder-session-store-probe.mjs list      # V14：listSessions 聚合、cwd 归因、目录名编码
QODER_CONFIG_DIR=$TMP node scripts/qoder-session-store-probe.mjs synthetic \
  <list 采到的目录名> <对应 cwd>                     # V14：deleteSession 的 dir/UUID 约束
```

手动步骤（V1–V12，需要真 token）：

1. 取 DB 里 `qoderToken`（`encrypted:v1.…`）+ `dataDir/install.key`，AES-256-GCM，AAD = `'qoderToken'`（见 `packages/core/src/crypto.ts`）。
   也可用 `env:` 前缀让 `LocalFileKeyStore` 从环境变量取，避免读盘。
2. 在仓库 cwd 下起 SDK：两轮埋词 → `getSessionMessages` 取 uuid → 四种组合（plainFork / atOnly / atPlusDrop / 错误用法）对比。
3. 判定：`seesA && !seesB` = 截断生效；`seesA && seesB` = 继承生效；`Resume rejected by --resume-drops-turn` = anchor 选错。
4. 顺带采集 `getContextUsage()` 与 `result.usage.context_usage_ratio` / `modelUsage[*].credits`。
   ⚠️ 会话会永久留在 `~/.qoder/projects/`，验证完记得 `qodercli --list-sessions` / `deleteSession` 回收。
