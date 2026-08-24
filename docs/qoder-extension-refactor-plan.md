# Qoder SDK Extension 化改造方案

## 1. 核心认知

### 1.1 我们在做什么

把 Qoder SDK 的完整能力（常驻会话、工具执行、HITL、子任务委派、MCP 注入、Trace 采集、计划模式）封装为一个 **Pi extension**，让 Qoder 的接入以 extension 插件的形式存在，而非硬编码在宿主（main.ts）中。

**不是** `pi-provider-qoder` 那种只做 LLM provider 的薄封装。是完整包裹 Qoder SDK。

### 1.2 架构定位

```
Pi（底层 Agent Runtime）
├── pi-package extension（现有：任务管理、Docker 沙箱、权限评估、Jira/GitLab）
├── qoder-extension（新增：Qoder SDK 完整接入）
└── 宿主（Electron main.ts）
    ├── TaskWorkflow 状态机（provider 无关）
    ├── ChatService → ChatDriverRegistry → QoderChatDriver
    └── IPC 注册 + 转发
```

Chat 和 Task 是我们的**设计模式**，底层依赖 Pi 的 agent runtime。Pi 通过 qoder-extension 补充了 Qoder SDK 的接入能力。

### 1.3 关键前提

- Pi extension 跑在 **同一 Node.js 进程内**（Electron 主进程通过 `resourceLoader` 加载）
- Qoder SDK 的 `query()` 也是进程内 AsyncGenerator
- **不存在跨进程问题**——extension 内可以直接 import SDK 的全部 API
- 本质上是**代码组织重构**，运行时行为不变

### 1.4 工具系统：两套并行，各管各的

| 路径                  | 工具来源                                   | 执行环境        |
| --------------------- | ------------------------------------------ | --------------- |
| Chat（Qoder driver）  | Qoder SDK 内置 + MCP 注入自定义工具        | SDK 内部控制    |
| Task（Qoder driver）  | Qoder SDK 内置 + `allowedTools: ['Agent']` | SDK 内部控制    |
| Chat/Task（Pi agent） | `pi.registerTool()` via sandbox.ts         | Docker 沙箱路由 |

Qoder SDK 有自己完整的工具系统（bash/read/write/edit/grep/find/ls/Agent 等），工具在 SDK 内部的 agent loop 里执行。Pi 的 `tool_call` 事件只对 pi 自己注册的工具生效，**对 Qoder SDK 内部的工具调用不可见**。

Extension 的角色是**桥接**——把 SDK 的内部事件（`onMessage`）转译成宿主能理解的事件/消息，而不是接管 SDK 的工具执行。

---

## 2. 各能力域的解决方案

### 2.1 QoderSession 进程内语义

**结论：无问题，原封不动搬进 extension。**

`QoderSession` 封装 SDK `query()` 的完整会话生命周期（异步输入流 `inputStream()`、回合管理 `turn()`、消费循环 `consume()`、中断 `interrupt()`、恢复 `resume`、关闭 `close()`）。这些全是 SDK 的进程内 API，extension 在同进程中直接可用。

`QoderSession` / `QoderSessionRegistry` 的代码**原封不动**搬进 extension 包。

### 2.2 消息追加（injectGuidance）

**结论：无问题，原封不动。**

`QoderSession.injectGuidance()` 利用 SDK 的 `priority: 'next'` + `shouldQuery: false`，把一条 user message 注入上下文但不触发 assistant 回复。调用链：`ChatService.injectGuidance()` → `QoderChatDriver.injectGuidance()` → `QoderSession.injectGuidance()`。

整条链路在 extension 内部完成，不经过 pi 事件系统。

### 2.3 HITL（Human-in-the-Loop）

**结论：保留现有实现，不改。**

当前 HITL 完全是自己写的，SDK 原生 hook 只是拦截点：

**Task 路径**：

- SDK `PermissionRequest` hook → `buildPermissionHooks()` 拦截（`qoder-task-agent.ts` L122-192）
- → `onPermissionRequest` 回调 → main.ts IPC → 渲染进程 `ToolApprovalCard`
- → 用户决策返回 → hook 翻译为 `allow / deny / askUser + updatedInput`

**Chat 路径**：

- SDK `can_use_tool` 控制请求 → `QoderToolPermissionHandler` 拦截（`qoder-chat-driver.ts` L468-521）
- → `pushApproval` → 前端渲染 `AskUserQuestionCard`（内联卡片，非模态框）
- → 用户回答 → 翻译为 `allow + updatedInput` / `deny + message`

**Extension 化后**：这两条链路**完全不变**。HITL 发生在 SDK 内部 agent loop → SDK 触发 hook/canUseTool → extension 内部拦截 → IPC → 前端。全程在 extension 内部完成，pi 事件系统不参与。

