# 计划：UI 架构重构 + Chat 页面（JSONL 持久化 + 模型选择器）

## 1. 目标概述

将现有 `apps/desktop/src` 从单文件 `App.tsx`（517 行）改造为按 `layout / pages / components / hooks / utils` 划分的常规前端结构，新增：

1. **左侧操作栏**（VSCode 样式，56px 宽），承载 2 个页面入口：对话（默认）/ 编码。
2. **对话页面**（Codex 样式）：左侧历史对话列表 + 右侧常规对话区域 + 模型选择器（按 Provider 分组）。**完整实现**：包含 JSONL 持久化 + 复用系统设置的 LLM 接入。
3. **编码页面**：现有看板 + 详情整体平移至 `pages/CodingPage/`，行为完全保留。

整体布局变更为 `上（左中右）下`：
- **上**：48px 顶栏（保留现有 `Forge Agent` 品牌 + 设置按钮）+ 主区域三列布局（**左** = 左侧操作栏 / **中** = 页面左侧面板 / **右** = 页面右侧面板）。
- **下**：现有 Qoder 状态栏（条件渲染保留）。

## 2. 现状分析

- `apps/desktop/src/App.tsx`（517 行）：单文件包含所有 UI、state、所有 Dialog、所有事件订阅。
- `apps/desktop/src/api.ts`：Agent API 表面 + demo fallback。
- `apps/desktop/src/styles.css`（92 行）：全局 CSS，类名 BEM 风格散落。
- `apps/desktop/electron/main.ts`（~670 行）：所有 IPC handler 集中。
- `apps/desktop/electron/preload.cts`：通过 `contextBridge.exposeInMainWorld("agentApi", ...)` 暴露 30+ 方法。
- `apps/desktop/electron/preload.cjs`（构建产物）：运行时实际加载。
- `apps/desktop/index.html`：`#root` 挂载点。
- 依赖：`react 19` / `@radix-ui/react-dialog` / `lucide-react`；**无 router**。
- 现有任务状态机走 SQLite（`@coding-agent/core` 的 `TaskStore`），存储于 `userData/coding-agent.db`。

## 3. 整体布局结构

`AppShell` 维持 `display: grid; height: 100vh`：

```
.app-shell              { grid-template-rows: 48px minmax(0,1fr); }
.app-shell.with-status  { grid-template-rows: 48px minmax(0,1fr) 28px; }
.app-body               { display: grid; grid-template-columns: 56px minmax(0,1fr); min-height: 0; }
.app-content            { display: grid; min-width: 0; min-height: 0; }
.app-content.coding     { grid-template-columns: minmax(0,1fr) clamp(390px,31vw,500px); }
.app-content.chat       { grid-template-columns: 280px minmax(0,1fr); }
```

- `ActionBar`：固定 56px 宽，纵向 2 个 `NavLink` 图标（`MessageSquareText` 对话 / `Code2` 编码），高亮态用 `accent` 边框。
- `AppShell` 顶层调 `useQoderStatus()` 一次，通过 `QoderStatusContext` 注入到子树（StatusBar 与 CodingPage 共用，避免重复轮询）。
- `AppShell` 也提供 `FeedbackContext` 注入 `feedback` state。

## 4. 目标目录结构（按页面拆分）

### 4.1 renderer（`apps/desktop/src/`）

