# Trace 任务工具渲染优化方案（v2：任务清单卡）

> 关联 trace：`35c40d04-c84f-487a-83c3-a102c767d771`
> v2 修订：以实测截图（任务清单卡 + 文件变更并列）为目标形态，取代 v1 的「行内语义化为主」思路。
> 前置分析见：[trace-task-tool-recognition.md](./trace-task-tool-recognition.md)

## 1. 现状问题（实测）

| #   | 问题         | 现象                                                                                                                                                                   |
| --- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **信息缺失** | TaskCreate 的 input 落盘为 `{}`（SDK 行为），主题「修改 types/index.ts」只存在于 output 文本 `Task #1 created successfully: ...`，执行 Tab 与 Trace 页都看不到任务内容 |
| P2  | **视觉噪音** | 一条 trace 里 TaskCreate × 7 + TaskUpdate × 20+ 全部平铺为普通工具行，TaskUpdate 密集刷屏、无信息增量（只是「更新 #N 状态」）                                          |
| P3  | **语义错位** | 任务工具被渲染成普通「工具」行（Waterfall 的 TYPE_LABELS['tool.execute'] = '工具'；PartRenderer 落 ToolCallRow 兜底），与它们「管理任务清单」的语义不符                |

## 2. 目标形态（对齐实测效果）

任务工具（TaskCreate/TaskUpdate）在**执行 Tab** 中聚合为一张常驻的任务清单卡，与文件变更区上下并列，构成执行进度看板：

```
┌──────────────────────────────────────────────────────┐
│ 添加待办                                             │  ← 清单 header（标题位）
│                                                      │
│  ● 重新设计 DetailHeader 描述块和验收标准的视觉样式    │  ← 进行中：radio 选中态高亮
│  ○ 更新 DetailHeader 测试以匹配新样式                 │  ← 待办
│  ○ 运行测试和 lint 验证                              │  ← 待办
└──────────────────────────────────────────────────────┘
──────────────────────────────────────────────────────
  DetailHeader.tsx   +34 -52 M            [已应用]        ← 文件变更区（现有组件）
```

关键 UI 细节：

1. **清单卡**：圆角卡片（`border-border/40` + `bg-muted/20` + `rounded-md`，与 DetailHeader 描述块/验收标准同款设计语言）
2. **常驻展开**：默认展开不折叠，作为看板主体；header「添加待办」为标题位
3. **条目状态**：待办（常规态）/ **进行中（高亮）** / 已完成（弱化或勾选态）
4. **与文件变更并列**：清单卡出现后，执行流中不再出现 TaskCreate/TaskUpdate 工具行

## 3. 前置：任务工具语义归一化（共享解析）

在 core 包新增共享解析（`packages/core/src/trace/task-tool-meta.ts`），双端复用：

```ts
export const TASK_TOOL_NAMES = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop']

export type TaskToolMeta = {
  isTaskTool: boolean
  action: 'create' | 'update' | 'get' | 'list' | 'stop'
  taskId?: string // output 里的 #N
  subject?: string // create 的主题
}

export function parseTaskToolMeta(span: { name: string; output?: unknown }): TaskToolMeta
```

output 解析规则（对老数据是唯一来源，不依赖埋点新字段）：

| 工具                          | output 样例（实测）                                              | 解析                                                         |
| ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| TaskCreate                    | `Task #1 created successfully: 修改 types/index.ts`              | `#(\d+)` → taskId；`created successfully:\s*(.+)$` → subject |
| TaskUpdate                    | `Updated task #1 status` / `Updated task #1 status to completed` | `#(\d+)` → taskId；`to (\w+)` → status                       |
| TaskGet / TaskList / TaskStop | 同类 `Task #N ...` 前缀                                          | taskId 提取，无 subject 时显示原 output                      |

要点：正则只做**前缀 + 常见形态**匹配，解析失败降级为「原工具名 + 原 output」，绝不吞数据。

## 4. 主方案：任务清单卡（TaskListCard）

### 4.1 数据流

`useTasks.ts` 的 `eventsToDriverParts` 在事件 → DriverPart 转换阶段做「任务工具序列扫描」：

1. 遍历 tool 事件（phase=use 且工具名命中 `TASK_TOOL_NAMES`），用 `parseTaskToolMeta` 解析
2. 按分组键聚合：一段**连续**的任务工具调用（相邻任务工具事件之间未穿插其它工具动作）聚为一张清单
   - 连续性判定：两个任务工具事件之间允许穿插少量消息/thinking（agent 会先说再做），但穿插了 Write/Edit/Bash 等实质工具动作则断开
   - 单次调用（前后无其他任务工具）不聚合，走方案 A 行内展示
3. 产出新 part 类型 `qoder.task-list`（内嵌条目数组），替换原始 tool parts；PartRenderer 增加渲染分支

### 4.2 条目模型与状态推导

```ts
type TaskListPart = {
  driverId: 'qoder'
  type: 'qoder.task-list'
  header: string // 「添加待办」标题位
  items: Array<{
    taskId: string // #N
    subject: string // create output 解析
    status: 'pending' | 'active' | 'completed'
  }>
  parentTaskId?: string
}
```