`buildPermissionHooks()` 和 `QoderToolPermissionHandler` 原封不动搬进 extension。

### 2.4 Trace 采集

**结论：仍走 SDK `onMessage` 主路径，QoderTraceBuilder 原封不动。**

Qoder SDK 的 agent loop 内部执行工具、生成消息、委派子任务——这些事件**全部通过 `onMessage` 回调流出**。`QoderTraceBuilder`（631 行）正是基于 `onMessage` 的 SDKMessage 流做 span 状态机转换。

Pi 的事件系统（`tool_execution_start/end`、`agent_start/end`）对 SDK 内部工具不可见，**不能替代** `onMessage`。

**Extension 化后**：`QoderTraceBuilder` + `TracePipeline` 的引用关系不变，代码原封不动搬进 extension。`onMessage` 回调内的 trace 采集逻辑（`qoder-task-agent.ts` L548-553）不变。

### 2.5 子任务消息渲染

**结论：无问题，原封不动。**

子任务三类消息（`task_started` / `task_progress` / `task_notification`）的处理链路：

1. SDK `onMessage` → `QoderSession.handleMessage()` 解析 → 生成 `DriverPart`（`qoder.subtask-start/progress/end`）
2. `DriverPart` → `ChatStreamChunk` → IPC → 前端
3. 前端 `PartRenderer` → `groupByParentTask` → `SubTaskGroup` 渲染

关键机制：

- `taskIdByToolUseId` 映射（`tool_use_id` → `task_id`）
- `parent_tool_use_id` 反查（确定消息所属子任务）
- `parentTaskId` 标记（前端分组依据）

全部在 extension 内部的 `QoderSession` 中完成。前端渲染代码零改动。

### 2.6 Chat 消息序列化

**结论：DriverPart 类型不变，QoderChatDriver 搬进 extension。**

14 种 `driverId: 'qoder'` 的 DriverPart 类型定义（`chat-types.ts`）和前端渲染组件（`PartRenderer.tsx`）不变。

`QoderChatDriver` 搬进 extension 后：

- `ChatDriver` 接口不变
- `ChatDriverRegistry` 注册方式不变
- `ChatService` 通过 registry 获取 driver，不感知 extension
- `raw` 字段格式不变（向后兼容）
- `deserializeMessage` / `serializeUserMessage` / `serializeAssistantMessage` 逻辑不变

### 2.7 会话续接（Resume）

**结论：无问题，`task.qoderSessionId` 字段保留。**

任务恢复依赖 `task.qoderSessionId`，由 `QoderSession` 的 `resume` 参数恢复。Extension 化后 sessionId 的生成/消费仍在 extension 内部，宿主只负责持久化 sessionId 字符串（通过 `TaskStore`）。

不需要改用 pi 的 `appendEntry()`——现有 `TaskStore` 的 `task.qoderSessionId` 字段已经够用，改它反而引入兼容性风险。

### 2.8 计划模式

**结论：QoderPlanModeProvider 搬进 extension，与 PiAgentPlanModeProvider 并存。**

当前两套 PlanModeProvider：

| Provider                  | 位置                      | 机制                                                                             |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `QoderPlanModeProvider`   | `task-agent/plan-mode/`   | SDK `query()` + `permissionMode: 'plan'` + `settings.general.plan.enabled: true` |
| `PiAgentPlanModeProvider` | `pi-package/plan-mode.ts` | spawn 只读 pi 子进程，用 read/grep/find/ls 做只读分析                            |

Extension 化后：

- `QoderPlanModeProvider`（134 行）搬进 extension，直接 import SDK
- `PiAgentPlanModeProvider` 留在 pi-package，不变
- `PlanModeProvider` 接口（`packages/core/src/plan-mode.ts`）不变，是两者的公共抽象

**Chat 侧计划模式**（`qoder-chat-driver.ts` L427）：`permissionMode: 'default'` + 系统提示约束 LLM 行为（只读分析），不走 SDK 的 plan 模式。这个逻辑跟着 `QoderChatDriver` 一起搬进 extension。

### 2.9 main.ts 巨型文件

**结论：Qoder 相关逻辑全部搬进 extension，main.ts 自然瘦身。**

搬进 extension 的代码：

| 当前位置                                | 搬去哪里                               |
| --------------------------------------- | -------------------------------------- |
| `createQoderTaskAgent()`                | extension 内部构造                     |
| `runQoder()`                            | extension 内部方法                     |
| `runQoderPlan()`                        | extension 内部方法                     |
| `runQoderTestCases()`                   | extension 内部方法                     |
| `getQoderStatus()` / 模型管理           | extension 内部方法                     |
| `callQoderReviewer()`                   | extension 内部方法                     |
| `buildPermissionHooks()`                | extension 内部方法                     |
| 9 处 `runtimeProvider === 'qoder'` 分支 | 收敛为 provider 抽象，main.ts 只调接口 |

