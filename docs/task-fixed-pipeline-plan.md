# Task 模式收缩：固定链路 + 单层执行权限

> 状态：**实施中**（PR 0 / 1 / 3 / 4 已落地；PR 2 暂缓；PR 5–7 待做。实测结果见 §10）。
> 范围：任务链路的阶段编排、配置面、执行期权限模型、设置页「任务自动化」区。
>
> **v3 修订**（按最新确认的四条结论）：
>
> 1. 计划审批固定为**人工闸门**——取消上一版的 `autoApprovePlan`；
> 2. 因此**取消 `fast / standard / strict` 严格度 enum**，配置面收缩到只剩 1 个任务级选项（提交 MR）；
> 3. 对话侧那条路不是 task，本轮不碰；新增链路第 0 段「创建任务时的对话式完善」（§2.4）；逐仓库 Agent 覆盖补列救活（PR 0）；
> 4. 执行期不再靠 `canUseTool` 正则拦断，**把执行环境整体放进 Docker**（§4.5）；L1 降为容器不可用时的兜底。
>
> 上一版关于「Agent 三级解析全部保留」的前提不变。
>
> **v4 修订**（按四个待确认项的回答）：准备命令时机**维持现状**（不重排 `preparing` / `planning`，见 §2.1）；
> 存量未完成任务**接受**开始跑测试与 Review（不留豁免入口，§5.2）；`draft` 澄清对话取**缺项才提示**（§2.4）；
> 容器性能退路取「慢 3 倍则读写留本机」——但该粒度**仅 Pi 引擎具备**，已改写 §4.5 / §9。
>
> **v5 修订**：§9.2 的容器性能退路**只记录不决策**，因此 **PR 2（容器化）暂缓启动**；
> 执行期的安全边界先由 §4.6 的 L1 拦断单独承担（一周期后实测再定）。其余按 §8 顺序实施。

> **v6 修订**（PR 3 / PR 4 落地时校正）：实施中撞到三处与本文档不符的事实，已按实际改回——
> §6.3 的「删 `reviewAutoFixEnabled()` / `reviewAutoFixMaxRounds()`」不成立（§3.1 与 §5.1 本来就要求这两个键继续读）；
> `reviewFixCount` 和 `repoAgentIds` 是同一类丢写（§1.4 附注）；`resolveMrMode()` 判定落在 core、注入点落在 `TaskWorkflow.mrMode()`。
> 全部差异汇总在 §10。

---

## 1. 背景：现在到底散在哪

### 1.1 同一个语义被配了三遍

| 配置位置                 | 控件                                                                                      | 落盘位置                                              |
| ------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 设置 → 通用 → 任务自动化 | `openCodeReviewEnabled` / `createTestCasesEnabled` / `autoCreateMergeRequests` Switch × 3 | `settings` 表                                         |
| 同上                     | `reviewAutoFix` / `reviewAutoFixMaxRounds` / `deliveryConfirm` Switch + number            | `settings` 表                                         |
| 开始任务 → 高级设置      | 上述前 3 个的「沿用 / 开启 / 关闭」三态控件 × 3                                           | `tasks` 表 3 个列                                     |
| 开始任务 → 高级设置      | 执行 Agent「跟随仓库 / 指定 / 禁用」三态                                                  | `tasks.agent_profile_id`                              |
| 开始任务 → 每个仓库面板  | 逐仓库 Agent + setup / lint / test / build 命令                                           | `task_repositories`（`repoAgentIds` 未落库，见 §1.4） |
| 开始任务 → 顶部          | 「直接开始 / 先生成计划」双卡                                                             | `tasks.start_mode`                                    |
| 任务对话框 / 输入框      | HITL「询问 / 自动 / 全自动」三态                                                          | `tasks.hitl_mode`                                     |

一次任务启动实际要做的决策：**9 组**，其中 5 组是三态。

### 1.2 真正的代价：链路形状可变

| 消费点                                       | 开关为假时的行为                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `task-runner.ts` › `advanceAfterValidation`  | 不跑 review，直接 `awaiting_review -> awaiting_commit` + `reviewStatus: waived` |
| `task-lifecycle.ts` › `finishImplementation` | 不进 `generating_tests`，`implementing` 直接到 `validating`                     |
| `task-workflow.ts` › `begin(taskId, mode)`   | `mode === 'direct'` 时整条 `planning -> awaiting_plan_approval` 不进入          |
| `advanceAfterValidation` 末段                | 关时不提交 MR，停在 `awaiting_commit`                                           |

后果：

1. **续接要按组合特判**。`task-lifecycle.ts` › `resumeTask` 里的
   `failedDuringPlanning = failureStage === 'planning' || (startMode === 'plan' && !planContent)`，
   两个条件说的是同一件事，却因为存在两条进入路径而必须写两遍。
2. **状态机里有一条纯 skip 边**：`awaiting_review -> awaiting_commit` 只为「不跑 Review」存在。
3. **同一次任务两次跑出不同链路**，Trace / Timeline 的阶段对齐失去可比性。
4. **第二宿主重复实现**：`packages/pi-package/src/index.ts` 的 `task-start` 命令自己弹
   `先生成计划 / 直接开始`，再自己调 `begin(task.id, mode)`、自己弹计划审批。
5. **`begin()` 是四元位置参数**（`taskId, mode, overrides, signal`），5 个调用点，其中
   `resumeTask` 传的是 `begin(taskId, 'plan', undefined, signal)`。`mode` 一撤后两位集体左移，
   占位的是 `undefined`，TS 报不出来。

### 1.3 顺带发现的一处死配置

`packages/core` › `blockingSeveritiesFor(level)` 支持 `critical / high / medium`，但唯一的构造点
`apps/desktop/electron/services/review-delivery.ts` › `buildReviewOrchestrator()` 从不传
`reviewBlockingLevel`，于是恒为默认 `critical + high + error`；同时 `task-runner.ts` ›
`collectReviewComments()` 又硬编码了同一份数组。**同一条规则两处实现，其中一处不可达。**

### 1.4 意外发现：最高优先级的 Agent 覆盖根本没存盘

`repoAgentIds` 链路看着是完整的：TaskEditorDialog → `api.startTask` → `ipc tasks:start` →
`store.updateTask(taskId, { repoAgentIds })` → `agent-service.resolveAgentFor(..., task.repoAgentIds?.[id])`。

但 `db.ts` 里**没有 `repo_agent_ids` 列**——INSERT 清单、UPDATE 清单、行映射三处均不含它。
`updateTask` 先把 patch 合进内存对象再跑固定列 SQL，所以**本次调用看着成功，下一次 `getTask` 读回 `undefined`**。
三级解析里最高那级永远是空，4 个 `resolveAgentFor` 调用点全在传恒为 `undefined` 的第三参。
既然本轮决策是「三级都留」，补这一列属于前置修复，见 §8 的 PR 0。

同一个 grep 顺带查出**第二处同类丢写**：`Task.reviewFixCount` 也没有列（`db.ts` 里查不到
`review_fix_count`），而 `task-lifecycle.ts` 有 3 处写入、1 处读取，用它做 Review 自动修订的轮数上限。
实际效果是**上限只在单次运行内生效，重启即归零**，`reviewAutoFixMaxRounds` 形同虚设。
补列与 `repo_agent_ids` 同性质，落在 PR 3（见 §8）。

---

## 2. 目标链路

### 2.1 你给的链路映射到状态机

| #   | 链路阶段              | 状态机落点                                                          | 驱动方                                                      |
| --- | --------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | 任务创建（Jira+对话） | `draft`（看板 Todo，**不进编排**）                                  | 导入：`importJiraIssue`；完善：`draft` 内的澄清对话（§2.4） |
| 2   | 生成计划              | `preparing -> planning -> awaiting_plan_approval`                   | `begin()` + `runPlan` / `runOpenAIPlan`                     |
| 3   | 确认并执行            | `awaiting_plan_approval -> preparing(setup) -> implementing`        | `approveTaskPlan()`，**固定人工**                           |
| 4   | 执行计划              | `implementing`                                                      | Qoder 常驻会话 / Pi session                                 |
| 5   | 测试用例编写并测试    | `implementing -> generating_tests -> implementing -> validating`    | `runTestCases` + `runCommands('validation')`                |
| 6   | CodeReview            | `awaiting_review -> reviewing -> awaiting_commit \| review_blocked` | `runReviewWithAutoFix`                                      |
| 7   | 提交 MR               | `awaiting_commit -> delivering -> await_merge -> completed`         | `submitMergeRequests`，**唯一可配置**                       |

三处对不上，口径已定（本轮四条结论之一即落在第一条）：