```
src/
├── main.tsx                          # 不变：仅 createRoot
├── App.tsx                           # 收敛：HashRouter + AppShell
├── routes.tsx                        # 新增：路由表
├── api.ts                            # 在 AgentApi 旁扩展 ChatApi
├── styles.css                        # 追加新布局/组件样式
├── layout/
│   ├── AppShell.tsx                  # 上(左中右)下 框架 + Provider
│   ├── TopBar.tsx                    # 顶栏（从 App.tsx 提取）
│   ├── ActionBar.tsx                 # 新：左侧操作栏
│   └── StatusBar.tsx                 # 现有 QoderStatusBar 迁入
├── components/                       # 跨页面共享
│   ├── GlobalFeedback.tsx            # 顶部反馈条（依赖 FeedbackContext）
│   └── QoderStatusBar.tsx            # 现有实现搬入
├── pages/
│   ├── ChatPage/
│   │   ├── index.tsx                 # 页面入口（路由渲染）
│   │   ├── components/
│   │   │   ├── ChatHistoryList.tsx   # 左侧历史列表
│   │   │   ├── ChatHistoryItem.tsx   # 单条历史
│   │   │   ├── ChatConversation.tsx  # 右侧消息流
│   │   │   ├── ChatMessage.tsx       # 单条消息气泡
│   │   │   ├── ChatComposer.tsx      # 底部输入 + 发送
│   │   │   └── ChatModelSelector.tsx # 新：模型选择器（分组 dropdown）
│   │   └── hooks/
│   │       └── useChat.ts            # 对话 state + IPC
│   └── CodingPage/
│       ├── index.tsx                 # 页面入口
│       ├── components/
│       │   ├── BoardPanel.tsx        # 4 列看板容器
│       │   ├── BoardColumn.tsx       # 单列
│       │   ├── TaskCard.tsx          # 卡片
│       │   ├── BoardToolbar.tsx      # 工具栏（搜索 + 新建）
│       │   ├── NewTaskMenu.tsx       # 新建下拉
│       │   ├── DetailPanel.tsx       # 右侧详情容器
│       │   ├── DetailHeader.tsx      # 详情头部
│       │   ├── EditorLauncher.tsx    # VSCode/Qoder 启动器
│       │   ├── DetailActions.tsx     # 操作按钮组
│       │   ├── UsageSection.tsx      # 会话消耗
│       │   ├── ChangedFilesSection.tsx
│       │   ├── MergeRequestsSection.tsx
│       │   ├── Timeline.tsx          # 现有 Timeline
│       │   ├── Composer.tsx          # 详情底部 composer
│       │   ├── SettingsDialog.tsx    # 含 RepositoryDialog
│       │   ├── TaskEditorDialog.tsx
│       │   ├── JiraDialog.tsx
│       │   ├── JiraSyncDialog.tsx
│       │   └── UiRequestDialog.tsx
│       └── hooks/
│           ├── useTasks.ts           # 任务列表 + 详情 + 事件订阅
│           └── useNewTaskMenu.ts     # 新建菜单的打开/关闭 + Jira 同步
├── hooks/                            # 跨页面共享
│   ├── useQoderStatus.ts             # Qoder 状态轮询
│   ├── useQoderStatusContext.tsx     # QoderStatusContext + Provider + hook
│   ├── useGlobalFeedback.ts          # FeedbackContext + hook
│   └── useElectronApi.ts             # 包装 window.agentApi，统一异常
└── utils/                            # 跨页面共享
    ├── format.ts                     # formatTokens / formatDuration / formatRelative
    └── status.ts                     # statusLabels / columns / changeStatusLabel / localizedEventTitle
```

**判定原则**：
- 跨页面使用 → `components/` 或 `hooks/` 或 `utils/`
- 单一页面使用 → `pages/<page>/{components,hooks,utils}/`
- 跨页面复用但很小的工具函数（< 20 行）→ 跟随主调用方所属页面放，不强行下沉

`components/QoderStatusBar.tsx` 放在 `components/` 是因为它由 `layout/StatusBar.tsx` 引用，而后者属于布局层。

### 4.2 electron（`apps/desktop/electron/`）

```
electron/
├── main.ts                            # + 新增 chat IPC handler 注册
├── preload.cts                        # + chat API surface
├── chat/
│   ├── chat-service.ts                # 新：ChatService 类（IPC handler 实现）
│   ├── chat-storage.ts                # 新：JSONL 文件读写
│   ├── chat-models.ts                 # 新：listChatModels() 读取 settings + Qoder
│   └── chat-llm.ts                    # 新：Qoder SDK + OpenAI 流式调用封装
```

