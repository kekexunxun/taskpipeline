# 系统设置新增「MCP」「Skill」Tab — 实施计划

> 状态：**已按本计划实现完成（v1.3，2026-08-13），待用户验收**
> 本文档为唯一计划来源，后续任何计划调整必须同步修改本文档（见文末[变更记录](#变更记录)）。

## 1. 背景与现状（代码调查结论）

### 1.1 设置入口

- 系统设置弹窗 `apps/desktop/src/pages/CodingPage/components/SettingsDialog.tsx`，左侧垂直 `TabsList` 现有 7 个 Tab：通用 / Gitlab / Atlassian / 仓库 / Agent / 记忆 / 模型（L1011-1033）。新增 Tab 即加 `TabsTrigger` + `TabsContent`。
- 设置存储为 **SQLite settings 表**（`packages/core/src/db.ts:64` `settings(key, value)`），密钥走 `LocalFileKeyStore` 加密（`main.ts:179`）；**没有 settings.json，也没有任何 mcp.json**。

### 1.2 MCP 现状

- 三个固定服务 `McpServiceId = 'gitlab' | 'jira' | 'confluence'`（`electron/chat/chat-types.ts:186`，前端 `ChatMcpSelector.tsx:26` 另有一份同名字面量）。
- 配置**三处重复硬编码**：
  1. `electron/chat/mcp-services.ts:22-62` `createMcpServiceResolver`（对话注入主路径：gitlab → `npx -y @zereight/mcp-gitlab`；jira/confluence → `uvx mcp-atlassian`，凭据缺失返回 undefined）；
  2. `packages/integrations/src/jira-mcp.ts:47-64` `AtlassianClientFactory.create()`（任务创建 agent 用，同款 `uvx mcp-atlassian`）；
  3. `main.ts:3119-3130` `testGitlabMcp` 内联重复 gitlab 配置。
- 注入链路（已成熟，无需重造）：UI 勾选 → `useChat.mcpService` → conversation meta `mcpService` 落盘（`chat-service.ts`）→ `StartChatStreamInput.mcpService`（`chat-types.ts:240`）→ driver：
  - **Qoder**：`qoder-chat-driver.ts buildSessionOptions` L327-371 翻译成 SDK `mcpServers[serviceId] = {type:'stdio',command,args,env}` + `allowedMcpServerNames`，会话按 mcpKey 固化（变化则关会话重建）；
  - **OpenAI**：`openai-chat-driver.ts` L409-441 `new McpClient(mcpProfile)` → `listTools()` → ai-sdk `tool` 桥接，连接失败跳过该服务。
- 验证链路已存在：`api.testGitlabMcp` / `api.testAtlassian`（`api.ts:462-464`）→ 主进程 `testGitlabMcp()`（`main.ts:3115-3140`，`McpClient.listTools()` 30s 超时）与 `testAtlassianConnectionRest`（`integrations/src/jira-mcp.ts:86-124`，走 REST 10s）。
- `McpProfileDialog`（`RepositoryDialog.tsx:156-181`）是**未使用的死组件**；`mcpProfiles` 仅出现在 `RepositoryDialog.tsx:169` 一句占位文案。

### 1.3 Skill 现状

- 桌面端（前端 + 主进程）**完全空白**：全仓 grep `skill` 0 匹配，无 `SKILL.md`。
- 但底层引擎已原生支持（详见 §4 调研结论）。

## 2. 已确认决策（用户拍板）

| 决策点                           | 结论                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| MCP 最终配置文件位置             | 应用数据目录 `dataDir/mcp.json`（`~/Library/Application Support/TaskPipeline/data/mcp.json`），应用统一读写 |
| Skill 存储根目录                 | `dataDir/skills`                                                                                            |
| 内置 GitLab/Jira/Confluence 形态 | **只读 + 启用/停用开关**，不允许修改/删除                                                                   |
| Skill 导入方式                   | **文件夹导入 + zip 导入** 都要                                                                              |

## 3. MCP 改动后的注入链路调整（明确说明）

统一为 `dataDir/mcp.json` 后，现有注入链路**不重造**，只换配置源并放宽类型：

### 3.1 配置模型

```jsonc
// dataDir/mcp.json
{
  "version": 1,
  "servers": [
    {
      "id": "gitlab", // 内置固定 id，禁止与自定义重名
      "name": "GitLab MCP",
      "builtin": true, // 内置：不可改/删，仅可改 enabled
      "enabled": true,
      "transport": "stdio", // stdio | sse | streamable-http
      "command": "npx",
      "args": ["-y", "@zereight/mcp-gitlab"],
      "env": {}, // 内置服务 env 不含凭据，运行时由 keyStore 注入
      "description": "…"
    },
    {
      "id": "my-custom",
      "builtin": false,
      "enabled": true,
      "command": "uvx",
      "args": ["mcp-server-x"],
      "env": { "API_KEY": "…" }
    }
  ]
}
```

- **启动合并**：主进程启动时若文件缺失，用现有三处硬编码参数初始化内置 3 项并写入（`builtin: true`）；内置项的参数仅在"无该 id 条目"时按默认值补写，用户未改则不动。
- **凭据安全**：内置服务的 URL/Token 继续走 `store` / `keyStore`（不落 mcp.json 明文），resolver 运行时读取填入 env——与现状一致；**自定义条目**的 env/headers 由用户在弹窗中直接填写，原样存 mcp.json（与 `.mcp.json` 行业惯例一致）。

### 3.2 注入链路逐段调整

| 环节        | 现状                                                                                                  | 调整后                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型        | `McpServiceId = 'gitlab'\|'jira'\|'confluence'`（`chat-types.ts:186`、`ChatMcpSelector.tsx:26` 两份） | 放宽为 `string`；两处同步 + `chat-transport.ts:31`、`StartChatStreamInput.mcpService`（`chat-types.ts:240`）、`ChatConversationMeta.mcpService`（`chat-types.ts:199`）、`useChat.ts` 泛型                   |
| 配置源      | `createMcpServiceResolver(credentials)` 硬编码三服务（`mcp-services.ts`）                             | 改为 `createMcpServiceResolver(loadServers, credentials)`：先读 mcp.json 取 **enabled** 条目（内置 + 自定义），内置仍从 store/keyStore 取 URL/Token 填 env；返回 `(id) => McpProfile \| undefined` 签名不变 |
| Qoder 注入  | `buildSessionOptions` L327-371 按固定 id 翻译 `mcpServers`                                            | 按 id 查表翻译；`mcpKey` 固化逻辑不变；`enabled=false` 的条目即使被选中也不注入（双保险：选择器侧置灰 + driver 侧过滤）                                                                                     |
| OpenAI 注入 | L409-441 `McpClient(mcpProfile)` 桥接工具                                                             | 同左，仅 profile 来源变为 mcp.json                                                                                                                                                                          |
| 测试/验证   | `testGitlabMcp` / `testAtlassian`（`main.ts:3115-3140`、`jira-mcp.ts:86-124`）                        | 统一为通用 `testMcpConnection(id)`：对任意条目 `McpClient.listTools()` 30s 超时，返回工具列表/失败原因；内置三服务保留现有 REST 校验路径作为选项                                                            |
| 选择器      | `ChatMcpSelector` 固定 3 服务多选，无全选                                                             | 列表动态化（`mcp:list`）：内置 3 项（enabled=false 置灰）+ 自定义项；补「全选/全不选」                                                                                                                      |
| 遗留死代码  | `McpProfileDialog`（`RepositoryDialog.tsx:156-181`）                                                  | 删除或复用为新弹窗编辑器基础                                                                                                                                                                                |

### 3.3 明确不动

- `integrations/src/jira-mcp.ts` `AtlassianClientFactory`（任务创建 agent / pi CLI 用）：**本轮不动**，与对话 MCP 是两条独立链路；后续如需统一再单独立项。
- `McpProfile` 类型本身（`packages/core/src/types.ts:178-196`）扩展字段走新建的 `McpServerEntry`，不改底层类型。

## 4. Skill 注入调研结论（OpenAI / Qoder / pi）

> 结论：**OpenAI 侧方案已明确**；**Qoder 侧存在一个必须实测才能定案的待验证项**（见 §4.2）；**pi 侧已明确**。§4.2 实测通过前，Skill 注入不进入编码。

### 4.1 OpenAI driver — 已明确：拼进 system prompt

- ai-sdk **没有本地 skills 概念**（确认）：`streamText` 选项（`node_modules/ai/dist/index.d.ts`）只有 `system`/`instructions`/`tools` 等；provider 层 `SkillsV4` 是"上传 skill 文件给 provider"的 API，与本需求无关。
- SKILL.md 是知识/指导文件而非可调用函数，做成 tool 不自然。
- **方案**：在 `openai-chat-driver.ts` L445-451 现成的 system 拼接数组（`input.cwd` + 历史 system + `taskSource.systemPrompt()`）后追加一段「选中 skill 正文」（仿 pi 的 `<skill name=...>正文</skill>` 内联格式或直接拼接正文）。
- 涉及：`StreamChatInput` 增加 `skills?: string[]` → driver 读 `skill:get-content` 或主进程预解析正文传入。

### 4.2 Qoder driver — ✅ 已完成实测，方案定案（2026-08-13）

**实测环境**：`apps/desktop/qoder-bin/qodercli` v1.1.7（arm64），真实 token 发起对话，临时 config root `/tmp/qoder-skill-test`。

**实测结果一览**：

| #   | 验证项                         | 结果                                                                                                                                      |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 默认技能发现目录               | `~/.qoder/skills/<name>/SKILL.md`（已有真实技能 `naiveui-refactor-helper` 被发现）✅                                                      |
| 2   | 项目级技能                     | `cwd/.qoder/skills` 被发现（`skills list` 列出 proj-skill）✅                                                                             |
| 3   | `--config-dir <dir>`           | **完全切换** user 级技能根：只发现 `<dir>/skills`，`~/.qoder/skills` 不再生效 ✅                                                          |
| 4   | `QODER_CONFIG_DIR` 环境变量    | 与 `--config-dir` 等价（`skills list` 只发现 `<dir>/skills`）✅                                                                           |
| 5   | CLI 对话感知技能               | `--config-dir` 后模型回答能列出 `configdir-skill` ✅                                                                                      |
| 6   | `--allowed-tools Skill(name)`  | 模型真实调用 Skill 工具并读回 SKILL.md 内容 ✅                                                                                            |
| 7   | **SDK query 注入（应用路径）** | `Options.skills: ['configdir-skill']` + `Options.env.QODER_CONFIG_DIR: <dir>` → 模型调用 Skill 工具并返回技能内容（标题/描述/基础目录）✅ |
| 8   | CLI `skills install <zip>`     | 静默失败 `exit=1` 无输出（本地 zip/目录均如此，疑似需登录/网络）——**应用 zip 导入自行实现，不依赖 CLI install**                           |

**定案方案（Qoder 对话注入）**：

```ts
// qoder-chat-driver.ts buildSessionOptions 顶层新增
...(input.skills?.length ? { skills: input.skills } : {}),   // ['<name>'] 按 SKILL.md name 匹配
...(技能根不为 ~/.qoder 时) { env: { QODER_CONFIG_DIR: dataDir } },
```

- 技能文件放 `dataDir/skills/<name>/SKILL.md`；SDK 侧传 `skills: ['<name>']` 映射 `Skill(<name>)` 工具 + CLI 原生 `<available_skills>` 注入；`QODER_CONFIG_DIR=dataDir` 使 CLI 的 user 级技能根 = `dataDir/skills`（实测 3/4/7）。
- ⚠️ **副作用（已评估，可控）**：`QODER_CONFIG_DIR` 切换后 CLI 不再读 `~/.qoder` 的 settings.json / plugins / extensions（IDE 插件如 qoder-create-plugin 等失效）——应用从不依赖这些（认证走 SDK auth payload、MCP 走 `--mcp-config`、会话持久化走应用自己落盘），可接受；若后续需要插件能力再补 `options.plugins`。
- `skills` 未选中时不传（SDK 完全不注入）；与 `mcpServers` 完全兼容（不同配置路径、纯加法合并，SDK 源码确认）。
- 兜底可选：`appendSystemPrompt` 注入技能正文（用 `{preset:'qodercli', append}`，勿用字符串 `systemPrompt` 会替换默认提示）。
- 精细控制：`settings.skillOverrides`（`on | name-only | user-invocable-only | off`）。

SDK 侧（`node_modules/@qoder-ai/qoder-agent-sdk` v1.0.16）源码结论：

- 用户/项目技能发现是 qodercli 的职责（SDK 不做）；CLI 配置目录 `~/.qoder`（`QODER_CONFIG_DIR`/`QODER_CLI_HOME` 可覆盖）。

- `Options.skills?: string[] | 'all'`（`options.d.ts` L104-118）：`string[]` 按 **SKILL.md 的 name/目录名**匹配，每个条目映射 `Skill(<name>)` 加入 `allowedTools`；`'all'` = 启用所有已发现 skill 并加 `Skill` 工具。未传 = 完全不注入，与 `mcpServers` **完全兼容**（不同配置路径、纯加法合并）。
- SDK **自身不做技能文件发现**——发现是 qodercli 的事；CLI 配置目录约定 `~/.qoder`（`QODER_CONFIG_DIR`/`QODER_CLI_HOME` 可覆盖），按 Claude Code 系惯例技能位于 `~/.qoder/skills`、项目 `.qoder/skills`、插件目录。此路径**无法从 SDK 源码证实**（qodercli 是 bun 打包二进制）。
- 三条候选注入途径（实测后保留 1 为主、3 为兜底）：
  1. **`Options.skills: ['<name>']`** + `env.QODER_CONFIG_DIR` 指向 dataDir —— **实测通过（#7），定案**；
  2. `Options.plugins: [{type:'local', path}]`（`options.d.ts` L178 → `--plugin-dir`）—— 需符合 CLI 插件规范，未实测，备用；
  3. **兜底：`appendSystemPrompt` 注入技能正文**（`options.d.ts` L200-204；用 `{preset:'qodercli', append}` 而非字符串 `systemPrompt`，后者会**替换** CLI 默认系统提示）。
- **应用接入点（已定位）**：
  - `chat/drivers/chat-driver.ts` `StreamChatInput` 增加 `skills?: string[]`（建议放 L59 `mcpServices` 旁）；
  - `electron/qoder/qoder-session.ts` `QoderSessionOptions` 增加 `skills`，构造函数 L197（allowedTools 行）后透传；
  - `chat/drivers/qoder-chat-driver.ts` `buildSessionOptions` 返回对象顶层（与 `mcpServers` 同级）加 `...(input.skills?.length ? { skills: input.skills } : {})`，技能根非 `~/.qoder` 时同时注入 `env.QODER_CONFIG_DIR`。

### 4.3 pi-coding-agent（任务板块）— 已明确，⏸ **暂缓，留作后续拓展（本轮不注入）**

**注入性质：配置注入，非自动注入**（代码确认）：

- `loadSkills()`（`dist/core/skills.js` L291）本身支持 `includeDefaults=true` 时自动扫描 `agentDir/skills`（user）与 `cwd/.pi/skills`（project）；
- 但 `DefaultResourceLoader.reload()` 走的是 **`includeDefaults: false`**，技能仅来自 `merge(cliEnabledSkills, enabledSkills, additionalSkillPaths)` —— CLI 显式扩展路径、项目 settings / `.agents/skills` 配置、构造参数 `additionalSkillPaths`（`resource-loader.js` L130 / L284-288 → `updateSkillsFromPaths` L445-466）。**默认目录不会被自动发现**（与 AGENTS.md 的自动逐级查找不同）。
- 对照现状：`main.ts:2217` `new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths })` 未传 `additionalSkillPaths`，且未启用任何 skill 配置 → 任务板块当前**不加载任何技能**。
- 若后续拓展：加 `additionalSkillPaths: [join(dataDir, 'skills')]`（按目录加载）；若需"仅注入选中的 skill"，用 `skillsOverride`（传精确文件路径列表）或自行内联拼接正文。注意 `formatSkillsForPrompt` 只生成 `<available_skills>` 清单（name/description/location），不内嵌正文，模型需 read 工具读取。

### 4.4 三端注入方式汇总（实施依据）

| 引擎          | 方案                                                                                                                | 状态                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| OpenAI driver | 选中 skill 正文拼进 `system`（openai-chat-driver.ts L445-451 追加一段）                                             | ✅ 明确                          |
| Qoder driver  | `Options.skills: ['<name>']` + `env.QODER_CONFIG_DIR=dataDir`（技能根 = dataDir/skills）；兜底 `appendSystemPrompt` | ✅ 实测通过（§4.2）              |
| pi 任务板块   | `DefaultResourceLoader` 加 `additionalSkillPaths: [dataDir/skills]`（可配 `skillsOverride` 精确到选中集）           | ✅ 明确，⏸ **暂缓（后续拓展）** |

## 5. 分阶段实施计划

> **顺序依赖**：阶段 0（Qoder 实测）✅ 已完成（2026-08-13，结果见 §4.2），Qoder 注入方案已定案，后续阶段可自由推进。

### 阶段 0 — Qoder skill 发现实测（前置）✅ 已完成

- [x] 用 `apps/desktop/qoder-bin/qodercli` v1.1.7 实测：技能发现目录（`~/.qoder/skills` + 项目 `.qoder/skills`）、`QODER_CONFIG_DIR`/`--config-dir` 完全切换 user 级技能根、`skills list` 无需认证、CLI `skills install` 静默失败（不依赖）、**SDK `Options.skills` + `env.QODER_CONFIG_DIR` 注入实测通过**。结果已回填 §4.2。

### 阶段 A — MCP 配置模型统一（主进程 + core）

- [ ] `dataDir/mcp.json` 读写模块：读取/合并内置/写入/删除，内置锁定校验（id 冲突、builtin 保护）
- [ ] `createMcpServiceResolver` 改造（读 mcp.json + enabled 过滤 + 内置凭据从 store/keyStore 注入）
- [ ] `McpServiceId` 放宽为 `string`（chat-types.ts / ChatMcpSelector.tsx / chat-transport.ts / useChat.ts / driver 签名）
- [ ] IPC：`mcp:list` / `mcp:save` / `mcp:delete` / `mcp:test(id)`（内置拒绝改/删）；`testGitlabMcp`/`testAtlassian` 收敛为通用 `testMcpConnection`
- [ ] 兼容：旧落盘 conversation 的固定 3 id 不受影响

### 阶段 B — MCP Tab UI

- [ ] SettingsDialog 新增 `MCP` Tab：Collapsible 卡片（标题 + 状态徽标：未配置/初始化中/已连接 N 工具/失败原因 + 命令 + 启停开关）；展开显示工具列表（`mcp:test` 的 listTools 结果）
- [ ] 内置项锁定（只读 + 开关）；自定义项编辑/删除
- [ ] 弹窗编辑器：名称、transport、command/args 或 url、env/headers、description；保存 → 写 mcp.json → 触发初始化
- [ ] 文件位置提示：「配置文件：…/data/mcp.json」

### 阶段 C — Skill 后端（主进程）

- [ ] `dataDir/skills` 管理：IPC `skill:list` / `skill:import-zip` / `skill:import-folder` / `skill:delete`
- [ ] zip 校验：含 `SKILL.md`、frontmatter name `^[a-z0-9-]+$` + description 必填、防 zip slip 路径穿越、重名冲突策略
- [ ] 注入接入：Qoder（§4.2 定案：`skills` 数组 + `env.QODER_CONFIG_DIR=dataDir`）、OpenAI（system 拼接）；**pi 任务板块暂缓**（后续拓展，见 §4.3，本轮不做）

### 阶段 D — Skill Tab UI

- [ ] 卡片网格：名称 + description + 来源徽标（folder/zip）+ 删除；「从文件夹添加」「导入 ZIP」按钮；失败原因展示

### 阶段 E — 对话区选择器

- [ ] `ChatSkillSelector`（仿 ChatMcpSelector）：多选 + 「全选/全不选」+「已选 N 个」；选中值随 conversation 落盘/恢复（meta 新增 `skills?: string[]`）
- [ ] `ChatMcpSelector` 补「全选/全不选」+ 列表动态化
- [ ] 两选择器同步接入 `DetailPanel`（任务详情 Composer）

### 阶段 F — 验证 ✅ 已完成

- [x] 单测：mcp.json 读写/内置合并（mcp-config）、resolver 翻译（driver 测试回归）、zip 校验含 zip slip（skill-store.test.ts 18 用例）、Qoder `skills` 透传（qoder-chat-driver 测试）、OpenAI system 拼接（openai-chat-driver 测试）
- [x] 现有 `qoder-chat-driver.test.ts` / `openai-chat-driver.test.ts` 回归 —— **全量 580 测试通过（50 文件）**
- [x] typecheck：主进程 0 错误；前端仅剩 20 个 ai-elements 存量错误（与本次改动无关）；ESLint 改动文件 0 error
- [ ] 手工验收（待用户）：新增自定义 MCP → 初始化 → 对话勾选 → 真实调用；内置停用后选择器置灰；zip 正常/非法包各一例；Skill 全选生效

## 6. 风险与待确认

1. ✅ ~~Qoder skill 发现目录未证实~~ —— **已实测消除（2026-08-13）**，方案定案：`skills` + `QODER_CONFIG_DIR`。
2. `McpServiceId` 放宽为 `string` 影响面广（前端 + 主进程 + 落盘类型），需同步改；旧数据兼容已验证可行。
3. 自定义 MCP env 明文存 mcp.json（含潜在密钥）—— 与行业惯例一致，UI 加提示即可。
4. 内置服务 uvx/npx 冷启动慢 → 初始化加载态与 30s 超时已有基础（McpClient）。
5. `dataDir/skills` 与 reasonix/pi 原生目录（`~/.pi/agent/skills`、`.pi/skills`）的关系：本计划只在应用自有目录管理，不触碰引擎默认目录。
6. **QODER_CONFIG_DIR 副作用**：切换后 CLI 不再读 `~/.qoder` 的 settings.json/plugins/extensions（IDE 插件失效）——应用不依赖，可接受；如后续需要插件能力，用 `options.plugins` 补。

## 7. 变更记录

| 日期       | 版本 | 变更                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-13 | v1.3 | **按计划完成全部编码**：阶段 A（mcp.json 统一 + resolver + 类型放宽 + 4 个 IPC）、B（MCP Tab：折叠卡片/状态徽标/弹窗编辑/保存后自动初始化）、C（skill-store：文件夹+zip 导入含 zip slip 防护、skill IPC、Qoder/OpenAI 注入接入）、D（Skill Tab）、E（ChatSkillSelector 多选全选、ChatMcpSelector 动态列表+全选、skills 落盘恢复）、F（580 测试全过、typecheck/eslint 通过）。待用户手工验收。 |
| 2026-08-13 | v1.2 | **Qoder 对话注入前置实测完成**（qodercli v1.1.7 + 真实 token）：确认技能发现目录（`~/.qoder/skills`、项目 `.qoder/skills`）、`QODER_CONFIG_DIR`/`--config-dir` 完全切换 user 级技能根、CLI `skills install` 静默失败（不依赖）；**SDK `Options.skills` + `env.QODER_CONFIG_DIR` 注入实测通过**（模型成功调用 Skill 工具读回 SKILL.md）。§4.2 改为定案、阶段 0 完成、§4.4/§6 同步更新。        |
| 2026-08-13 | v1.1 | 确认 pi-coding-agent 技能为**配置注入**（`DefaultResourceLoader.reload()` 走 `includeDefaults: false`，技能仅来自显式路径/配置/`additionalSkillPaths`，默认目录不自动扫描）；按用户要求 **pi 任务板块 skill 注入暂缓**，留作后续拓展（§4.3 / §4.4 / 阶段 C 同步标注）。                                                                                                                       |
| 2026-08-13 | v1   | 初版：完成代码调查，用户确认 4 项决策（dataDir/mcp.json、dataDir/skills、内置只读+开关、文件夹+zip 导入）；明确 MCP 注入链路调整（§3）与三端 Skill 注入调研结论（§4）；Qoder 实测列为前置任务。**尚未开始编码。**                                                                                                                                                                             |