- **阶段 3 的「确认」被拆成了两步——本轮定为维持现状。** `approveTaskPlan()` 之后才进 `runSetup`（跑准备命令），
  失败落 `failed` 而不是回到计划确认。曾考虑把 `preparing` 归入计划阶段（`begin()` 时就跑完），
  **已否决**：那要改 3 条转移边，收益只是失败语义更好读。风险/收益不划算，§5.3 的结构性改动因此取消。
  代价明确记录在案：准备命令失败时你看到的是「任务失败」而不是「计划待重新确认」，需手动重试。
- **阶段 5 的「并测试」不在测试阶段里。** 写用例在 `generating_tests`，**跑**是在后面的 `validating`
  跑 `testCommand`。见 §2.3。
- **阶段 7 之后没有「合并」**。`await_merge` 只刷新 MR 状态，`completed` 由人工完成或 MR 合并轮询写入。
  本方案不动这段。

### 2.2 必经的定义

「必经」= **必然进入该 state**，不等于必然执行动作。只允许因**结构性前置条件**（缺命令、缺凭据、
无改动、已被覆盖）no-op，不允许因用户偏好整个绕过。no-op 必须落一条事件，
让 Trace / Timeline 能看到"这个阶段来过、为什么没做"。

| 阶段       | 唯一允许的 no-op 判据                                | 事件                                        |
| ---------- | ---------------------------------------------------- | ------------------------------------------- |
| 计划       | 无（Agent 判定已满足则直接 `completed`，属正常出口） | —                                           |
| 计划确认   | 无，**任何档位都等人工**                             | —                                           |
| 实现       | Agent 判定且宿主复核为 0 改动                        | 沿用 `completeImplementationWithoutChanges` |
| 测试（写） | `runTestCoverageCheck()` 返回已覆盖                  | 沿用「检测到已有测试覆盖，跳过生成」        |
| 测试（跑） | 所有仓库 `testCommand` 为空                          | 「未配置测试命令，跳过执行」                |
| 校验       | lint / test / build 三命令全空                       | 「未配置校验命令，跳过校验」                |
| Review     | 所有关联仓库 `deliveryStatus === 'unchanged'`        | 「无代码改动，Review 跳过」                 |
| 提交 MR    | 无 remote / 无 GitLab 凭据                           | 「仓库不具备交付条件」                      |

### 2.3 「测试用例编写并测试」的写/跑分离

现在这两个动作分处两个 state，且**跳过判据不同**：覆盖检测判定"已覆盖"只跳过「写」，
`validating` 仍会跑 `testCommand`。这与"编写并测试"的期望其实是一致的（有覆盖就该跑一遍验证），
但界面上完全看不出来——`generating_tests` 跳过后，Timeline 只显示"跳过生成"，
用户会以为测试整个没做。

本轮已定为 **(a)**：保持两个 state，把 `validating` 的事件文案改成「执行测试 / Lint / Build」，
明确它跑的就是阶段 5 的"测试"；`generating_tests` 跳过时的事件补上「已有覆盖，仅执行不新增」，
使 Timeline 能读出"测了，只是没重写"。不动状态机。

### 2.4 链路第 0 段：创建任务时的对话式完善（本轮新增需求）

对话 plan 模式那套不属于 task，本轮不管。这里要的是另一件事：**task 自己创建时，
表单填不出来的部分（描述不完整、验收标准缺失、该关联哪些仓库）需要通过与 Agent 对话补全，
而不是手填。** 现有积木把这条路堵住了，缺口很具体：

| 积木                                | 现状                                                                            | 缺口                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `TaskComposer`（详情页输入框）      | 已存在，`DetailPanel.tsx:410` 仅 `activeTab === 'activity'` 时渲染              | `canChat`（`DetailPanel.tsx:190`）不含 `draft`，创建后无法开口                   |
| `sendTaskMessage` → `tasks:message` | 已存在，走 `runTaskOperation` + `qoderOrch.sendMessage`                         | 状态白名单（`task-lifecycle.ts:809-818`）不含 `draft`                            |
| 上面那个函数的语义                  | 第 827 行会把状态强推到 `implementing`                                          | 它是「实现期跟进」不是「澄清期对话」，不能复用同一入口                           |
| 会话载体                            | `QoderSession` 按 `taskId` 常驻，`cwd = worktreePath`                           | `draft` 阶段还没建 worktree（`preparing` 才建），无 cwd；也不能复用实现会话      |
| 回写任务字段                        | `store.updateTask` / `api.updateTask` 存在                                      | **Agent 侧没有任何工具能写回 `description` / `acceptanceCriteria` / `keywords`** |
| 可参照的交互                        | `AgentDialog.tsx` 的「AI 生成」：生成 → AlertDialog 确认覆盖 → `applyGenerated` | 那是单轮生成不是多轮对话，但「不直接覆盖用户输入」这个模式可直接复用             |

要做五件事：

1. **独立的澄清会话**：按 `${taskId}:intake` 建 `QoderSession`，`cwd` 用已选仓库的 `localPath`
   做只读分析，不进 worktree（那时还没有）；`begin()` 进 `planning` 时关闭它，
   保证实现阶段拿到干净上下文。
2. **新增回写工具 `updateTaskDraft`**：入参 `{ title?, description?, keywords?, acceptanceCriteria?, repositoryIds? }`，
   经 `ToolSource` 注入 driver（与 `createJiraIssue` 同一套接线），宿主侧校验后写库，
   并落一条事件记录改了哪些字段（进 Timeline / Trace）。
3. **写回不静默覆盖**：Agent 的产出先进入表单上方的「建议区」（逐项可采 / 可丢弃），
   用户点「应用」才落库。理由：`draft` 字段是人手填的，模型直接盖写会把人写的东西抹掉。
   这比 `AgentDialog` 现在的整块「覆盖 / 保留」AlertDialog 更细，因为这里是四个独立字段。
4. **`draft` 放开两处白名单**：`canChat` 增 `draft`；`sendTaskMessage` 拆为
   `sendTaskIntake(taskId, message)` 与现有函数两个入口，澄清入口**不改任务状态**。
5. **缺项才提示（已定）**：平时不开口。判据三条取或：`description` 长度 < 40 字、
   `acceptanceCriteria` 为空、未关联任何仓库。命中时在输入框上方亮一行「这几项可以让 Agent 补」，
   **点击才发起会话**，不自动发言、不自动花 token。理由：`draft` 是高频入口，每次都发言会变成干扰。
   同理，Agent 的补全一律走「建议区 + 逐项应用」，不允许直接改表单。

与固定链路的关系：这段全部发生在 `draft` 内部——**不加 state、不加转移边、不改 `TASK_STATES`**。
`begin()` 仍恒进 `planning`，只是进链路之前任务定义已经被对话补全过了。
§2.1 表格里的阶段 1 从「不进编排」修正为「不进编排，但可在 `draft` 内写回 task 字段」。

---

## 3. 配置面：只剩一个

### 3.1 取消严格度 enum

上一版提的 `fast / standard / strict` 有 6 个维度。在"计划必经人工确认 + 测试与 Review 必经"之下，
只剩「Review 严格程度」和「MR 是否自动提交」两条还有区分度，三档 enum 就退化成"两个布尔穿了件外套"。
**取消 enum**，改为：

| 配置              | 位置              | 取值                                            | 取代                                                 |
| ----------------- | ----------------- | ----------------------------------------------- | ---------------------------------------------------- |
| **Review 通过后** | 任务级 + 系统默认 | `自动提交 MR` / `停住，我手动提`                | `autoCreateMergeRequests`（3 处）+ `deliveryConfirm` |
| Review 阻断级别   | 仅系统设置        | `critical` / `high` / `medium`                  | 原先不可达的 `reviewBlockingLevel`，本轮接通         |
| Review 自动修订   | 仅系统设置        | 开关 + 轮数上限（1–10）                         | `reviewAutoFix` / `reviewAutoFixMaxRounds`           |
| 执行环境          | 仅系统设置        | 沙箱开/关 + 镜像（网络固定 `default`，不做 UI） | 无人可写的 `sandboxImage` / `sandboxNetwork`（§4.4） |

`openCodeReviewEnabled` 与 `createTestCasesEnabled` **整体删除**——阶段已必经，开关没有可关的东西了。

### 3.2 收缩后的启动对话框

```
标题 / 描述 / 关键词 / 验收标准
仓库选择（含"使用全部 system 仓库"确认）
Review 通过后： [ 自动提交 MR ]  [ 停住，我手动提 ]     ← 唯一新增的卡片
开始任务                                                        ← 不再有「直接开始 / 先生成计划」
高级设置 ▸（默认折叠）
   ├ 执行 Agent：跟随仓库 / 指定 / 禁用              ← 保留
   ├ 逐仓库 Agent 覆盖                               ← 从仓库面板移到这里
   ├ 逐仓库 setup / lint / test / build              ← 保留
   └ 执行环境：Docker 沙箱（不可用时回退本机并恢复拦断） ← 只读展示，无开关
```

