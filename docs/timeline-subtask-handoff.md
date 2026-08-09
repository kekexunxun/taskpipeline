# Timeline 子任务折叠卡 - 交接文档

## 任务背景

**目标**:修复 CodingPage 右侧「执行」Tab 的 Timeline,把子任务(Qoder 子 Agent 任务)渲染成可折叠的卡片,跟主流程 TimelineEntryBody 视觉一致。

**为什么这件事反复迭代**:

- 用户非常重视「视觉一致」,任何跟主流程 TimelineEntryBody 不同的展示都会被打回
- 数据有三种形态:新写入(我改完 log.ts 之后)、历史数据(老 events 表里 payload 缺失)、更老存量(commit `437cba0` 之前 detail 是 raw JSON)
- 子任务内的子条目要分类展示:task_progress、task_notification、tool_use、tool_result,各自形态不同

---

## 涉及文件

| 文件                                                                                                                                | 角色                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [apps/desktop/src/components/SubTaskGroup.tsx](../apps/desktop/src/components/SubTaskGroup.tsx)                                     | **新建** 通用子任务折叠卡组件,视觉跟 TimelineEntryBody 对齐                            |
| [apps/desktop/src/components/SubTaskGroup.test.tsx](../apps/desktop/src/components/SubTaskGroup.test.tsx)                           | 新建,12 个测试                                                                         |
| [apps/desktop/src/pages/CodingPage/components/Timeline.tsx](../apps/desktop/src/pages/CodingPage/components/Timeline.tsx)           | 重构,改用 SubTaskGroup + 新增 SubTaskToolRow / SubTaskEventRow / renderSubTaskChildren |
| [apps/desktop/src/pages/CodingPage/components/Timeline.test.tsx](../apps/desktop/src/pages/CodingPage/components/Timeline.test.tsx) | 改 5 个老测试预期 + 新增 4 个新测试,14 个测试                                          |
| [apps/desktop/electron/task-agent/log.ts](../apps/desktop/electron/task-agent/log.ts)                                               | 抽 tool_use/tool_result → kind='tool' 事件 + task_progress 补 summary 字段             |
| [apps/desktop/electron/task-agent/log.test.ts](../apps/desktop/electron/task-agent/log.test.ts)                                     | 新增 5 个测试,8 个测试                                                                 |
| [apps/desktop/electron/task-agent/qoder-task-agent.ts](../apps/desktop/electron/task-agent/qoder-task-agent.ts)                     | addTaskEvent 类型扩 'tool' + parentTaskId/subtaskId/sdkSubtype/payload                 |
| [apps/desktop/src/pages/ChatPage/drivers/PartRenderer.tsx](../apps/desktop/src/pages/ChatPage/drivers/PartRenderer.tsx)             | **未改**,但用了 SubTaskGroup 组件                                                      |

---

## 关键设计决策

### 1. SubTaskGroup 视觉

跟主流程 TimelineEntryBody 严格对齐:

- 左侧:`26px` 列 + 圆点 + GitBranchIcon(子任务专用图标,跟主流程的 ActivityIcon / MessageSquareTextIcon 区分)
- 右侧上方:trigger 行 `flex items-center justify-between`
  - 左:chevron + `header`(默认是 `SubTaskHeader` 渲染 description + type 徽章 + 状态徽章)
  - 右:`<time>` 显示 createdAt
- 右侧下方:`CollapsibleContent` 折叠内容,默认折叠

触发器 `data-subtask-id={taskId}` 放在 `CollapsibleTrigger` 上(不是 article),保留 PartRenderer 的 querySelector 兼容。

### 2. 时间穿插 `interleaveTimeline`

新工具函数在 SubTaskGroup.tsx,取代旧的 `groupByParentTask`:

- **第 1 步**:同 `parentTaskId` 的所有项合并到同一个 groupMap
- **第 2 步**:把 main + group 混合按 `index` 排序,group 位置由 header 出现的位置决定

效果:子任务卡出现在它实际发生的时间点附近,后续主流程消息从 group 之后继续渲染(不再是「先全部 main + 再全部 groups」)。

### 3. log.ts 写 tool_use / tool_result

- 进程级 `recordQoderSubtaskCtx` 加 `toolNameByToolUseId: Map<toolUseId, toolName>`
- assistant 消息遍历 content block:
  - `type: 'tool_use'` → 写入 toolName 映射,提 `phase: 'use'` + `input` 写一条 `kind: 'tool'` 事件
- user 消息遍历 content block:
  - `type: 'tool_result'` → 反查 toolName,提 `phase: 'result'` + `output` + `isError` 写一条 `kind: 'tool'` 事件
- input/output 用 `JSON.stringify(value, null, 2).slice(0, 2000)` 写 detail 字段