`chat/` 子目录与 `ocr.ts` / `ocr.test.ts` 风格一致。

## 5. 路由设计

新增 `react-router-dom@^7`，使用 `HashRouter`（与现有 `vite.config.ts` 的 `base: "./"` 兼容，Electron 打包 `file://` 下直接可用）。

`routes.tsx`：

| Path | 元素 | 说明 |
| --- | --- | --- |
| `/` | `<Navigate to="/chat" replace />` | 默认进 Chat |
| `/chat` | `<ChatPage />` | 新对话（activeId 为空时） |
| `/chat/:conversationId` | `<ChatPage />` | 已有对话 |
| `/coding` | `<CodingPage />` | 看板视图 |
| `/coding/:taskId?` | `<CodingPage />` | 看板 + 选中任务（URL 同步，便于深链） |

`ActionBar` 用 `useNavigate()` 跳转；`useLocation()` 决定高亮。
`CodingPage` 把 `selectedId` 同步进 URL（`useParams` + `useNavigate`），刷新页面能恢复选中态。

## 6. Chat 数据模型 & JSONL 持久化

### 6.1 存储位置

主进程 `app.getPath("userData") + "/chats/"`：

```
chats/
├── _index.jsonl        # 元数据：每行一个会话 {id, title, createdAt, updatedAt, model, provider}
└── chat-{id}.jsonl     # 消息：每行一条 {id, role, content, createdAt, model, status}
```

- `_index.jsonl` 用于快速列出所有会话（不读消息文件）。
- `chat-{id}.jsonl` 只追加，新消息 `appendFile` 写一行（崩溃安全）。
- 标题取首条 user 消息前 32 字符；用户编辑后单独存 `title` 字段。
- 删除会话：删 `chat-{id}.jsonl` + 从 `_index.jsonl` 移除对应行（重建文件，简单可靠）。

### 6.2 数据模型

`apps/desktop/src/api.ts` 增补：

```ts
export type ChatMessageRole = "user" | "assistant" | "system";
export type ChatMessageStatus = "streaming" | "done" | "error";

export type ChatMessage = {
  id: string;                       // crypto.randomUUID()
  role: ChatMessageRole;
  content: string;                  // 增量时为累积内容
  createdAt: string;                // ISO
  model?: string;                   // assistant 消息记录使用的模型
  status?: ChatMessageStatus;       // 默认为 done
};

export type ChatConversationMeta = {
  id: string;
  title: string;                    // 首条 user 消息前 32 字 / 用户编辑值
  createdAt: string;
  updatedAt: string;
  model?: string;                   // 当前会话绑定的模型（`<provider>:<value>` 形式）
  provider?: "qoder" | "openai";
  messageCount: number;
};

export type ChatConversation = ChatConversationMeta & {
  messages: ChatMessage[];
};

export type ChatModelInfo = {
  value: string;                    // `qoder:<modelValue>` 或 `openai:<baseUrl>|<model>`
  displayName: string;
  isDefault?: boolean;
  isReasoning?: boolean;
  priceFactor?: number;
};

export type ChatModelGroup = {
  provider: "qoder" | "openai";
  displayName: string;              // "Qoder Agent SDK" / "OpenAI-Compatible"
  models: ChatModelInfo[];
};

// 流式事件
export type ChatEvent =
  | { type: "chat_message_start"; chatId: string; messageId: string; role: "assistant" }
  | { type: "chat_message_delta"; chatId: string; messageId: string; delta: string }
  | { type: "chat_message_done"; chatId: string; messageId: string; content: string; model?: string }
  | { type: "chat_message_error"; chatId: string; messageId: string; error: string };
```

### 6.3 AgentApi 扩展