main.ts 剩余角色：

- App 生命周期 + IPC 注册
- TaskWorkflow 状态机（provider 无关）
- Pi session 管理（`startPi()` / `stopPi()`）
- Extension 加载（`resourceLoader.reload()`）
- Provider 选择逻辑（`runtimeProvider(task)` → 调对应 driver）

---

## 3. 搬迁清单

### 3.1 搬进 `packages/qoder-extension/` 的文件

| 源文件                                                      | 搬迁方式                                    | 改动量 |
| ----------------------------------------------------------- | ------------------------------------------- | ------ |
| `electron/qoder/qoder-session.ts` (771 行)                  | 原封不动                                    | 0      |
| `electron/task-agent/qoder-task-agent.ts` (762 行)          | 去掉对 main.ts 全局变量的引用，改为依赖注入 | 小     |
| `electron/task-agent/plan-mode/qoder-plan-mode.ts` (134 行) | 原封不动                                    | 0      |
| `electron/task-agent/log.ts` (~500 行)                      | 原封不动                                    | 0      |
| `electron/trace/instrument/qoder-trace-builder.ts` (631 行) | 原封不动                                    | 0      |
| `electron/chat/drivers/qoder-chat-driver.ts` (527 行)       | 搬进 extension，import 路径调整             | 小     |

### 3.2 留在原处的文件

| 文件                                       | 原因                              |
| ------------------------------------------ | --------------------------------- |
| `electron/chat/drivers/chat-driver.ts`     | `ChatDriver` 接口定义，宿主侧     |
| `electron/chat/drivers/driver-registry.ts` | Registry，宿主侧                  |
| `electron/chat/chat-types.ts`              | `DriverPart` 类型定义，前端依赖   |
| `electron/chat/chat-service.ts`            | 宿主侧编排                        |
| `electron/trace/bus/trace-pipeline.ts`     | Trace 存储层，宿主侧              |
| `packages/pi-package/`                     | Pi extension，不变                |
| `packages/core/src/plan-mode.ts`           | `PlanModeProvider` 接口，公共抽象 |

### 3.3 需要调整的引用

| 改动                                                 | 说明                                             |
| ---------------------------------------------------- | ------------------------------------------------ |
| `qoder-task-agent.ts` 中对 main.ts 全局变量的引用    | 改为通过 `QoderTaskAgentDeps` 注入（已有此模式） |
| `qoder-chat-driver.ts` 中对 `getQoderStatus` 的引用  | 改为 extension 内部提供                          |
| `main.ts` 中 9 处 `runtimeProvider === 'qoder'` 分支 | 收敛为 driver 接口调用，分支移到 extension 内部  |

---

## 4. 改造步骤

### Phase 1：创建 qoder-extension 包 + 代码搬迁

**工作量**：3-5 天

1. 新建 `packages/qoder-extension/`

   ```
   packages/qoder-extension/
   ├── src/
   │   ├── index.ts              # ExtensionFactory 入口
   │   ├── qoder-session.ts      # ← electron/qoder/qoder-session.ts
   │   ├── qoder-task-agent.ts   # ← electron/task-agent/qoder-task-agent.ts
   │   ├── qoder-chat-driver.ts  # ← electron/chat/drivers/qoder-chat-driver.ts
   │   ├── qoder-plan-mode.ts    # ← electron/task-agent/plan-mode/qoder-plan-mode.ts
   │   ├── log.ts                # ← electron/task-agent/log.ts
   │   └── trace-builder.ts      # ← electron/trace/instrument/qoder-trace-builder.ts
   ├── package.json              # 依赖 @qoder-ai/qoder-agent-sdk
   └── tsconfig.json
   ```

2. 搬迁文件，调整 import 路径
3. `qoder-task-agent.ts`：去掉对 main.ts 全局变量的引用，改为 `QoderTaskAgentDeps` 注入
4. `qoder-chat-driver.ts`：`QoderStatusProvider` 改为 extension 内部提供
5. 入口 `index.ts` 实现 `ExtensionFactory`：`(pi) => { ... }`
6. 验证编译通过

### Phase 2：宿主侧适配

**工作量**：3-5 天

1. `main.ts`：

   - 删除已搬迁的代码（`runQoder` / `runQoderPlan` / `runQoderTestCases` / `getQoderStatus` / `buildPermissionHooks` 等）
   - 9 处 `runtimeProvider === 'qoder'` 分支改为通过 driver 接口调用
   - Extension 加载：`resourceLoader.reload()` 路径加入 qoder-extension
   - IPC handler 调整：指向 extension 暴露的方法

2. `ChatService`：

   - `ChatDriverRegistry` 注册 `QoderChatDriver`（从 extension 包 import）
   - 接口不变，只是 import 路径变了

