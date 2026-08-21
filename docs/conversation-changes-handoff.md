# 对话级变更呈现 交接文档（纯 parts 推导方案）

> 功能：ChatPage 右侧面板新增「对话变更」Tab，精确回答「本次对话改了哪些文件、做了什么操作」，替代此前仅有 git 工作区粒度的笼统视图。
> 状态：已实现并通过验证（2026-08）。本文档面向后续维护者。

## 1. 背景与决策过程

### 1.1 起点

- 原右侧面板只有一个「文件变更」Tab，数据源是 `workingDirectory` 的 git status（IPC `chats:changed-files`），是**工作区粒度**：无法区分「本次对话改的」与「用户自己/其他进程改的」。
- 参考 Qoder CLI 的会话存储（`session.jsonl` + 同名侧文件夹）与 [Qoder checkpoint 文档](https://docs.qoder.com/zh/cli/sdk/checkpoint)，最初曾考虑过侧文件夹 + manifest + `.base/.current` 快照方案（v1 计划），经讨论被否决。

### 1.2 最终收敛的核心判断

| 判断                                         | 结论                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 展示数据从哪来                               | `chat-{id}.json` 已持久化的 parts 就是单一事实源：`qoder.tool-use` 的 input 含 `file_path`（Write 另有 `content`、Edit 另有 `old_string`/`new_string`），配对的 `tool-result` 含成功/失败 |
| 要不要建侧文件夹/快照                        | **不要**。只要展示、不做回滚确认流，快照没有消费方；纯推导零存储、零 IPC、可回溯全部旧对话                                                                                                |
| 列表形态                                     | 同一文件只出现一行，多次操作合并展示（用户拍板）                                                                                                                                          |
| added/modified 标签                          | **不贴**。无基线时该标签是不可靠推断，改为展示操作事实（写/改/删 + 次数）                                                                                                                 |
| Bash 间接改动                                | **不追踪**，与 Qoder checkpoint 边界一致（"通过 Bash 直接写文件的变更不作为可回滚文件快照处理"）；「工作区变更」Tab 兜底                                                                  |
| per-conversation worktree（reasonix 式隔离） | 不做。那是沙箱化产品语义变更（apply/merge 流、dirty 播种、磁盘成本），与「实时结对」的 chat 语义冲突，如需单独立项                                                                        |

### 1.3 与 Qoder checkpoint 的对应关系

Qoder 的展示层同样由消息流推导；快照存在 CLI 内部、仅服务 `rewindFiles(userMessageId)`。我们与其哲学一致：展示归消息流，快照（若将来要）归 CLI/rewind 通道，不自建。

## 2. 实现结构

### 2.1 文件清单

| 文件                                                           | 角色                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/pages/ChatPage/conversation-changes.ts`      | **推导层**：纯函数 `deriveConversationChanges` + hook `useConversationChanges` + `getInputField`/`extractChangePath`/`changeOperationKind` 工具函数 |
| `apps/desktop/src/pages/ChatPage/conversation-changes.test.ts` | 推导层单测（vitest，9 用例）                                                                                                                        |
| `apps/desktop/src/pages/ChatPage/components/ChatSidePanel.tsx` | UI：双 Tab（「对话变更」首 Tab 默认选中 /「工作区变更」）、`ConversationChangesContent`/`ChangeFileItem`/`OperationBlock`                           |
| `apps/desktop/src/pages/ChatPage/drivers/parts/ToolBlocks.tsx` | 复用 `WriteToolBlock`/`EditToolBlock`/`DeleteToolBlock` 渲染操作序列；`getInputField` 的本地定义已移除，改为从推导层导入                            |
| `apps/desktop/src/pages/ChatPage/index.tsx`                    | 仅新增给 `ChatSidePanel` 传 `messages={chat.messages}`；面板显示条件不变（仍仅绑定 workingDirectory 的对话显示）                                    |

**后端 / 存储零改动**：无新增 IPC、无文件夹、无快照，chat-storage / chat-service 未触碰。

### 2.2 推导规则（conversation-changes.ts）

两遍扫描：

1. **Pass 1**：跨消息收集全部 `qoder.tool-result` / `openai.tool-result`，按 `toolCallId` 索引（result 可能晚于 tool-use、甚至落在后续消息里，跨消息索引保证配对稳定）；
2. **Pass 2**：按时间序遍历 assistant parts 中的 `qoder.tool-use` / `openai.tool-call`：
   - 工具名**小写匹配** `write / edit / delete / multiedit / notebookedit`（Qoder 大写、Pi 小写均命中）；
   - 路径取 `input.file_path ?? input.path`（复用 `getInputField` 容错逻辑）；
   - 按 path 去重聚合（Map 保序 = 首次出现顺序），操作按时间序追加；
   - status：配对 result 且 `isError` → `error`；有 result → `done`；无 result（流式中）→ `pending`；
   - `displayPath`：workingDirectory 前缀剥离做相对化，外部路径原样保留。

hook 为 `useMemo` 包裹：流式期间 parts 实时增长，推导天然跟随，**无需轮询、无需刷新按钮**。

### 2.3 UI 结构（ChatSidePanel）

```
┌ 对话变更 (2) ─ 工作区变更 (5) ──────────────── ✕ ┐  ← Tabs，对话变更为默认 Tab
│ 📄 src/a.ts            写1 改2                   │  ← 文件去重行：图标=最后一次操作类型
│ 📄 src/b.ts            改1 删1                   │
├──────────────────────────────────────────────────┤
│ src/a.ts（相对路径头）                            │
│ [WriteToolBlock]  ← 按时间序复用对话流组件        │
│ [EditToolBlock]                                  │
│ [EditToolBlock]                                  │
└──────────────────────────────────────────────────┘
```

要点：

- 行图标按**最后一次**操作类型着色（写→`FilePlusIcon` 绿 / 改→`FileEditIcon` 蓝 / 删→`FileXIcon` 红）；
- 行内徽标 `写N/改N/删N`（仅展示操作事实，不贴新增/修改标签）；
- 选中文件的展示回退策略：`files.find(selected) ?? files[0]`，避免流式新增/消失后出现空白态；
- `OperationBlock` 将推导层的 `pending` 映射为 ToolBlocks 的 `running`（未传 `onApprove`，不会误出 HITL 按钮），视觉与对话流完全一致。

## 3. 边界与已知限制

1. **Bash / 外部编辑不进入列表**（设计边界，非缺陷）——需要兜底时切「工作区变更」Tab；
2. **非 git / 未绑定 workingDirectory 的对话**：面板整体不显示（沿用既有 `showSidePanel` 条件，推导层本身不依赖 git）；
3. `MultiEdit`/`NotebookEdit` 归入 write/edit 渲染，但 `EditToolBlock` 只识别 `old_string/new_string`，MultiEdit 的 `edits` 数组展开内容为空（头部与状态正常）——如需完整展示可后续定制；
4. 同名绝对路径才算同一文件，不做符号链接/大小写归一（与工具 input 原值一致）。

## 4. 验证情况

- ESLint：改动文件全绿（曾因在组件文件导出 `getInputField` 触发 react-refresh 告警，已通过反转依赖方向解决：唯一定义在推导层，ToolBlocks 反向导入）;
- 新单测 9/9 通过；
- 全量 vitest：存在 24 个**预存失败**（ThinkingPart/PartRenderer/ChatModelSelector 等），已用 `git stash` 基线对比确认与本次改动无关，零回归；
- typecheck：仅剩 2 个预存错误（`api.onTaskEvent` 签名改 `unknown` 后 `index.tsx` L70 与 `useTrace.ts` L54 的调用处未跟进），与本次改动无关。

## 5. 后续议题（本次明确不做，按需立项）

1. **rewind 能力**：按 Qoder checkpoint 接入——`QoderSession` 创建选项加 `enableFileCheckpointing`，user 消息补传 `uuid`（当前 `electron/qoder/qoder-session.ts` 的 user 消息未传 uuid；我们自建的 user message id 即可作锚点），然后 `rewindFiles(userMessageId)`（支持 dryRun 预览 `filesChanged/insertions/deletions`）；
2. **bash 归属兜底层**（曾讨论、未纳入）：对话开始时 `git stash create` 取 baseSha + 记录初始 untracked 列表存入 conversation meta，按需 `git diff baseSha` 展示为「其他变更（bash/外部）」。注意 gc 修剪（约 2 周）、非 git 退化、旧对话无 baseSha 等边界；
3. **存储层 jsonl 化**：`chat-{id}.json` 整文档替换语义（3s partial persist 全量重写、无缓存淘汰）与 jsonl 追加语义的权衡是独立议题，与展示方案正交。

## 6. 维护指引

- 新增写类工具 → 改 `conversation-changes.ts` 的 `MUTATING_TOOLS` 与 `changeOperationKind`，并在 `OperationBlock` 补渲染分支；
- 工具路径字段名变化 → 改 `extractChangePath`；
- 推导层是纯函数，改规则务必同步补 `conversation-changes.test.ts`；
- 「对话变更」Tab 不消费任何 IPC，出现数据问题时先查 parts 落盘（chat-service 的 parts 累积与 partial persist），而不是查 git。

## 7. Qoder Driver Edit工具的input

```
{
  "file_path": "/Users/robin/Documents/codingagent/apps/desktop/src/pages/ChatPage/drivers/PartRenderer.tsx",
  "instruction": "Add a case to hide AskUserQuestion tool calls in the PartRenderer, similar to how glob/find/ls are hidden. The AskUserQuestion interaction is rendered by the inline AskUserQuestionCard via the approval system, so the generic ToolCallRow should not render.",
  "new_string": "      // 目录列举类工具（Qoder Glob / Pi find+ls+list_dir）不单独展示，统一隐藏\n      if (\n        toolNameLower === 'glob' ||\n        toolNameLower === 'find' ||\n        toolNameLower === 'ls' ||\n        toolNameLower === 'list_dir'\n      ) {\n        return null\n      }\n      // AskUserQuestion：交互由内联 AskUserQuestionCard（approval 体系）承载，通用 ToolCallRow 隐藏。\n      if (toolNameLower === 'askuserquestion') {\n        return null\n      }",
  "old_string": "      // 目录列举类工具（Qoder Glob / Pi find+ls+list_dir）不单独展示，统一隐藏\n      if (\n        toolNameLower === 'glob' ||\n        toolNameLower === 'find' ||\n        toolNameLower === 'ls' ||\n        toolNameLower === 'list_dir'\n      ) {\n        return null\n      }"
}
```