```ts
// 新增 5 个方法 + 1 个事件订阅
listChats(): Promise<ChatConversationMeta[]>;
getChat(id: string): Promise<ChatConversation | undefined>;
createChat(model?: string): Promise<ChatConversation>;
deleteChat(id: string): Promise<void>;
appendUserMessage(id: string, text: string): Promise<ChatMessage>;  // 同步落盘 + 返回
listChatModels(): Promise<ChatModelGroup[]>;
sendChatMessage(id: string, messageId: string, model: string): Promise<void>;  // 启动流式
abortChat(id: string): Promise<void>;
onChatEvent(cb: (event: ChatEvent) => void): () => void;
```

浏览器 fallback（`window.agentApi` 缺失时）：所有方法在 `apps/desktop/src/api.ts` 中实现为 mock，**只走内存**，不写 JSONL（生产由主进程负责）。

## 7. 模型选择器（按 Provider 分组）

### 7.1 主进程 `chat-models.ts`

```ts
export async function listChatModels(): Promise<ChatModelGroup[]> {
  const groups: ChatModelGroup[] = [];

  // 1. Qoder：如果 enabled + connected + 有模型
  const qoderStatus = await getQoderStatus();
  if (qoderStatus.enabled && qoderStatus.connected && qoderStatus.models.length > 0) {
    groups.push({
      provider: "qoder",
      displayName: "Qoder Agent SDK",
      models: qoderStatus.models.map(m => ({
        value: `qoder:${m.value}`,
        displayName: m.displayName,
        isDefault: m.isDefault,
        isReasoning: m.isReasoning,
        priceFactor: m.priceFactor
      }))
    });
  }

  // 2. OpenAI-Compatible：如果 modelProfile 配置了 company-openai
  const raw = store.getSetting("modelProfile");
  if (raw) {
    try {
      const profile = JSON.parse(raw) as { provider?: string; baseUrl?: string; model?: string };
      if (profile.provider === "company-openai" && profile.baseUrl && profile.model) {
        groups.push({
          provider: "openai",
          displayName: "OpenAI-Compatible",
          models: [{
            value: `openai:${profile.baseUrl}|${profile.model}`,
            displayName: profile.model
          }]
        });
      }
    } catch { /* malformed profile ignored */ }
  }

  return groups;
}
```

只把"已配置且可用"的 provider 加入分组；用户切到不存在的分组时显示空态。

### 7.2 渲染端 `ChatModelSelector.tsx`

- 触发元素：composer 左下角一个 `button`，显示当前模型 `displayName` + `ChevronDown` 图标。
- 弹层（用 `@radix-ui/react-dropdown-menu` 或自写）：分组渲染，每组标题是 `displayName`（Qoder / OpenAI），下面是模型项。
- 选择后写回 `useChat().setModel(value)`，并触发 `sendChatMessage` 时携带。
- 默认值：第一个 enabled 分组的第一个模型（`isDefault` 优先），无任何分组时禁用 composer 并提示「请在设置中配置 LLM」。

## 8. LLM 接入（主进程 `chat-llm.ts`）

新建 `ChatService` 类在 `electron/chat/chat-service.ts`，内部包含：

### 8.1 文件 IO（`chat-storage.ts`）

```ts
ensureChatsDir(): void                                  // mkdirSync
listMetas(): ChatConversationMeta[]                     // 读 _index.jsonl
readConversation(id): ChatMessage[]                     // 读 chat-{id}.jsonl
appendMessage(id, message): Promise<void>               // appendFile
upsertMeta(meta): Promise<void>                         // 重写 _index.jsonl
deleteConversation(id): Promise<void>                   // unlink + 重建 index
```

`upsertMeta` 用"读 → 改 → 写"全量重写 `_index.jsonl`（量小 < 1000 行，简单可靠）；消息文件 append。

### 8.2 LLM 调用

复用现有的 `qoder` 和 `companyOpenAI` 执行器，封装为：

```ts
async function* streamChat(opts: {
  provider: "qoder" | "openai";
  model: string;                       // Qoder 时为 modelValue；OpenAI 时为 "baseUrl|model"
  messages: ChatMessage[];             // 完整上下文
  signal: AbortSignal;
}): AsyncGenerator<{ delta: string }, void, void>;
```