3. `TaskAgentDriver` 注册：
   - `createQoderTaskAgent()` 改为从 extension 包获取

### Phase 3：验证 + 清理

**工作量**：2-3 天

1. 全量回归测试：
   - Chat 路径：对话、HITL、子任务渲染、消息追加、引导
   - Task 路径：计划生成、实现执行、测试用例、暂停/恢复
   - Trace：span 完整性、子任务嵌套
2. 清理旧路径（确认无引用后删除原文件）
3. 更新 `tsconfig` references

---

## 5. 不变的东西（明确列出）

以下机制在 extension 化后**完全不变**：

| 机制                                                     | 原因                                             |
| -------------------------------------------------------- | ------------------------------------------------ |
| SDK `onMessage` 回调                                     | Extension 在同进程中直接持有 SDK Query，回调不变 |
| `buildPermissionHooks()`                                 | HITL 拦截逻辑不变，只是代码位置变了              |
| `QoderToolPermissionHandler` + `canUseTool`              | Chat HITL 不变                                   |
| `QoderTraceBuilder`                                      | SDK 消息 → span 的状态机不变                     |
| `DriverPart` 类型定义                                    | 前端依赖的类型不变                               |
| `PartRenderer` 渲染逻辑                                  | 前端不变                                         |
| 子任务解析（`taskIdByToolUseId` / `parent_tool_use_id`） | SDK 消息解析不变                                 |
| `injectGuidance()`                                       | SDK 进程内机制不变                               |
| `inputStream()` / `inputQueue`                           | SDK 会话管理不变                                 |
| `task.qoderSessionId` 持久化                             | TaskStore 字段不变                               |
| Chat `raw` 字段格式                                      | DriverPart 序列化不变                            |
| `TracePipeline` 接口                                     | 宿主侧存储层不变                                 |

---

## 6. 数据兼容性

| 数据                  | 兼容策略                                  |
| --------------------- | ----------------------------------------- |
| `task.qoderSessionId` | 保留字段，不变                            |
| Chat 历史 `raw` 字段  | 格式不变，向后兼容                        |
| Trace JSONL 文件      | span 格式不变                             |
| Task event            | 格式不变（`addTaskEvent` 接口不变）       |
| Pi session            | 不变（qoder-extension 不修改 pi session） |

---

## 7. 工作量估算

| Phase             | 工作量      | 说明                                    |
| ----------------- | ----------- | --------------------------------------- |
| Phase 1：代码搬迁 | 3-5 天      | 主要是 import 路径调整 + 依赖注入改造   |
| Phase 2：宿主适配 | 3-5 天      | main.ts 瘦身 + IPC 调整 + registry 注册 |
| Phase 3：验证清理 | 2-3 天      | 全量回归 + 旧代码清理                   |
| **总计**          | **8-13 天** |                                         |

工作量比之前评估的 16-25 天更少，因为：

- 不需要适配 pi 事件系统（HITL/Trace 保持 SDK 原生路径）
- 不需要改前端渲染
- 不需要改 Chat 序列化格式
- 核心工作就是**代码搬迁 + import 路径调整**

---

## 8. 风险

### 风险 1：循环依赖

`packages/qoder-extension` 依赖 `@qoder-ai/qoder-agent-sdk`，同时需要引用 `@task-pipeline/core` 的类型（`PlanModeProvider`、`TaskAgentDriver` 等）。需确认 `packages/core` 不反向依赖 SDK。

**缓解**：`packages/core` 只定义接口，不 import SDK。当前已是此模式。

### 风险 2：main.ts 全局变量

`qoder-task-agent.ts` 通过 `QoderTaskAgentDeps` 接收外部依赖（已有注入模式），但可能有遗漏的直接引用。

**缓解**：搬迁前全局搜索 `qoder-task-agent.ts` 中对 `electron/main.ts` 导出符号的引用，逐一确认已注入。

### 风险 3：Extension 加载顺序

qoder-extension 需要在 pi-package 之后加载（因为 qoder-extension 可能依赖 pi-package 注册的某些工具或命令）。

**缓解**：`resourceLoader.reload()` 的路径数组中明确顺序。当前 qoder-extension 不依赖 pi-package 的运行时状态，加载顺序不敏感。

---

## 9. 总结

这次改造的本质是**代码组织重构**——把散落在 `electron/task-agent/`、`electron/qoder/`、`electron/main.ts` 中的 Qoder 相关代码收拢到一个独立的 extension 包中。

**运行时行为完全不变**：

- SDK 工具执行仍在 SDK 内部
- HITL 仍走 SDK hook/canUseTool 拦截
- Trace 仍走 SDK onMessage
- 子任务消息仍在 extension 内部解析
- 前端渲染零改动

**唯一的变化**：代码的物理位置和 import 路径。