主决策从 9 组降到 **1 组**。设置页「任务自动化」区从 6 个控件降到 3 个（阻断级别、自动修订、轮数），
且 HITL 三态从任务侧移除（见 §4）。

---

## 4. 执行期权限与执行环境

### 4.1 现状是三条互不相通的闸门

| 闸门               | 位置                                                            | 是否读 `hitlMode` | 行为                                                                                              |
| ------------------ | --------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| Qoder 任务执行     | `pi-extension/qoder/qoder-orchestrator.ts` 的 `canUseTool` 回调 | 是                | `yolo` → 全放行；否则**只在 `isDangerousTool` 命中时**弹                                          |
| 对话工具调用       | `chat/chat-init.ts` 的 `canUseTool` 回调                        | 是                | 三档真实区分：`ask` 连 `bash/edit/write` 和 MCP 写工具一律确认                                    |
| Pi/OpenAI 任务执行 | `packages/pi-package/src/permission.ts` › `evaluatePermission`  | **否，完全不读**  | `blockedCommands` 恒 block；`git commit/push`、`glab mr create`、`npm install`、`curl` 恒 confirm |

### 4.2 两处语义失真，必须先修，否则"改成 yolo"是个假动作

1. **任务路径的 `ask` 和 `auto` 是同一个东西。** Qoder 任务回调里没有 `isWriteTool` / `isBuiltinWriteTool`
   分支，非 `yolo` 一律走 `isDangerousTool`。`hitl-mode.ts` 顶部注释写的「ask（默认）：所有写操作需确认」
   只对**对话**路径成立，对任务路径是错的。
   → 所以"任务执行少弹点框"目前**没有**从 `ask` 调到 `auto` 这条路，只有 `yolo` 一档，
   而 `yolo` 是全开。三档在任务侧实际是一档半。
2. **Pi 路径选 yolo 也照样弹。** `evaluatePermission` 不接 `hitlMode`，
   `install` 类命令和交付命令恒 confirm。走 OpenAI 引擎的任务，用户切了 yolo 什么也没变。

### 4.3 真正让人烦的是 `mv`

`isDangerousTool` 的拦截集是「工具名含 `delete|remove|unlink|rename|\bmove|\brm`」+「bash 串里含 `rm|rmdir|unlink|mv|git rm|-delete`」。重构类任务里 `mv` 和单文件 `rm` 是高频动作，
每一次都弹框。这是"任务执行 HITL 太多"的真实来源，不是档位名字的问题。

### 4.4 沙箱现状：代码在，桌面端完全没接

原以为只是"沙箱不覆盖 Qoder 路径"，盘点发现比这更彻底：

| 事实                                                                      | 证据                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------- |
| `DockerToolRouter` 只在 `packages/pi-package` 存在，Electron 主进程零命中 | `grep sandboxRouter` → `apps/desktop/electron` 0 结果 |
| `sandboxImage` / `sandboxNetwork` 两个设置项**无任何 UI 可写**            | `apps/desktop/src` 零命中                             |
| `sandboxStatus` 只写不读                                                  | 仅 `pi-package/src/index.ts:141` 一处 `setSetting`    |
| 镜像入口是 `ENTRYPOINT ["pi"]`                                            | `docker/Dockerfile:20`                                |

所以沙箱现在是"代码在、配置入口没、桌面任务不经过"的状态。`Dockerfile` 里倒是已经装了
qodercli（`QODER_INSTALL_URL`），具备把整个 Agent 关进容器的镜像基础。

### 4.5 目标：把执行环境整体放进 Docker（**PR 2 暂缓，本节先作为设计记录**）

这是本轮的方向修正：**安全边界交给容器，而非交给 `canUseTool` 里的正则**。应用层只保留
「越出本任务 worktree 集合」这一条路径判定（因为 bind mount 就是同路径挂载，越界写仍会真落到本机）。

接缝是现成的，SDK 直接支持替换子进程启动方式：

```ts
// node_modules/@qoder-ai/qoder-agent-sdk/dist/types/options.d.ts
pathToQoderCLIExecutable?: string
spawnQoderCLIProcess?: (options: SpawnOptions) => SpawnedProcess   // { command, args, cwd, env, signal }
```

`ProcessTransport` 把 command/args/env/cwd 交给这个回调，自己只要求返回一个带 stdio 管道、
会 `emit('error'|'exit')` 的 ChildProcess 形状对象。所以不需要 wrapper 脚本包一层，
`QoderSession` 直接传一个基于 `docker exec -i` 的 spawner 即可（`DockerSandbox.execResult` 已经是这个形态）。

必须先解决的四件事，按风险排序：

1. **认证 payload 是容器外的临时文件。** SDK 的 `RuntimeLaunch.prepare()` 会 `mkdtemp(os.tmpdir())`
   写一个 auth payload 并把路径当作 CLI 参数传下去（`authPayloadPath`）。macOS 下那是
   `/var/folders/…/T/…`，`DockerSandbox.start()` 只 `--mount` 了 worktrees（同路径 bind），
   容器内 qodercli 看不到这个文件 → **直接认证失败**。需要把 payload 目录归到可挂载路径下
   （或额外挂一个 tmp 目录，同路径）。
2. **`resume` 会碎。** `runImplementation({ resume })` 的重试续接依赖 CLI session 文件
   （transcript 落在用户目录下的 `projects/<key>/<uuid>.jsonl`）。容器内写的 session 文件
   容器一 `docker rm -f` 就没了 → 重试/续接全失效。需要把该目录也同路径挂进去，
   或者放弃容器内 `resume`、改为每阶段新建会话并重送上下文。
3. **降级语义与 yolo 直接相冲。** `DockerToolRouter.degrade()` 在容器启动失败时
   **静默回退本机执行**（仅落一条「执行环境：回退本机」事件）。如果固定 yolo 的前提是"有容器兜底"，
   那静默降级 = 无沙箱且无拦断的完全裸奔。本方案要求：沙箱模式下降级时，**必须同时恢复 §4.6 的 L1 拦断**
   （或直接阻断任务并提示），不得"静默降级 + 静默放行"叠加。
4. **macOS bind mount 性能，以及退路受引擎粒度限制。** worktree 挂进容器后，Agent 的 grep / read 密集操作
   走 VirtioFS，可能慢一个数量级。已定：慢到 3 倍以上则「文件读写留本机」——但这条退路**只有 Pi 引擎具备**：

   | 引擎        | 文件 IO 发生在                                      | 宿主可控制的粒度                          | 能否「命令进容器 / 读写留本机」                                              |
   | ----------- | --------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
   | Pi / OpenAI | 主进程，工具经 `createReadTool` 等注入 `operations` | **工具级**（`sandbox.ts` 已在用）         | 能，现成                                                                     |
   | Qoder       | qodercli **子进程内部**                             | **进程级**（只有 `spawnQoderCLIProcess`） | 不能，除非 `disallowedTools` 掉内置 Read/Edit/Bash 再用 MCP 自建一套文件工具 |

   所以 Qoder 任务上容器化是个整体开关：要么 CLI 进程全进容器，要么全不进（回到 §4.6 的 L1 拦断）。
   性能不可接受时的可行顺序：先试挂载调优（VirtioFS / `:cached` / gRPC-FUSE），
   再考「镜像内置仓库副本 + 跑完同步回来」，最后才是自建文件工具（代价最大，本轮不做）。

**已定：容器网络取 `default`**（本轮已确认）——容器内可以访问外网与局域网，`npm install` /
`pip install` / `curl` 均可用，所以 L3「联网与依赖安装放行」才成立。取 `none` 会让装依赖类任务全部不可用，不采纳。

另一条硬约束：**交付命令必须留在 host 侧执行，不进容器**（`git push` / `glab mr create` 带宿主机凭据，
进容器要么没密钥、要么得把密钥 mount 进去）——现有 `GitService` / `DeliveryService` 跑在主进程，天然满足，
改造时**不得往容器里推**。

### 4.6 保留的权限层级（作为无沙箱时的兜底）

沙箱到位前，下面的 L1 仍必需；沙箱到位后，L1 降级为"容器不可用时的兜底拦断"，不删。
两条引擎路径共用同一份判定：

