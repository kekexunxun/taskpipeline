# Memory 系统接入与设置管理

## 摘要

1. 应用上一轮已设计但**尚未落地**的 SQLite+FTS5 三层记忆（仓库级 / 用户级 / 对话级）+ repowiki 文档索引改动。
2. 新增仓库时自动检测该仓库是否含 repowiki 目录并建索引；每次应用启动时对所有已配置仓库自动检测/刷新索引。
3. 在"系统设置"中新增「记忆」页签，支持查看、新增、编辑（修正）、删除记忆，以及查看/重建各仓库 repowiki 索引。

## 现状分析（Phase 1 探索结论）

- 上一轮的 5 个 diff（types.ts / index.ts / chat-service.ts / main.ts / api.ts）与 3 个新文件（`packages/core/src/memory.ts`、`electron/repowiki/indexer.ts`、`electron/memory/memory-service.ts`）**均未应用**：
  - `main.ts` 中无 `memoryService` / `memory:*` IPC（Grep 无匹配）。
  - `packages/core/src/memory.ts`、`electron/memory/`、`electron/repowiki/` 均不存在。
- 关键挂载点（已确认）：
  - [main.ts](file:///Users/robin/Documents/codingagent/apps/desktop/electron/main.ts#L1257) `ipcMain.handle("repos:save", ...)` 当前为同步保存；`RepositoryDialog.save()` 在保存前已生成 `profile.id`（`draft.id ?? crypto.randomUUID()`），故 save handler 可直接拿到 `profile.id + localPath`。
  - [main.ts](file:///Users/robin/Documents/codingagent/apps/desktop/electron/main.ts#L1346) `app.whenReady().then(...)` 为启动入口。
  - [SettingsDialog.tsx](file:///Users/robin/Documents/codingagent/apps/desktop/src/pages/CodingPage/components/SettingsDialog.tsx) 使用 vertical Tabs（general / atlassian / repositories / model），`load()` 统一拉取数据，仓库段已有增删改与 `showError/showSuccess` 反馈模式；可用 `Textarea`、`Select`、`Switch`、`AlertDialog` 等 UI 组件。
  - [api.ts](file:///Users/robin/Documents/codingagent/apps/desktop/src/api.ts) 的 `AgentApi` + 浏览器回退 mock 是渲染层唯一 IPC 出口。
  - core 使用 better-sqlite3（预编译含 FTS5），`tsconfig.base.json` 无 `verbatimModuleSyntax`，`import Database from "better-sqlite3"` 可仅作类型用。

## 变更清单

### 第 1 步：应用上一轮设计（先落地基础设施）

| 文件 | 操作 | 内容 |
| --- | --- | --- |
| `packages/core/src/types.ts` | 修改 | 追加 `MemoryScope / MemorySource / Memory / RepoWikiDoc / MemorySearchHit / RepoWikiSearchHit` 类型 |
| `packages/core/src/memory.ts` | 新建 | `MemoryStore`：复用 TaskStore 同一 SQLite 连接，建 `memories` / `repo_wiki_docs` 表 + FTS5（external content + 触发器同步），提供 CRUD 与 bm25 检索 |
| `packages/core/src/index.ts` | 修改 | 追加 `export * from "./memory.js"` |
| `apps/desktop/electron/repowiki/indexer.ts` | 新建 | 扫描 `repowiki/` `.repowiki/` `.qoder/repowiki/` `docs/repowiki/` 下 `.md/.mdx/.txt`，输出 `WikiFile{path,title,content,mtime,hash}`；按 hash 做增量依据 |
| `apps/desktop/electron/memory/memory-service.ts` | 新建 | `MemoryService`：ensureUserId（settings `memoryUserId`）、三层聚合检索 `search()`、repowiki 增量索引 `refreshRepoWiki()`、`buildSystemPrompt()`（4000 字符上限） |
| `apps/desktop/electron/main.ts` | 修改 | 导入并实例化 `MemoryService`；ChatService 注入记忆 provider；`runQoder` prompt 注入 repo 记忆+repowiki 文档；新增 `memory:list/upsert/update/delete/search`、`repowiki:index/list/search` IPC |
| `apps/desktop/electron/chat/chat-service.ts` | 修改 | 构造器追加可选 `memoryContext?: MemoryContextProvider`；`startChatStream` 在调模型前临时 prepend 一条 system 记忆消息（不落盘） |
| `apps/desktop/src/api.ts` | 修改 | 导入 core 记忆类型；新增 Memory API 类型（`MemoryInput/MemoryListFilter/MemorySearchOptions/MemorySearchResult/RepoWikiIndexResult`）+ AgentApi 方法 + 浏览器回退 mock |

### 第 2 步：repowiki 自动检测与索引

1. [main.ts](file:///Users/robin/Documents/codingagent/apps/desktop/electron/main.ts#L1257) `repos:save` 改为 async：
   ```ts
   ipcMain.handle("repos:save", async (_event, profile) => {
     store.saveRepositoryProfile(profile);
     try { await memoryService.refreshRepoWiki(profile.id, profile.localPath); }
     catch (error) { console.warn("[repowiki] index failed:", error); }
   });
   ```
   覆盖"新增仓库"与"编辑仓库（路径变更）"两种情况；失败不阻断保存。
2. [main.ts](file:///Users/robin/Documents/codingagent/apps/desktop/electron/main.ts#L1346) `app.whenReady().then(...)` 内、`registerIpc()` 之后：
   ```ts
   for (const repo of store.listRepositoryProfiles()) {
     void memoryService.refreshRepoWiki(repo.id, repo.localPath).catch((error) => console.warn("[repowiki] startup index failed:", error));
   }
   ```
   异步非阻塞；`refreshRepoWiki` 按 hash 跳过未变更文档，启动开销小。

### 第 3 步：系统设置新增「记忆」页签

1. `apps/desktop/src/pages/CodingPage/components/SettingsDialog.tsx`：
   - `TabsList` 追加 `<TabsTrigger value="memory">记忆</TabsTrigger>`。
   - 新增 `TabsContent value="memory"`，含两个 Section：
     - **记忆管理**：`load()` 中追加 `api.listMemories({ scopes: ["user", "repo"] })` 存入 state；列表卡片复用 RepositoryCard 风格（scope Badge + 标题 + 内容截断预览 + pinned 标记 + 编辑/删除 icon 按钮）；「新增记忆」按钮；删除走 AlertDialog 确认；编辑/新增弹 `MemoryDialog`。
     - **仓库 Wiki（repowiki）索引**：`load()` 中为每个仓库 `api.listRepoWikiDocs(repositoryId)` 取文档数展示；每行「重建索引」按钮调 `api.indexRepoWiki(repositoryId)`，成功后刷新该仓库文档数并 `showSuccess`。
2. 新建 `apps/desktop/src/pages/CodingPage/components/MemoryDialog.tsx`（仿 RepositoryDialog 模式）：
   - 字段：scope（Select：用户 / 仓库）、scope=仓库 时 repository（Select，选项来自父级 `repositories`）、title（Input）、content（Textarea）、tags（逗号分隔 Input）、pinned（Switch）。
   - 保存：新增走 `api.upsertMemory`，编辑走 `api.updateMemory`（或统一 `api.upsertMemory` 携带 id），成功后 `onSaved()` 回调刷新列表。
3. `packages/core/src/memory.ts`：`listMemories` 增加可选 `scopes?: MemoryScope[]` 过滤（`scope IN (...)` 子句），供设置页只拉 user/repo。
4. `apps/desktop/src/api.ts`：`MemoryListFilter` 增加 `scopes?: MemoryScope[]`；mock 方法（`listMemories` 返回 `[]` 等）沿用第 1 步设计。

## 假设与决策

- 设置页仅展示 **user / repo** 两级记忆；conversation 记忆属会话内短期数据，不进设置列表。
- 提供「新增记忆」按钮——当前无自动抽取来源，手工沉淀是唯一入口（可后续迭代自动抽取时关闭）。
- scope=repo 的记忆必须选择所属仓库（下拉来自已配置仓库列表），避免跨仓库语义不清。
- 对话级记忆沿用上一轮设计：Chat 注入 `conversationId=chat:<id>`，任务执行注入 `conversationId=task:<taskId>`；本轮不做自动记忆抽取（从对话/任务完成提炼），留待后续。
- repowiki 兼容目录约定：`repowiki/`、`.repowiki/`、`.qoder/repowiki/`、`docs/repowiki/`。

## 验证

1. `npm run build -w @coding-agent/core`（core 编译通过，FTS5 DDL 正常）。
2. 根目录 `npm run typecheck`（全部包类型检查通过）。
3. `npm run test -w @coding-agent/core`（既有测试无回归）。
4. `npm run dev` 手动验证：
   - 新增一个含 `repowiki/*.md` 的仓库 → 记忆页签该仓库显示文档数 > 0。
   - 重启应用 → 启动自动检测；日志无报错；再次重启文档数不变（hash 跳过）。
   - 设置-记忆：新增（用户级/仓库级各一条）→ 编辑修正内容 → 删除；重建索引按钮生效。