- `provider === "qoder"`：使用 `qoder` 包提供的客户端，**chat-only 模式**（不需要 worktree/任务状态机），把 `messages` 转成 SDK 输入，逐 token yield delta。
- `provider === "openai"`：使用 `OPENAI_API_KEY` 环境变量 + `baseUrl` + `model` 调用 OpenAI-compatible chat completions（流式）。
- 任一调用抛错：service 把 `error` 写入消息文件并 emit `chat_message_error`。
- `abortChat` 通过 `AbortController` 中断流。

> **实现注意**：Qoder SDK 当前的入口（`recordQoderMessage` / `activeQoderQuery`）是为任务流设计的。本次只取 SDK 的纯对话能力（model + prompt → 流式文本），不绑定 worktree。需要在主进程新建独立的 `QoderChatSession` 封装，避免污染现有任务状态机。具体 SDK 用法在实现时确认（参考 `apps/desktop/electron/main.ts` 第 534 行 `sendTaskMessage` 周边代码）。

### 8.3 事件投递

新增 IPC 通道 `chat:event`（主进程 → renderer），service 通过 `mainWindow.webContents.send("chat:event", event)` 推送流式更新。`preload.cts` 暴露 `onChatEvent`。

## 9. 路由切换 → 状态保留

- 切到 `/chat` → `useChat` 调 `listChats` 拉元数据列表，挂载当前路由参数对应的会话消息。
- 切到 `/coding` → 不卸载 `useChat`（AppShell 不重建），仅路由切到 CodingPage；回到 `/chat/:id` 时通过 `useParams` 重新 `select`。
- 切页不丢失 Chat 未保存输入：`useChat` 持 `draftInput: string` 在 ChatPage 卸载/挂载间保留（state 在 AppShell 上提一层；或 ChatPage 内部 useState + useRef 持久化，跨挂载由 React 自身保证）。

## 10. 文件级变更详情

### 10.1 入口（`App.tsx`、`main.tsx`、`routes.tsx`）

```tsx
// App.tsx
export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="*" element={<AppShell />} />
      </Routes>
    </HashRouter>
  );
}
```

```tsx
// AppShell.tsx
export function AppShell() {
  const qoder = useQoderStatus();
  const feedback = useGlobalFeedback();
  return (
    <FeedbackContext.Provider value={feedback}>
      <QoderStatusContext.Provider value={qoder}>
        <main className={`app-shell ${qoder.status?.enabled ? "with-status" : ""}`}>
          <TopBar />
          <div className="app-body">
            <ActionBar />
            <div className={`app-content ${currentAreaClass()}`}>
              <AppRoutes />
            </div>
          </div>
          {qoder.status?.enabled && (
            <StatusBar status={qoder.status} refreshing={qoder.refreshing} onRefresh={qoder.refresh} />
          )}
        </main>
      </QoderStatusContext.Provider>
    </FeedbackContext.Provider>
  );
}
```

`AppRoutes` 内部再放 `<Routes>`，避免 `App.tsx` 持有路由表。

### 10.2 `App.tsx` → `pages/CodingPage/` 拆分要点

整体 1:1 平移，state 与 effect **保持位置与依赖不变**：