```
L1 硬阻断（不可配置、不可被任何档位绕过）
   - 越出本任务 worktree 集合的文件写 / 移动 / 删除
   - rm -rf / rmdir -r / sudo / chmod 777 / git reset --hard / git clean -f / git push --force
   - 触碰 ~/.ssh ~/.aws ~/.gnupg *.env
L2 交付动作（由 §3.1 的「Review 通过后」配置决定，不在执行期弹框）
   - git commit / git push / mr create：自动档直接做，手动档留到 awaiting_commit 由人点
L3 其余全部自动放行
   - 含 worktree 内的 mv / rm / 覆盖写 / 联网 / 依赖安装
```

实现要点：

- 新增共享模块导出 `evaluateExecutionPermission(toolName, input, roots)`，
  Qoder 的 `canUseTool` 与 Pi 的 `tool_call` 都改为调它；`roots` 由
  `store.listTaskRepositories()` 的 `worktreePath ?? localPath` 推出，与 Pi 侧现有 `roots` 算法一致。
- `isDangerousTool` 的删除/移动规则**并入 L1 的"越界"判据**：worktree 内放行、越界阻断，
  这样既解决 §4.3 的 `mv` 弹窗，又不至于把不可逆操作全开。
- `blockedCommands` 从 `pi-package/src/permission.ts` 提到共享层，两侧同源，不再各写一份正则。
- **对话路径的三档 HITL 保持不动**（`Composer` 上的切换器、`chat-init.ts` 的逻辑都不改）。
- `Task.hitlMode` 停止写入，`getHitlModeForContext('task', ...)` 保留但恒返回 `'yolo'`，
  使既有调用点无需改动；任务详情里那个三态切换器换成执行环境展示（沙箱 / 本机）。

---

## 5. 数据与兼容

### 5.1 Schema

- 新增：`ALTER TABLE tasks ADD COLUMN mr_auto_submit TEXT`（与现有 `db.ts` 迁移数组同批，幂等 try/catch）。
- 停止读写但**保留列**：`start_mode`、`open_code_review_enabled`、`create_test_cases_enabled`、
  `auto_create_merge_requests`、`hitl_mode`。SQLite 无廉价 DROP COLUMN 路径（删列要重建整表），
  而留下它们对读写没有任何影响：`db.ts` 的 `ALTER TABLE` 数组与 `parseTask` / INSERT / UPDATE 语句分离后，
  列只存在于一份历史 DB 里。
- `settings` 表里 `openCodeReviewEnabled` / `createTestCasesEnabled` / `deliveryConfirm` / `reviewAutoFix*`
  等旧键**不清理**（无害），除 `reviewBlockingLevel` / `reviewAutoFix` / `reviewAutoFixMaxRounds` 继续读外，
  其余一律不再被读取。
- `Task` 上的 `startMode` / `openCodeReviewEnabled` / `createTestCasesEnabled` / `autoCreateMergeRequests` /
  `hitlMode` 以及 `TaskStartMode`、core 的 `HitlMode` 类型**直接删**（PR 6）。
  原计划「标 `@deprecated` 保留以免 `api.ts` 与 `TaskCard` 同时炸」的前提不成立：
  前者靠收窄 `updateTask` patch 类型解决，后者本来就从不读这些字段。

### 5.2 一次性迁移（`db.ts` 构造末尾）

只处理 **in-flight 任务**（`state NOT IN ('completed','cancelled','draft')`），
且**只搬任务上显式选过的布尔**（已实施，PR 6）：

```sql
UPDATE tasks SET mr_auto_submit = CASE
    WHEN auto_create_merge_requests = '1' THEN 'auto'
    ELSE 'manual' END
 WHERE mr_auto_submit IS NULL AND auto_create_merge_requests IN ('1','0')
   AND state NOT IN ('completed','cancelled','draft');
```

> ⛔ 原计划的 SQL 还带两个从 `settings.autoCreateMergeRequests` 推导的分支，实施时删了。
> 原因：PR 5b 把「未设置」升成了一个用户可以主动选中的第三态（「跟随系统默认」/「恢复跟随」），
> 把系统值固化进列会让它不再是跟随。没选过任务级布尔的历史任务本来就走系统默认，
> `resolveMrMode()` 现在仍然这么算，回填对它是多余且有害的。

> 并且用 `settings` 里的 `legacyMrAutoSubmitBackfilled='1'` 保证**只跑一次**：
> 旧列已停写、会永久留在行里，没有标记时每次打开都会把刚点的「恢复跟随」重新固化掉。

> 不能写成 `COALESCE(auto_create_merge_requests, (SELECT ...))`：任务列存的是 `'1'/'0'`，
> `settings.value` 存的是 `'true'/'false'`，两套字面量直接 COALESCE 会把 `'1'` 原样存进
> `mr_auto_submit`，而 `parseMrAutoSubmit` 只认 `'auto'/'manual'`，结果就是静默回退默认档。

> ⚠️ 行为变更，已显式接受：历史上设过「关闭 CodeReview」或「关闭生成测试用例」的**未完成**任务，
> 改造后会开始跑这两个阶段（Review 阻断级别仍按系统设置）。已完成 / 已取消任务不改写，原始字段只读保留。
> 这一条**本轮已确认可接受**，因此不留人工豁免入口
> （`reviewStatus: 'waived'` 仍只由现有的 `completeAtUserRequest()` / 手动完成产生，不新增 UI）。

### 5.3 状态机剪枝

`packages/core/src/workflow.ts` › `transitions`：

- `awaiting_review` 去掉 `awaiting_commit`（唯一用途是 skip-Review 分支）。

  > ⚠️ 这条边**必须与 `task-runner.ts` › `advanceAfterValidation()` 的 skip 分支同一批删除**：
  > 该分支正是 `awaiting_review -> awaiting_commit` 的唯一生产者。先剪边、后删分支会让「关过 Review」的
  > 存量任务在校验通过时直接抛 `Invalid task transition`。因此 §8 里这条改动落在 PR 4，不在 PR 3。

- **本轮唯一的结构性改动就是上面这一条边。** 原计划的 `preparing` / `planning` 先后重排已取消（§2.1 第一条），
  所以下面三行边保持现状：`confirmed -> preparing -> planning`，
  `awaiting_plan_approval -> preparing`（批准后去跑准备命令），`runSetup` 仍是计划确认后的第一步。
- 其余边不动，`TASK_STATES` 成员不增不减，历史行仍可解析。
- `reviewStatus: 'waived'` 保留，但只由 `completeAtUserRequest()` / `TaskCompleter.manualComplete()`
  产生。`TaskCard` 的「Review 已跳过」徽章语义随之收窄。

---

## 6. 文件级改动清单

### 6.1 `packages/core`

| 文件                              | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                        | `+ TaskMrMode = 'auto' \| 'manual'` 与 `+ resolveMrMode(task, resolver)`；`Task` 加 `mrAutoSubmit?`；**删** `resolveTaskSetting`。已实施（PR 1/3/6）：`startMode` / `openCodeReviewEnabled` / `createTestCasesEnabled` / `autoCreateMergeRequests` / `hitlMode` 五个字段连同 `TaskStartMode` 与 core 的 `HitlMode` 已直接删除（不是标 `@deprecated`），`resolveMrMode` 回落链从 4 步收到 3 步（`task.mrAutoSubmit` → 系统设置 → `'manual'`） |
| `workflow.ts`                     | 剪 `awaiting_review -> awaiting_commit`（已实施，与 PR 4 的 skip 分支同批）；§5.3 的 `preparing` / `planning` 重排已取消，其余边不动                                                                                                                                                                                                                                                                                                         |
| `permissions.ts`（新）            | `+ evaluateExecutionPermission(toolName, input, roots)`；L1 常量表（越界写 / 破坏性命令 / 敏感路径）从 `pi-package/src/permission.ts` 与 `dangerous-tools.ts` 合并上移                                                                                                                                                                                                                                                                       |
| `db.ts`                           | 加 `mr_auto_submit` 列 + 迁移 + 读写映射；**补 `repo_agent_ids TEXT` 列及其 INSERT/UPDATE/JSON 映射（§1.4 前置修复）**；`start_mode` 等旧列停止由业务侧写入。已实施（PR 6）：旧列的 INSERT / UPDATE / `parseTask` 映射全部摘掉（列本身保留），回填改成带标记的只跑一次（§5.2）                                                                                                                                                               |
| `sandbox.ts`（新）                | 从 `pi-package/src/sandbox.ts` 上移 `DockerToolRouter` 的容器生命周期部分（`check` / `container` / `degrade` / `stop`），改为不依赖 Pi 工具注册的纯类，供 desktop 与 pi-package 共用；`degrade()` 增加返回值表示「已降级，调用方必须启用 L1」                                                                                                                                                                                                |
| `workflow.test.ts` / `db.test.ts` | 断言新边被拒、`mrAutoSubmit` 与 `repoAgentIds` 往返一致。已实施（PR 6）：回填用例改成用裸 SQL 写旧列（模拟历史库），并断言只跑一次 + 不把系统默认固化给未选过的任务；`startMode` 相关的断言与 fixture 已清                                                                                                                                                                                                                                   |