状态推导规则：

- TaskCreate → 条目新建，status = `pending`
- TaskUpdate（解析到 status）→ 对应条目更新为 `completed`（`to completed`）或 `pending`（其他状态）
- TaskUpdate（解析不到 status）→ 条目标记为最近活跃
- **进行中判定**：本清单内最后一条任务工具调用指向的条目 → `active`（高亮）；清单所在阶段结束后（阶段 agent.run 收尾），全部条目若无明确 completed 标记则保留为 pending
- 顺序：以条目首次出现顺序为准（= TaskCreate 顺序，与清单 #N 一致）

### 4.3 组件（TaskListCard）

- 位置：`apps/desktop/src/pages/ChatPage/drivers/parts/TaskListCard.tsx`（与 ToolBlocks 同级）或 `apps/desktop/src/components/`
- 样式：`rounded-md border border-border/40 bg-muted/20`（与 DetailHeader 描述块同款）；header 行「添加待办」小标题（text-[11px] muted）；条目行 text-xs
- 条目渲染：
  - `active`：radio 选中态高亮（accent/foreground 强调，圆点实心）
  - `completed`：弱化（text-muted-foreground/50 + 勾选样式或划线？—— 截图无已完成态，先做弱化，不划线）
  - `pending`：常规态（圆点空心）
- 无状态徽章噪音：清单卡内不重复「已创建/已更新」字样，状态即条目形态

## 5. 兜底：行内语义化（方案 A，清单触发条件外）

单次孤立的任务工具调用（不满足聚合条件）走专用渲染器 `TaskToolBlock`（放 ToolBlocks.tsx）：

- TaskCreate：`[📋] 创建任务 · 修改 types/index.ts`（violet 强调）
- TaskUpdate：`更新任务 #1 → completed`（muted 弱化）
- TaskGet/TaskList/TaskStop：按 action 文案（`查看任务 #N` / `列出任务` / `停止任务 #N`）
- 展开显示原始 output；input 为空对象时不渲染「参数」段

## 6. 兜底：Trace 页 Waterfall 语义化（方案 B）

`Waterfall.tsx` 的 `renderRow` 增加任务工具分支（与现有 `delegated` 分支并列）：

- 类型标签：`任务`（violet）+ 名称 `创建 · {subject}` / `更新 #{taskId}`
- 时间条 violet，create/update 小徽章
- 时间轴保真：不聚合，每个调用真实占位（清单卡只做在执行 Tab）

## 7. 改动清单汇总

| 层       | 文件                                                                     | 改动                                                            |
| -------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 共享解析 | `packages/core/src/trace/task-tool-meta.ts`（新建）                      | `TASK_TOOL_NAMES` + `parseTaskToolMeta`                         |
| 聚合     | `apps/desktop/src/pages/CodingPage/hooks/useTasks.ts`                    | `eventsToDriverParts` 任务工具序列扫描 → `qoder.task-list` part |
| 渲染     | `apps/desktop/src/pages/ChatPage/drivers/parts/TaskListCard.tsx`（新建） | 清单卡组件（header + 条目 + 进行中高亮）                        |
| 渲染     | `apps/desktop/src/pages/ChatPage/drivers/PartRenderer.tsx`               | `qoder.task-list` 渲染分支 + 任务工具路由到 TaskToolBlock       |
| 渲染     | `apps/desktop/src/pages/ChatPage/drivers/parts/ToolBlocks.tsx`           | 新增 `TaskToolBlock`（兜底行内展示）                            |
| Trace 页 | `apps/desktop/src/pages/TracePage/components/Waterfall.tsx`              | 任务工具行语义化                                                |
| 测试     | core 解析单测 / useTasks 聚合单测 / PartRenderer 渲染测试                | 补用例                                                          |

## 8. 测试与验收

1. **解析单测**：实测 output 样本（create 含 subject、update 含/不含 status、非任务工具名）验证四种分支与降级路径。
2. **聚合单测**：7×create + 20×update 序列 → 1 个 `qoder.task-list` part，items 7 条、状态正确；穿插 Write 的序列正确断开；单次调用不聚合。
3. **执行 Tab 验收**：打开原 trace 对应任务，确认清单卡形态与截图一致（header「添加待办」、进行中条目高亮、无工具行噪音）。
4. **Waterfall 验收**：任务工具行「任务」标签 + subject/编号 + violet 时间条，详情仍可看原始 output。
5. **回归**：非任务工具渲染不受影响；input 有内容的历史调用不受影响。

## 9. 路线

1. **先做清单卡**（共享解析 + useTasks 聚合 + TaskListCard + PartRenderer 分支）：一次对齐目标形态，解决 P1/P2/P3。
2. **再做兜底**（TaskToolBlock 行内 + Waterfall 语义化）：覆盖聚合条件外的孤立调用与 Trace 页。
3. 埋点层 output 语义回填（写入 span meta）为后续增强，非本方案前置条件——渲染层解析已覆盖老数据。