| App.tsx 现有位置 | 迁入 |
| --- | --- |
| `useState` 任务相关（tasks / selectedId / detail / liveEvents / prompt / running / search） | `pages/CodingPage/hooks/useTasks.ts` |
| `useState` 新建/Jira 菜单（taskEditor / editingTask / editingDetail / jiraDialog / jiraSyncDialog / jiraCandidates / jiraSyncing / jiraSyncError / newMenu） | `pages/CodingPage/hooks/useNewTaskMenu.ts` |
| `useState` 顶层（settings / settingsTab / uiRequest / feedback / mergeRefreshing） | 提升到 AppShell（settings/uiRequest/feedback）或 CodingPage（mergeRefreshing） |
| `useEffect` 三个（refreshQoderStatus 启动 + 60s 轮询 / refresh + 事件订阅 / selectedId 变化） | 拆到 `useTasks` + `useQoderStatus` |
| `useMemo` filtered / changedFileGroups | `pages/CodingPage/index.tsx`（页面顶层） |
| 所有 Dialogs 组件定义 | 各自 `pages/CodingPage/components/<Name>.tsx` |
| `BoardPanel` / `TaskCardView` / `Timeline` / `QoderStatusBar` | `pages/CodingPage/components/` 下相应文件 / `components/QoderStatusBar.tsx` |
| `formatTokens` / `formatDuration` / `statusLabels` / `changeStatusLabel` / `localizedEventTitle` / `columns` | `utils/format.ts` + `utils/status.ts` |
| `UiRequest` / `TimelineItem` / `TestState` 类型 | `pages/CodingPage/components/` 同文件 / `hooks/useTasks.ts` |

**关键不变量**：所有现有交互（开始处理、终止、提交 MR、刷新 MR、手动结束、Jira 同步、设置入口、UI request 弹层）行为完全保留；useRef（`qoderRefreshInFlight` / `liveMessageId`）保持在 `useTasks` 内。

### 10.3 `pages/ChatPage/`

```
ChatPage/index.tsx:
  const { id } = useParams();
  const chat = useChat(id);                    // chat 会保留在 AppShell 上层，避免卸载丢 state
  useEffect(() => { chat.select(id); }, [id]);
  return (
    <div className="chat-shell">
      <ChatHistoryList ... />
      <div className="chat-main">
        <ChatHeader ... />
        <ChatConversation messages={chat.messages} streaming={chat.streaming} />
        <ChatComposer
          value={chat.draft}
          onChange={chat.setDraft}
          onSend={chat.send}
          disabled={!chat.canSend}
        />
        <ChatModelSelector groups={chat.modelGroups} value={chat.model} onChange={chat.setModel} />
      </div>
    </div>
  );
```

`useChat` 内部：
- 启动时调 `api.listChats()` 拉元数据 + `api.listChatModels()` 拉分组。
- 选中会话时 `api.getChat(id)` 拉消息。
- 发送：`api.appendUserMessage(id, text)` 落盘 → 立即追加到本地 state → `api.sendChatMessage(id, messageId, model)` 启动流。
- 订阅 `api.onChatEvent`：根据 event 类型更新对应 assistant 消息的 `content` / `status`。
- 错误统一用 `useGlobalFeedback()` 写反馈条。

`ChatModelSelector` 单独成组件，便于后续 Coding 页面复用（虽然现在只用 Chat）。

### 10.4 `layout/ActionBar.tsx`

```tsx
import { NavLink } from "react-router-dom";
import { MessageSquareText, Code2 } from "lucide-react";

export function ActionBar() {
  return (
    <nav className="action-bar">
      <NavLink to="/chat" className={({isActive}) => `action-item ${isActive ? "active" : ""}`} title="对话">
        <MessageSquareText size={20} />
      </NavLink>
      <NavLink to="/coding" className={({isActive}) => `action-item ${isActive ? "active" : ""}`} title="编码">
        <Code2 size={20} />
      </NavLink>
    </nav>
  );
}
```

## 11. 样式增量（`styles.css`）

仅追加，不改旧类：