### 4. Timeline 渲染 tool 配对

新增 `renderSubTaskChildren` 函数:

- 识别 kind='tool' 事件,按 `payload.toolUseId` 配对
- 同 toolUseId 的 use + result 渲染到 `SubTaskToolRow` 一行
- 其它子条目(task_progress/notification)走 `SubTaskEventRow`
- 合并后按 `createdAt` 升序,保证时间线流式连贯

### 5. SubTaskEventRow 视觉(用户最敏感)

最终设计:

- 标题直接是 `lastToolName`(如 "Read" / "Glob" / "Bash"),**不显示「进度」「收尾」笼统词**
- 标题行:`bg-muted/30` 深色背景 + `border-border/40` 边框 + `rounded-md`,跟主流程时间线视觉拉开
- 右侧:status 徽章(如 "completed")+ 时间
- 描述(description)作为下方独立段落,`bg-background/50` 略浅背景

**关键反馈**:用户三次明确要求「视觉一致」「不突兀」「不要把 Bash 展示成 Bash 效果」(指不要用 monospace 徽章包工具名),最终用 `strong` 粗体文字当标题。

### 6. 兜底分支(三层数据兼容)

`subtaskMetaOf` 识别 description 字段时:

1. `payload.description`(新数据)
2. `payload.summary` 兜底(Qoder SDK task_progress.description 经常空,summary 才有内容)

`subtaskMetaOf` 历史数据兜底:

- title 匹配 `^Qoder task_(started|progress|notification)$` 识别 subtype
- detail JSON 反解 `task_id` 自指为 parentTaskId
- task_started 补 taskType/description
- task_notification 补 status/description(summary 兜底)
- task_progress 补 lastToolName + description(summary 兜底)

---

## 已知问题/限制

### 1. 旧 events 数据没 description

**症状**:用户已经跑过的任务(在我改 log.ts 之前),events 表里 task_progress 事件的 payload 没 description 字段,detail 字段是 raw JSON 字符串。

**修复路径**:

- 短期:刷新页面后,subtaskMetaOf 走历史数据兜底分支,从 detail JSON 反解 description(已实现)
- 长期:跑新任务时,新数据自动有 summary 字段

### 2. better-sqlite3 NODE_MODULE_VERSION 环境问题

`apps/desktop/electron/trace/trace-service.test.ts` 9 个测试因为 `better-sqlite3` 二进制不匹配 Electron 136 vs Node 127 失败。**与本次修改无关**,预先存在。

修复:`cd apps/desktop && npm rebuild better-sqlite3`。

### 3. ai-elements 旧代码 typecheck 错误

`apps/desktop/tsconfig.json` 下跑 typecheck 时,`src/components/ai-elements/*.tsx` 有 20 个 type 错误(预先存在,跟 React / 新版 ai-sdk / lucide-react 不兼容)。

**不影响**:`apps/desktop/tsconfig.electron.json` 下 typecheck 0 错误。

---

## 跑测试/验证命令

```bash
cd /Users/robin/Documents/codingagent/apps/desktop

# 单元测试
npx vitest run src/components/SubTaskGroup.test.tsx \
                src/pages/CodingPage/components/Timeline.test.tsx \
                electron/task-agent/log.test.ts

# 全量回归(预计 339/348 通过,9 个失败是 trace-service sqlite 环境问题)
npx vitest run

# typecheck(electron 部分 0 错误)
cd .. && npx tsc -p apps/desktop/tsconfig.electron.json --noEmit
```

---

## 接手时注意事项

1. **不要给 SubTaskGroup 加阴影/margin 修饰**,用户要的是跟主流程时间线「一致 + 拉开层次」(拉开靠深色背景框,不靠阴影)
2. **不要给 lastToolName 用 Badge 样式**(用户两次强调),用 `strong` 粗体文字
3. **不要显示「进度」/「收尾」label** —— 用户明确反对
4. **加 tool 配对时,前端的 toolUseId 是 log.ts 写出的**,不要自己造
5. **历史数据兜底**别删,用户生产数据是混合的(新 + 老 + 更老)
6. **`task_progress` 的 description 字段在 SDK 实际是空字符串**,summary 才是有内容的,前端 subtaskMetaOf 已经兜底

---

## 可能的后续优化(用户没要求)

- SubTaskHeader 的 type 徽章目前在主流程 header 上(展开前可见),展开后看不到
- tool 行没有 input/output 折叠展开,长 JSON 全部展开
- 子任务折叠卡默认折叠,用户可能希望「最近一个子任务默认展开」
- tool 配对逻辑前移:让 log.ts 直接合并 use+result 写一条事件,前端不用配对