### 6.2 `packages/integrations`

| 文件                                             | 改动                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task-workflow.ts`                               | 已实施：`begin(taskId, options?, signal?)` 去 `mode` 恒 `-> planning`；构造器尾部 5 个位置参数改 `options?: { shell?; git?; testCaseGenerator? }`；**删** `isReviewEnabledFor` / `shouldGenerateTestCases` / `shouldAutoCreateMergeRequestsFor` 与底部三个 getter，代之以单个 `mrMode(task)`（内部调 core 的 `resolveMrMode`，让两条宿主共用同一份 resolver）；`runSetup` 转 private，位置不变 |
| `review-orchestrator.ts`                         | 无签名变更，但 `reviewBlockingLevel` 首次真正被调用方传入                                                                                                                                                                                                                                                                                                                                      |
| `delivery.ts`                                    | 确认闸门改读 `resolveMrMode()`，不再读 `deliveryConfirm`                                                                                                                                                                                                                                                                                                                                       |
| `docker.ts`                                      | `SandboxOptions` 增 `extraMounts: string[]`；`start()` 挂载清单加入 auth payload 临时目录与 CLI session 目录（同路径 bind，§4.5 坑 1/2）                                                                                                                                                                                                                                                       |
| `task-workflow.test.ts` / `integrations.test.ts` | 约 12 处 `new TaskWorkflow(...)` 位置参数改 options；`begin` 的 5 个调用点全部改具名（`integrations.test.ts:346,379,383` + `task-lifecycle.ts:507,567` + `pi-package/src/index.ts:230`）；删 3 个谓词的开关测试                                                                                                                                                                                |

> ⚠️ 构造器改造**必须与删谓词同批**。只删参数、保留 `undefined, undefined, shell` 的位置写法，
> `shell` 会静默错位——传的是 `undefined`，TS 拦不住。

### 6.3 `apps/desktop/electron`

| 文件                                      | 改动                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions` 接入                        | `pi-extension/qoder/qoder-orchestrator.ts` 的 `canUseTool` 改为调 `evaluateExecutionPermission`，删除 `hitlMode` 读取与 `isDangerousTool` 分支；`taskId` → `roots` 由 `listTaskRepositories` 推                                                                                                                                                                                                                   |
| `task/task-runner.ts`                     | 已实施：`advanceAfterValidation()` 去掉 if/else 恒跑 Review，末尾按 `taskWorkflow.mrMode()` 决定是否提交；`collectReviewComments()` 改复用 `blockingSeveritiesFor()`；**新增 `reviewBlockingLevel()` 作为阻断级别的唯一读取点**并导出。⚠️ 原文写的「删 `reviewAutoFixEnabled()` / `reviewAutoFixMaxRounds()` 改读系统设置新键」**不采纳**：§3.1 / §5.1 已定这两个键继续读，删了只会把 settings 键名换掉，没有收益 |
| `task/task-lifecycle.ts`                  | 已实施：`startTask()` 内部不再分支（`options.mode` 保留为 `@deprecated` 透传，PR 5 连 UI 一起删）；`resumeTask` 的 `failedDuringPlanning` 只剩 `failureStage === 'planning'`；`finishImplementation()` 恒进测试阶段，覆盖检测命中时补落「已有覆盖，仅执行不新增」事件（§2.3）                                                                                                                                     |
| `task/hitl-mode.ts`                       | `getHitlModeForContext('task', ...)` 恒返回 `'yolo'`；顶部注释按 §4.2 改写（`ask` 仅对对话路径成立）                                                                                                                                                                                                                                                                                                              |
| `ipc/index.ts` + `preload.cts`            | 已实施（PR 5）：`tasks:start` payload 去 `mode`（与 `TaskEditorDialog` 的 `StartModeCards` 同批）；`hitl:set-mode` 对 `contextType === 'task'` **抛错**而非静默忽略（静默会让“改了没存上”变成默故障）；`preload.cts` 无需改——`startTask(taskId, options?: unknown)` 本来就不携带 `mode`；新增 `tasks:intake-message` → `sendTaskIntake`（§2.4，待 PR 7）                                                          |
| `services/review-delivery.ts`             | 已实施：`buildReviewOrchestrator()` 增传 `reviewBlockingLevel()`（此前从不传，设置页那个「阻断级别」是死配置）；`deliveryApprover` 不再弹框——自动档无参与提、手动档本身就是人按的按钮，只保留 `addApproval` / `permission` 事件作审计痕；`deliveryConfirm` 从此无读取点                                                                                                                                           |
| `pi-extension/qoder/qoder-session.ts`     | `QoderSessionOptions` 增 `spawnQoderCLIProcess`，透传给 SDK `query()`；沙箱开启时由上层注入基于 `docker exec -i` 的 spawner                                                                                                                                                                                                                                                                                       |
| `pi-extension/qoder/qoder-task-agent.ts`  | 组装 spawner；沙箱模式下 `degrade` 回报后把 `canUseTool` 从"仅越界判定"切回完整 L1                                                                                                                                                                                                                                                                                                                                |
| `services/sandbox-desktop.ts`（新）       | 桌面端沙箱生命周期（当前只在 pi-package 里）：按 taskId 起停容器、写 `sandboxStatus`，供任务与 review 阶段复用                                                                                                                                                                                                                                                                                                    |
| `task/task-lifecycle.ts` › 澄清入口       | **新增** `sendTaskIntake(taskId, message)`：仅接受 `state === 'draft'`，走 `${taskId}:intake` 会话，**不改任务状态**；现有 `sendTaskMessage` 的白名单与第 827 行的状态推进保持不动                                                                                                                                                                                                                                |
| `agents/task-intake/`（新）               | 澄清 backend：复用 `QoderOrchestrator` 的会话容器，注入只读工具集 + `updateTaskDraft`；`begin()` 进 `planning` 时关闭该会话，实现阶段拿干净上下文                                                                                                                                                                                                                                                                 |
| `pi-extension/qoder/qoder-chat-driver.ts` | 私有的 `buildTaskCreationMcp(source)` 抽成共享 `buildToolSourceMcp(name, source)`——否则 `updateTaskDraft` 只能注入对话侧，任务侧拿不到工具                                                                                                                                                                                                                                                                        |

### 6.4 `apps/desktop/src`

| 文件                                 | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/DetailPanel.tsx`         | `canChat`（第 190 行）增 `draft`；`draft` 态下输入框占位文案改为「让 Agent 帮你补全任务定义」，发送走 `api.sendTaskIntake` 而非 `sendTaskMessage`；**加**缺项提示条（不自动发言，§2.4 第 5 条）                                                                                                                                                                                                                                                                              |
| `components/TaskEditorDialog.tsx`    | 已实施（PR 5）：**删** `StartModeCards` / `AutomationOverrideField` / `Overrides` 及三个旧开关的系统设置读取；**加** `MrModeCards`（两卡，复用原双卡视觉语言）；`TaskAgentOverrideField` 与逐仓库 Agent 控件一起进「高级设置」；`buildTaskInput()` 不再写 3 个布尔。⚠️ 保留**一条**设置读取（`autoCreateMergeRequests`）用于卡片上的「系统默认」徽章：§3.1 定的是「任务级 + 系统默认」，不读它「跟随系统」就是一句无法验证的话。**待做**：“澄清建议区”（§2.4 第 3 条，PR 7） |
| `components/SettingsDialog.tsx`      | 「任务自动化」Section 从 5 Switch + 1 number 降到：Review 阻断级别 Select + 自动修订 Switch + 轮数 number + MR 默认档 Select；删 `deliveryConfirm`（并入 MR 档）                                                                                                                                                                                                                                                                                                             |
| `components/DetailHeader.tsx`        | 已实施（PR 5）：「直接执行 / 计划模式」两个徽章 → 一个 MR 档徽章。只展示**任务级**三态（`Review 后自动提 MR` / `Review 后手动提 MR` / `MR 档跟随系统`），不在 header 里再读-system 设置算“实际值”：那需要一个挂载即发的 IPC，而且加载期间会先闪一个错的值                                                                                                                                                                                                                    |
| `components/DetailActions.tsx`       | 不变（人工兜底动作正是固定链路的保险丝 ）                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pages/CodingPage/hooks/useTasks.ts` | 删 `startMode === 'plan'` 的完成态判断                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `components/HitlModeSwitcher.tsx`    | `contextType === 'task'` 时不渲染三态，改渲染 L1 只读说明                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `api.ts`                             | 已实施（PR 5）：`StartTaskOptions` 去 `mode`；demo 任务同步；`updateTask` patch 已收窄为 `UpdateTaskInput`（PR 6，见 §10.5）；**+** `sendTaskIntake(taskId, message)` → `tasks:intake-message`（§2.4，待 PR 7）。⚠️ 原文写的「`StartTaskOptions` 加 `mrAutoSubmit?`」**不采纳**：start 模式提交前恒先 `api.updateTask(taskId, buildTaskInput())`，同一个字段两条写入路径只会有一个是真的                                                                                     |