```css
/* 主体布局 */
.app-body { ... }
.app-content { ... }
.app-content.coding { grid-template-columns: ...; }
.app-content.chat   { grid-template-columns: 280px minmax(0,1fr); }

/* ActionBar */
.action-bar { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 0; border-right: 1px solid #242722; background: #151715; }
.action-item { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 6px; color: #8e948a; cursor: pointer; }
.action-item:hover { background: #21241f; color: #d4d8d2; }
.action-item.active { background: #1c2a20; color: #95cf9f; border: 1px solid #405946; }

/* ChatShell */
.chat-shell { display: grid; grid-template-columns: 280px minmax(0,1fr); min-width: 0; min-height: 0; background: #131513; }
.chat-history { display: flex; flex-direction: column; border-right: 1px solid #242722; min-width: 0; }
.chat-history-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #242722; }
.chat-history-header h2 { margin: 0; font-size: 13px; }
.chat-history-list { flex: 1 1 auto; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.chat-history-item { min-height: 56px; display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 5px; cursor: pointer; }
.chat-history-item:hover { background: #1c1f1b; }
.chat-history-item.active { background: #1c2a20; border: 1px solid #405946; }
.chat-history-item-title { font-size: 11px; color: #d9dcd6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-history-item-meta { display: flex; align-items: center; justify-content: space-between; font-size: 9px; color: #6f756c; }
.chat-history-item-delete { opacity: 0; color: #969b92; }
.chat-history-item:hover .chat-history-item-delete { opacity: 1; }
.chat-history-item-delete:hover { color: #e79d96; }
.chat-history-new { margin: 8px 12px 4px; }
.chat-empty-history { padding: 40px 16px; text-align: center; color: #6f756c; font-size: 10px; }

/* Conversation */
.chat-main { display: grid; grid-template-rows: auto minmax(0,1fr) auto; min-width: 0; min-height: 0; }
.chat-header { min-height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 12px 22px; border-bottom: 1px solid #242722; }
.chat-header h3 { margin: 0; font-size: 13px; }
.chat-conversation { padding: 20px 22px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
.chat-empty { min-height: 240px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: #687067; }
.chat-message { display: flex; gap: 10px; }
.chat-message.user { justify-content: flex-end; }
.chat-message .bubble { max-width: 75%; padding: 10px 12px; border-radius: 8px; font-size: 11px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-message.user .bubble { background: #1c2a20; color: #d4d8d2; border: 1px solid #405946; }
.chat-message.assistant .bubble { background: #1d201c; color: #d4d8d2; border: 1px solid #343832; }
.chat-message.error .bubble { background: #271b19; color: #e7a29b; border: 1px solid #633d38; }
.chat-message .avatar { width: 26px; height: 26px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 50%; background: #1d201c; color: #95cf9f; border: 1px solid #405946; }
.chat-message.user .avatar { display: none; }
.chat-cursor { display: inline-block; width: 7px; height: 12px; vertical-align: text-bottom; background: #95cf9f; animation: jira-spin 900ms steps(1) infinite; }

/* Composer */
.chat-composer-wrap { padding: 10px 22px 16px; border-top: 1px solid #242722; display: grid; gap: 8px; }
.chat-composer { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; padding: 10px 12px; border: 1px solid #3c423a; background: #1a1d19; border-radius: 7px; }
.chat-composer:focus-within { border-color: #5d7963; }
.chat-composer textarea { min-height: 38px; max-height: 140px; resize: vertical; border: 0; outline: 0; background: transparent; color: #e5e8e2; font-size: 11px; padding: 4px 0; }
.chat-composer-actions { display: flex; align-items: center; gap: 8px; }
.chat-model-selector { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid #343832; border-radius: 4px; background: #111310; color: #b5bbb1; font-size: 10px; cursor: pointer; }
.chat-model-selector:hover { background: #1a1d19; }
.chat-model-menu { position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 30; min-width: 240px; padding: 4px; border: 1px solid #3b3f38; background: #1b1e1a; box-shadow: 0 12px 32px rgba(0,0,0,.42); border-radius: 5px; }
.chat-model-group-label { padding: 6px 8px 4px; color: #6f756c; font-size: 9px; font-weight: 700; text-transform: uppercase; }
.chat-model-option { min-height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 8px; border-radius: 4px; cursor: pointer; font-size: 10px; color: #d4d8d2; }
.chat-model-option:hover { background: #292d27; }
.chat-model-option.selected { background: #1c2a20; color: #95cf9f; }
.chat-model-option .tag { color: #6f756c; font-size: 8px; }
.chat-composer-send { width: 30px; height: 30px; display: grid; place-items: center; border: 0; background: #dce8d9; color: #172019; border-radius: 4px; cursor: pointer; }
.chat-composer-send:disabled { opacity: .35; cursor: default; }
```