### 6.5 `packages/pi-package`

| 文件                | 改动                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`      | 已实施：`task-start` 删 `先生成计划 / 直接开始` 选择，直接 `begin(task.id)`；`tool_call` 换 core 的 `evaluateExecutionPermission`；`buildReviewOrchestrator()` 同步传 `reviewBlockingLevel`；计划审批 `ctx.ui.select` 保留（人工确认是必经的） |
| `src/permission.ts` | `blockedCommands` / `deliveryCommands` / `networkCommands` 上移到 core 后本文件只做 re-export；`roots` 计算逻辑与 Qoder 侧统一                                                                                                                 |
| `src/sandbox.ts`    | 容器生命周期部分改为 re-export core 的实现，只保留 Pi 工具路由（`create*Tool` 的 operations 注入）                                                                                                                                             |

---

## 7. 验证口径

| 命令                   | 覆盖范围                                                                         |
| ---------------------- | -------------------------------------------------------------------------------- |
| `npm run typecheck`    | core / integrations / pi-package / desktop 双 tsconfig                           |
| `npm run test`         | 先 `rebuild:node`（避开 better-sqlite3 ABI 不匹配），再各 workspace `vitest run` |
| `npm run lint:all`     | ESLint 的 `no-unused-vars` 用来捕被删谓词与被删构造参数的残留引用                |
| `npm run format:check` | Prettier                                                                         |

需新增的关键用例：

1. `core/permissions.test.ts`：worktree 内 `mv` → allow；`mv` 出 worktree → block；`rm -rf` → block；
   `npm install` → allow（不再是 confirm）。
2. `workflow.test.ts`：`transitionTask('awaiting_review','awaiting_commit')` 必须抛错。
3. `db.test.ts`：`mrAutoSubmit` 与 `repoAgentIds` 的 `createTask` / `updateTask` / `getTask` 往返一致。
4. `integrations.test.ts`：`begin(taskId)` 恒进 `planning`（不再接受 `mode`）；批准后 `approvePlan()` 才跑 setup，且任务级空命令覆盖能压掉仓库默认命令。
5. `resolveMrMode()` 的回落链：落在 **`core/types.test.ts`**（判定本身在 core，integrations 只注入 resolver，在彼处测等于测 mock）。
   ⚠️ 原文写的是「task → 旧布尔 → setting → 默认」四级；PR 6 删掉旧布尔读取后实际是三级（§10.5），
   对应的「旧布尔回退」用例已按定义删除，不是漏测。
6. `dangerous-tools.test.ts`：确认任务路径不再引用它（对话路径仍引用）。
7. `integrations/docker.test.ts`：`start()` 的挂载清单包含 auth payload 目录与 CLI session 目录；
   容器启动失败时 `container()` 返回降级信号而不是抛错。
8. `qoder-session.test.ts`：传入 `spawnQoderCLIProcess` 时，SDK 收到的 command/args 被原样交给
   自定义 spawner，且 `resume` / `cwd` 仍正常透传（沙箱模式的回归基线）。
9. `task-intake`：`sendTaskIntake()` 在 `state === 'draft'` 下成功，调用后状态**仍是 `draft`**；
   对 `implementing` 任务调用它必须抛错（防止两条入口互相串）。
   已落：`electron/task/task-lifecycle.test.ts`（三条——draft 成功且先落用户那句再开会话、
   `implementing` 抛错且一条事件都不落、缺 Qoder Token 抛错且一条事件都不落）
   加 `task-readiness.test.ts` 的 `assertDraftIntake`（逐状态扫，防以后新增状态默认放行）。
10. `updateTaskDraft` 工具：只接受 `{ title, description, keywords, acceptanceCriteria, repositoryIds }`
    白名单，改动落 `addTaskEvent`；未被应用的建议不改动任务字段。
    已落：`electron/agents/task-intake/task-intake.test.ts`（清洗、工具面、「只落事件不碰字段」三组）。
    「未被采纳不改字段」与「只写勾选项」抽成 `adoptDraftFields()` 在同一文件测：
    它是唯一回答「点一下采纳到底写什么」的地方，留在 `resolveDraftSuggestion` 里就等于测不到。

---

## 8. 实施顺序

| PR                                 | 内容                                                                                                                                                                                                                                                    | 行为变化                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **PR 0**                           | §1.4 前置修复：补 `repo_agent_ids` 列与读写                                                                                                                                                                                                             | 逐仓库 Agent 覆盖从无效变有效                                                                            |
| **PR 1**                           | 权限层：core 新增 `permissions.ts`，两条引擎路径接入 `evaluateExecutionPermission`；`hitl-mode.ts` 任务侧恒 yolo + 注释修正；`pi-package/permission.ts` 收敛                                                                                            | **HITL 弹窗数量显著下降**；L1 底线首次覆盖 Qoder 路径。与链路改动解耦，可单独回滚                        |
| **PR 2**（**暂缓**，待 §9.2 决策） | 执行环境容器化：`DockerToolRouter` 上移到 core、桌面端接入、`QoderSession` 注 `spawnQoderCLIProcess`、补 payload/session 挂载、降级时恢复 L1、设置页暴露镜像（网络取 `default` 常量，不布 UI）                                                          | Qoder 任务改在容器内执行；**须先跑 §7.7/7.8 与一次真实任务的手动验证**                                   |
| **PR 3**                           | core + integrations 骨架：`mrAutoSubmit` / DB 列与回填迁移（顺带补 §1.4 附注的 `review_fix_count` 列）/ 构造器与 `begin` options 化；**剪边挪到 PR 4**（见 §5.3）                                                                                       | 零变化（旧开关仍生效）；构造器与 `begin` 改为具名入参，消除 `undefined, undefined, shell` 的位置错位风险 |
| **PR 4**                           | 接线必经链路：`task-runner` / `task-lifecycle` 删分支，**剪 `awaiting_review -> awaiting_commit` 与它的唯一消费方 `advanceAfterValidation` skip 分支同批**，`review-delivery` 接通 `reviewBlockingLevel`，pi-package 去二选一，三个旧谓词改为恒「必经」 | 行为变更集中点，也是本轮唯一的状态机结构性改动                                                           |
| **PR 5**                           | UI 收缩：TaskEditorDialog + SettingsDialog + DetailHeader + HitlModeSwitcher + useTasks                                                                                                                                                                 | 控件从 9 组降到 1 组                                                                                     |
| **PR 6**                           | 清理：删 `resolveTaskSetting`、旧字段读取、`TaskStartMode` 与旧列写入（已完成：回填还改成只跑一次，否则会把 PR 5 的「跟随系统」固化掉，§10.5）                                                                                                          | 无                                                                                                       |
| **PR 7**                           | §2.4 创建任务时的对话式完善：`sendTaskIntake` + `updateTaskDraft` + `buildToolSourceMcp` 抽取 + `canChat` 放开 `draft` + 表单建议区                                                                                                                     | 链路零变化；`draft` 阶段新增一条只写任务字段的对话通道                                                   |

依赖关系：PR 1 是当前唯一的执行期安全边界（PR 2 暂缓后它不能再往下拆）；
PR 2 恢复启动时可以先只做到"沙箱可用 + 降级可见"，不必一次解决性能问题。链路相关的 PR 3–PR 5 是主体，按序不可颠倒。
§2.4 的澄清对话（PR 7）与前 6 个 PR 无耦合：它不剪边、不删配置、不动权限，可以最后做，
也可以提前单独做——唯一要求是 `updateTaskDraft` 依赖 PR 0 的 `repo_agent_ids` 之外的仓库字段读写，
而 `repositoryIds` 回写需要 `task_repositories` 已有写入路径（现成）。

---

## 9. 结论清单与剩余待确认

### 9.1 已定，写码前不再讨论

| 事项              | 结论                                                        | 落点      |
| ----------------- | ----------------------------------------------------------- | --------- |
| 计划审批          | 固定人工闸门，取消 `autoApprovePlan` 与严格度 enum          | §2.1 §3.1 |
| 阶段必经          | 只有结构性前置条件能 no-op，且必须落一条事件                | §2.2      |
| 测试写 / 跑分离   | 取文案对齐，不动状态机                                      | §2.3      |
| 逐仓库 Agent 覆盖 | 补 `repo_agent_ids` 列救活                                  | PR 0      |
| 执行期安全边界    | 整体进 Docker；L1 降为容器不可用时的兜底                    | §4.5 §4.6 |
| 容器网络          | 取 `default`，装依赖与联网放行                              | §4.5      |
| 交付命令位置      | `git commit` / `push` / `mr create` 留 host，不进容器       | §4.5      |
| 容器内 `resume`   | 方案 A：把 CLI session 目录同路径挂进容器，重试续接行为不变 | §4.5 坑 2 |
| 准备命令时机      | **维持现状**（批准后才跑），不改状态机顺序                  | §2.1 §5.3 |
| 存量未完成任务    | **接受**它们开始跑测试与 Review，不留人工豁免入口           | §5.2      |
| `draft` 澄清对话  | 缺项才提示 + 建议区逐项「应用」，Agent 不直接改表单         | §2.4      |
| 对话侧 plan 模式  | 不是 task，本轮不碰；§6.4 相关改动已删                      | §2.4      |

### 9.2 仅记录，暂不决策：容器性能退路

**本轮不实现容器化（PR 2 暂缓），所以这一条不需要现在选。**先记在案：
性能退路「慢 3 倍就把文件读写留本机」**只对 Pi / OpenAI 引擎成立**：
Pi 的工具是宿主注入 `operations` 的，可以一个工具一个工具地决定走容器还是走本机；
而 Qoder 的文件读写发生在 qodercli **子进程内部**，宿主只能决定整个进程在哪跑
（§4.5 坑 4 的对照表）。所以 Qoder 任务实测慢到不可接受时，只能三选一：

- **(b1) 先做挂载调优**（VirtioFS / `:cached` / gRPC-FUSE），能救回多少算多少——本文档默认走这条，
  因为它不动架构；代价是可能救不回来，届时要回到这个决策点。
- **(b2) 接受慢**，容器不换。代价是实现阶段整体变长，但隔离和一致性最好。
- **(b3) 只有 Pi 任务进容器，Qoder 任务退回本机 + 靠 L1 拦断**。代价是两条引擎的安全模型不一致，
  且「执行环境」展示要按 runtime 分支，§3.2 那行只读说明得写两种。

自建一套 MCP 文件工具（把 Qoder 拉到和 Pi 一样的工具级粒度）没有列进选项：那等于重写工具层，
本轮不该背。**等 PR 2 真要做时再回到 (b1) / (b2) / (b3) 选。**

### 9.3 一条顺带的好消息（无需回答）

准备命令重排取消之后，本轮状态机的结构性改动**只剩剪掉 `awaiting_review -> awaiting_commit` 一条边**，
PR 3 的风险面比上一版小得多；PR 1（权限层）与 PR 7（`draft` 澄清对话）都不碰状态机。

---

另有一条附注：L1 目前把 `git push --force` / `git reset --hard` 也算无条件阻断（沿用 Pi 侧
`blockedCommands`）。PR 2 完成后这些命令若在容器内执行，破坏面已被限制在挂载的 worktree 里，
可以考虑放开 —— 但需要你确认，因为 `git reset --hard` 在容器内同样能毁掉你未提交的改动。

---

## 10. 实施记录（边做边记，与本文档的差异都在这）

| PR                                   | 状态             | 验证                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 0 `repo_agent_ids` 建表/迁移/读写 | 已完成           | `db.test.ts` 往返一致                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PR 1 权限层                          | 已完成           | `permissions.test.ts` 9 例；两条引擎路径同源                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PR 2 容器化                          | **暂缓**（§9.2） | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PR 3 core + integrations 骨架        | 已完成           | `typecheck` 全绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PR 4 必经链路接线                    | 已完成           | `typecheck` 全绿；core 64 / integrations 81 / pi-package 37 测试通过；desktop 测试与 lint 均为改动前基线（11 files / 24 tests 红，11 处 error，无一在我改的文件里）                                                                                                                                                                                                                                                                                                               |
| PR 5 UI 收缩                         | 已完成           | `typecheck` 全绿；core 64 / integrations 81 / pi-package 37 测试通过；desktop 测试与 lint 均为基线（11 files / 24 tests 红，11 error / 74 warning），改动文件全部 prettier CLEAN                                                                                                                                                                                                                                                                                                  |
| PR 6 旧字段清理                      | 已完成           | `typecheck` 全绿；core 63 / integrations 81 / pi-package 37 测试通过（core 由 64 变 63：`resolveMrMode` 的旧布尔回退用例按定义删除）；desktop 测试与 lint 均为基线（11 files / 24 tests 红，11 error / 74 warning），改动文件全部 prettier CLEAN                                                                                                                                                                                                                                  |
| PR 7 `draft` 澄清对话                | 已完成           | `typecheck` 全绿；core 63 / integrations 81 / pi-package 37 通过；本轮新增 31 例（`task-intake.test.ts` 12、`draftIntake.test.ts` 10、`task-lifecycle.test.ts` 3、`DetailPanel.test.tsx` 4、`task-readiness.test.ts` 2）；desktop 全量仍为基线（11 files / 24 tests 红，其中 3 个 electron 套件是 HEAD 就有的 import 路径腐化）；`lint:all` 10 error / 74 warning 全在未改动的文件里；改动的 50 个 ts/tsx 全部 prettier 绿（唯一残留的 `pi-package/src/index.test.ts` HEAD 就红） |

### 10.1 三处与本文档不符的事实

1. **`reviewFixCount` 和 `repoAgentIds` 是同一个 bug。** 它也没有 DB 列，三处写入全部静默丢失——
   也就是说 Review 自动修订的轮数上限一直按 0 计算，每次都跑到最大轮数。已随 PR 3 补列并回填。
2. **`reviewBlockingLevel` 比 §1.3 记的更死。** 不只是「设置页写了但没人读」：
   desktop 与 pi-package 两侧的 `buildReviewOrchestrator()` 都从不传这个字段，
   所以 `ReviewOrchestrator` 恒落在默认 `high`。PR 4 把两侧都接上，并把读取点收敛到 `task-runner.reviewBlockingLevel()` 一处，
   避免出现「按 high 判定阻断、却只拿 critical 去自动修订」的空转。
3. **`deliveryConfirm` 在固定链路下必然出局。** 自动档由 `advanceAfterValidation()` 无参与提，
   手动档则是人在 `awaiting_commit` 自己按的按钮——两种情况都已经表达了意图，
   再逐 commit / push / MR 弹三次框正是「交付期弹框烦人」的来源。所以 `deliveryApprover` 退化为纯审计记录。

### 10.2 一处必须同批的坑

剪 `awaiting_review -> awaiting_commit` 与删 `advanceAfterValidation()` 的 skip 分支**不能分批**：
该分支正是这条边的唯一生产者，先剪边会让历史上「关过 Review」的存量任务在校验通过时直接抛 `Invalid task transition`。
这条已经写在 §5.3，实施时按 §8 落在 PR 4。

### 10.3 §2.2 的 no-op 留痕落在哪（原文只写了规则，没写落点）

「必经 = 必然进入该 state，不等于必然执行动作，但 no-op 必须落一条事件」这条已定结论，
§6 的清单里没有对应的代码位置。PR 4 一并接上，判定全在 `TaskWorkflow`（两条宿主共用）：

| 阶段       | no-op 判据                              | 事件标题                               | 位置                                               |
| ---------- | --------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| 环境准备   | 所有仓库 `setupCommand` 为空            | 未配置准备命令,环境准备按 no-op 通过   | `runSetup`                                         |
| 测试（跑） | 所有仓库 `testCommand` 为空             | 未配置测试命令,本阶段只跑 Lint / Build | `runValidation`                                    |
| 校验       | lint / test / build 三命令全空          | 未配置校验命令,跳过校验                | `runValidation`                                    |
| Review     | 所有仓库 `deliveryStatus === unchanged` | 无代码改动,Review 跳过                 | `runReview`（仍先 `-> reviewing`，不改状态机形状） |
| 测试（写） | `runTestCoverageCheck()` 命中           | 已有测试覆盖，本次不新增用例           | desktop `finishImplementation()`（§2.3）           |

`runCommands()` 因此改为返回「实际执行的命令条数」——判据要精确到「这个阶段一条命令都没跑」，
不能只看某个仓库没配。

### 10.4 PR 5 的三处超出清单的收尾，与一处已知不一致

1. **`reviewBlockingLevel` 补了一个设置入口。** §3.1 说「本轮接通」，PR 4 接通的是**读取侧**；
   但 `apps/desktop/src` 里本来就没有任何控件写这个键（`Settings` 类型、`ordinaryKeys` 都不含它），
   所以只接读取侧等于「默认 high 生效、用户仍然改不动」。PR 5 在「任务自动化」区新增阻断级别 Select。
2. **pi-package 的 `deliveryConfirm` 必须同批删。** §6.3 记的是 desktop 侧 `deliveryApprover` 不再读它，
   但 Pi 侧 `buildDeliveryService()` 的 approver 一直在读。PR 5 删掉了设置页那个开关，
   若留着这条读取，就变成一个「UI 里没有、老数据里却可能为 true」的隐藏弹框开关。
   现在两侧 approver 同构：只写审批表作审计痕，不弹确认——`/deliver` 本身就是人显式敲的命令。
3. **逐仓库 Agent 下拉从仓库面板标题行移到高级设置。** 顺带把折叠态标题行还原成命令摘要
   （该组件注释一直写着「标题行直接显示命令摘要」，实际显示的是 Agent 下拉）。
4. **已知不一致（本轮不补）**：Pi 侧 `/review` 通过后恒停在 `awaiting_commit`，
   即使任务是 `mrAutoSubmit='auto'` 也**不会**自动提 MR——desktop 的自动档靠 `advanceAfterValidation()` 驱动，
   Pi 没有这个自主推进环节，每个阶段都是人敲一条命令。§6.5 没要求补，补了反而让「Pi 的每条命令都是人工动作」这个约定破掉，
   所以只记不修。若后续要让 Pi 也支持自动档，正确位置是 `/review` 通过后按 `taskWorkflow.mrMode()` 决定是否直接调
   `DeliveryService.submitMergeRequests()`，而不是在 approver 里放行。

### 10.5 PR 6：删字段比原计划多做了一步，原因是回填不能继续开着

1. **回落链从 4 步收到 3 步。** `resolveMrMode()` 不再读旧任务级布尔，`Task` 上的
   `startMode` / `openCodeReviewEnabled` / `createTestCasesEnabled` / `autoCreateMergeRequests` / `hitlMode`
   连同 `TaskStartMode`、core 的 `HitlMode`（只剩 `Task.hitlMode` 一个使用者，desktop 两侧各自定了一份）、
   以及零消费者的 `resolveTaskSetting` 一起删了。§5.1 原写的「标 `@deprecated` 保留」不采纳：
   保留一个谁都不读、但新代码还能误写的字段，比删掉它更贵。
2. **旧 DB 列保留不删。** 删列在 SQLite 里要重建整表，而 `INSERT` / `UPDATE` / `parseTask` 摘掉后，
   留着对读写零影响（`db.ts` 里已加注释说明）。
3. **回填必须改成只跑一次，否则 §5.2 的 SQL 会反过来坑 PR 5。** 原 SQL 无标记、
   且带一个「从系统设置推导」的分支，两者叠加会让 `mr_auto_submit IS NULL`（= 用户选的「跟随系统默认」）
   在每次打开时被重新固化：新任务被固化成当时的系统值，旧任务上刚点的「恢复跟随」也会被旧列覆盖回去。
   现在用 `settings.legacyMrAutoSubmitBackfilled` 门住，并且只搬任务上显式选过的布尔。
4. **`api.ts` 的 `updateTask` patch 收到 `UpdateTaskInput`。** 它是 `CreateTaskInput` 的字段集 + `qoderModel`
   （详情头部的逐任务模型覆盖走的就是 `updateTask`，只 `Pick<Task, ...>` 收不住），
   效果是旧字段和 `state` 都不再能被写回去。IPC 侧 `tasks:update` 仍是 `Record<string, unknown>`：
   那是运行时边界，收窄类型不会带来运行时校验，收与不收等价。
5. **`db.test.ts` 的回填用例现在用裸 SQL 写旧列。** 字段从 `createTask` 入参上删后，
   旧列已无法通过 store 写入，而回填针对的恰恰是「改造前已有旧列值」的库；
   同时要先清掉标记，否则测试自己的首次打开就会把标记写上（这一点踩过一次）。
6. **删类型时要连注释里指向它的消歧义一起清。** `chat/chat-types.ts` 里那句
   「与 Coding Pipeline 的 `TaskStartMode` 完全隔离」到本轮盘点才发现还留着：代码引用全部干净，
   但注释指向了一个已不存在的类型，比写错更难查。

### 10.6 PR 7 的三个落点决定（§2.4 只写了规则，没写在哪）

1. **建议区在 DetailPanel，不在 TaskEditorDialog。** §2.4 第 3 条写的是「表单上方」，
   但澄清对话发生在 `draft` 的任务详情页（§2.4 表里的现有积木就那三个，全在 DetailPanel），
   此时表单弹框已关。所以 `draft` 的执行页整页换成 `TaskIntakePanel`（问答 + 建议卡），
   composer 上方只留缺项提示条；采纳按字段逐项勾选，不是一个「应用」按钮。
   表单没开着，不存在「把人写的东西抹掉」；下次开编辑弹框时读到的就是已采纳的值。
2. **建议与问答用 events 承载，不新增列也不新增 `Task` 字段。** 工具落一条
   `kind: 'status'` + `payload.type = 'draft-suggestion'` 的事件，采纳/丢弃再落一条
   `draft-suggestion-resolved`，问答落 `draft-message`；UI 取「最后一条未被 resolved 的建议」。
   选 `status` 而不是新增 `AgentEvent['kind']` 成员，是为了不去动所有按 kind 渲染的分支。
   **但读的不是 `TaskDetail.events`**：那份是 `traceService.getTaskEvents()` 从 trace span 合成的，
   而 `draft` 没跑过任何阶段、一条 span 都没有；写侧的 `d().addTaskEvent` 又只广播一条
   `task_changed` 通知、不落库，走它等于话说完就消失。所以两侧各补一处：
   读侧 `TaskDetail.draftEvents = store.listEvents(id)`（`ipc/index.ts` 的 `tasks:get`），
   写侧 `addDraftEvent()` 直连 `store.addEvent` + `emitTaskChanged`。
   字段写入与白名单校验都在主进程（一条 `tasks:resolve-draft-suggestion` IPC，
   renderer 只回传 `eventId` 与勾选的 `keys`），不让它拿着建议体自己 `updateTask`。
3. **`draft` 阶段不开流式通道，busy 就是那条 IPC 挂多久。** 整轮回复聚合成一条
   `draft-message` 事件，而不是原写的「逐段 `addTaskEvent`」：一是不需要打字机效果，
   二是 `PartRenderer` 会把相邻 text part 合并（流式增量需要合并），问答走它会粘成
   同一个人说的话——所以澄清面板是独立组件，不复用 `TaskConversationView`。
   界面在途状态靠 `await api.sendTaskIntake()` 的 promise，不广播 `agent_start` / `agent_end`：
   那两个事件会经 `emitPi()` 喂 trace builder（它按 `activeTaskId` 定位，澄清阶段没有），
   跨任务污染的风险大于省掉一次 await 的收益。同理 `draft` 的 composer 不给 `onStop`——
   `tasks:abort` 只停 `getActiveTaskId()`，按了什么都停不下来。

### 10.7 PR 7b–7d 的契约扩展与一处实测出来的语义修正

1. **`TaskDraftEventPayload` 补了 `role`，不靠 `title` 分支。** 渲染层要区分「你」与
   「澄清助手」，而 `title` 是给人看的中文文案，拿它做渲染分支等于把界面绑在一句文案上。
   同理补 `repositoryNames`：渲染层没有全量仓库表，否则建议卡只能把仓库显示成 `repo-1`。
   它只是名字快照，采纳时主进程仍按 id 重新校验。
2. **`keys: []` 与 `keys === undefined` 不是一回事——这条是测试写出来才发现的。**
   第一版实现写的是 `if (keys?.length)` 才做交集，于是「一个都没勾」会退化成「整条采纳」，
   正好写反。现在是 `undefined` = 整条采纳，给了名单（含空数组）= 只写勾上的，
   空名单落到「至少勾选一项」报错。UI 那颗按钮本来就 `disabled`，线上走不到，
   但 IPC 是运行时边界，不能靠调用方自觉。
3. **采纳事件记的摘要 = 实际写进去的那几项**，不是建议原文：只勾两项时 Timeline 里不该出现第三项。
4. **`DetailPanel.test.tsx` 里的 Composer 是 mock 且输入框受控**，所以草稿态那两条只能验到
   「发送走 `onSendIntake` 而不是 `onSend`」，验不到文本内容——文本的 plumbing 在
   `useTasks.sendIntake`，它靠 `task_changed` 防抖重拉详情来显示回复，没有乐观插入。