## 12. 依赖变更

`apps/desktop/package.json`：

```json
"dependencies": {
  "react-router-dom": "^7.1.5"
}
```

`HashRouter` 在 Electron 打包后 `file://` 协议下天然可用。

## 13. 关键决策

1. **目录分层**：`components/`（跨页面共享）/ `pages/<page>/{components,hooks,utils}/`（页面级）。`hooks/` `utils/` 顶层只放跨页面用得到的，不强拆。
2. **JSONL 文件拆分**：`_index.jsonl`（元数据 + 列表） + `chat-{id}.jsonl`（消息，append-only）。重写 index 而不是 in-place 修改，简单可靠。
3. **模型选择器在主进程拼装**：`listChatModels()` 直接读 settings + Qoder 状态，渲染端只展示；切换 provider 不用重新连客户端。
4. **不引入 SQLite 表**：JSONL 与现有 TaskStore 解耦，避免 schema 迁移；如未来需要审计/全文检索再迁 db。
5. **Qoder chat 调用走独立 session**：不复用 `activeQoderQuery`（任务态），新起一个 `QoderChatSession`，避免污染任务状态机与 abort 通道。
6. **route → 状态保留**：`useChat` 状态提到 `AppShell` 一层（或由 React Router 自动保留 ChatPage 子树时状态不丢）；切换 `/chat` ↔ `/coding` 不重置对话列表。
7. **顶栏 + 设置入口**全局保留在 `TopBar`，不被页面影响。
8. **Settings / TaskEditor / Jira Dialogs 仍由 `AppShell` 统一挂载**：因为可从顶栏或 CodingPage 触发；放 AppShell 避免跨页面传 props。

## 14. 验证步骤

1. `cd apps/desktop && pnpm typecheck` —— TS 编译通过。
2. `pnpm dev` —— Vite + Electron 启动；默认进入 `/chat` 路由。
3. **Chat 持久化**：
   - 浏览器回退模式（仅 vite）下，因 `window.agentApi` 缺失走 mock：创建新对话 → 发送 → 收到 echo → 切到 `/coding` → 切回 `/chat` 仍能恢复历史（mock 在内存中保留）。
   - Electron 真实模式下：创建对话 → 发送 → 关闭重启 → 历史仍存在（读 `userData/chats/` 下 JSONL）。
4. **模型选择器**：
   - 只配 Qoder → 只显示 Qoder 分组。
   - 配 Qoder + OpenAI-Compatible → 两个分组都显示。
   - 选择不同模型 → 后续 `sendChatMessage` 携带对应 `model` 参数。
5. **ActionBar 路由**：`/chat` ↔ `/coding` 切换流畅；图标高亮随 location 变化。
6. **CodingPage 行为不变**：看板 4 列正常、任务详情 + 操作区 + Jira + 设置 + 终止/重试/刷新 MR 等所有交互与重构前一致。
7. **Qoder 状态栏**：连接/断开指示、刷新按钮、Spin 动画与重构前一致；切页面时由 `QoderStatusContext` 提供，不重复轮询。
8. `pnpm package:dir` —— Electron 打包成功；启动后所有功能（Chat / Coding / 设置 / 状态栏）正常。

## 15. 范围外（明确不做）

- **Chat 工具调用 / MCP**：本次 chat 仅文本对话，不接入文件读写、shell、jira 等工具调用。
- **Chat 跨设备同步**：JSONL 在本地，跨设备需用户手工备份。
- **CSS Modules / styled-components**：保持现有全局 CSS 习惯。
- **多窗口 / 多任务并行 chat**：单窗口单 session 流。
- **Chat 搜索 / 全文检索**：列表只按 `updatedAt` 倒序。
