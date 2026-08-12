# 开发计划：设置状态展示与保存交互优化

> 需求来源：产品反馈（设置页状态展示 / Qoder 错误信息不全 / 保存交互不合理）。
> 状态：**已实施完成**（2025 实施）。验证：desktop 534 用例全过、lint 通过、typecheck 无新增错误（src 侧 20 个既有 ai-elements/\* 错误与本次改动无关）。

## 一、需求与现状对照

| #   | 需求                                                                                                                                                                | 现状代码位置                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 移除 系统设置 → 通用 → Qoder 的连接状态显示                                                                                                                         | `apps/desktop/src/pages/CodingPage/components/SettingsDialog.tsx` L1017-1036「连接状态」块（已连接/未连接 Badge + 档位 + 错误文案），位于 Qoder Token 输入框下方                                                                       |
| 2   | 右上角状态展示中，错误改为**红色方框**强化提示；Qoder 展示**完整错误信息**                                                                                          | `apps/desktop/src/layout/TopBar.tsx` `CredentialStatusPopover`（L59-127）异常项是普通列表样式；主进程 `apps/desktop/electron/main.ts` `probeQoderStatus()` catch（L2876-2884）只取 `error.message`，丢弃 `QoderCliProcessError.stderr` |
| 3   | 移除「没什么用」的底部全局保存按钮；只有 Qoder / GitLab / Jira / Confluence 四个 Token 需要显式保存，**其余设置实时更新**；设置弹窗右上角加关闭按钮、禁止点遮罩关闭 | `SettingsDialog.tsx` L1510-1520 底部 DialogFooter「保存设置」一次性保存全部字段；L965 `hideClose` 隐藏右上角 X；Dialog 默认点遮罩即关                                                                                                  |

## 二、改动方案

### 需求 1：移除通用 Tab 的 Qoder 状态显示

**文件**：`apps/desktop/src/pages/CodingPage/components/SettingsDialog.tsx`

- 删除 L1017-1036 的 `{qoder && (...)}` 连接状态块（ServerIcon / 连接 Badge / 档位 / 错误文案），**保留 Qoder Token 输入框及 Section**。
- 清理块内独有、他处未用的 import（`ServerIcon`；`AlertCircleIcon` / `Badge` 需确认他处使用后再删）。
- `qoder` prop 保留：模型 Tab L1417 仍用 `qoder.models`；`onQoderRefresh` 保留：Qoder Token 保存后仍触发状态刷新。

### 需求 2：右上角状态展示 → 红色异常方框 + Qoder 完整错误

交互保持现状（右上角圆点按钮 + Popover）不变，只做两处改造。

**A. 前端样式** — `apps/desktop/src/layout/TopBar.tsx`（`CredentialStatusPopover`）

- 存在 failed 项时，异常项**集中渲染为一个红色方框容器**：
  - 容器：`rounded-md border border-destructive/40 bg-destructive/10 p-2`（destructive 色系）；
  - 方框内逐项：⚠ 图标 + 名称（Qoder Token / GitLab Token / …）+ **完整错误 message**（`break-words`、不截断、多行）+ **操作按钮**（「前往设置」跳对应 Tab，复用现有 `onOpenCredentialSettings`；「重新检查」）；
- 无异常/未配置时保持现有列表或绿色「全部通过」摘要；
- 底部「重新检查」按钮保留（置于方框内或紧邻方框下方）。

**B. 主进程 Qoder 错误信息补全（核心）** — `apps/desktop/electron/main.ts`

- 现状根因：qodercli 进程非 0 退出（常见 exit 42）时 SDK 抛 `QoderCliProcessError`，**真正原因在其 `.stderr` 尾部**；`probeQoderStatus()` 的 catch 只用 `error.message`，把 stderr 丢了 → 前端「错误信息不全、不好判断」。
- 改动：catch 中做 stderr 增强，与 `electron/task-agent/qoder-task-agent.ts` L582-587、`qoder-plan-mode.ts` L114-119 同款写法：
  `error.message + '\n\nqodercli stderr (tail):\n' + error.stderr.trim().slice(-2000)`，写入 `status.error`。
- 效果：`QoderStatus.error` 与凭据状态 message 携带完整 stderr，前端方框直接可见真正原因。
- 可选重构：把增强逻辑抽为公共函数（新文件 `apps/desktop/electron/qoder/qoder-errors.ts`），三处复用；**默认只改 probe，改动最小**。

### 需求 3：保存交互重构 + 弹窗关闭行为

**文件**：`apps/desktop/src/pages/CodingPage/components/SettingsDialog.tsx`

原则：**四个 Token 显式保存，其余设置实时更新**。

1. **普通设置实时化**（不再依赖任何保存按钮）：
   - 任务自动化开关（`openCodeReviewEnabled` / `createTestCasesEnabled` / `autoCreateMergeRequests` / `deliveryConfirm` / `reviewAutoFix`）与轮数输入（`reviewAutoFixMaxRounds`）：变更时立即 `api.setSetting(key, value)` 落盘，失败 `showError`；
   - URL 输入（`gitlabUrl` / `jiraUrl` / `confluenceUrl`）：`onBlur` 时落盘（避免半截输入），失败 `showError`。
2. **Token 保存按钮**：
   - 移除 DialogFooter 底部全局「保存设置」（L1516-1519），底部只留「关闭」；
   - 通用 Tab **Qoder Token 下方**新增「保存」→ 写 `qoderToken`（非空且非 `__configured__` 时）+ `onQoderRefresh?.()`（Qoder 状态刷新）+ `onSaved?.()`（凭据重检）；
   - GitLab Tab **GitLab Token 下方**新增「保存」→ 写 `gitlabToken` + `onSaved?.()`；
   - Atlassian Tab **Jira Token / Confluence Token 各自下方**新增「保存」→ 写 `jiraToken` / `confluenceToken` + `onSaved?.()`；
   - 实现：把原 `save()` 收敛为 `saveKeys(keys, { refreshQoder?: boolean })` 小工具，四个按钮各自调用。
3. **弹窗关闭行为**：
   - L965 移除 `hideClose` → 复用 `dialog.tsx` L45 已有 X，右上角出现关闭按钮；
   - `<DialogContent>` 上加 `onPointerDownOutside={(e) => e.preventDefault()}` 阻止点击遮罩关闭（Radix 标准方式）；Escape 键关闭保留（未要求禁）。

> 备注：`modelApiKey` 由 OpenAI-Compatible 弹窗单独维护，无通用 Tab 入口，不受本次改动影响；`defaultModel` 在 UI 无编辑控件，无需处理。

## 三、涉及文件清单

| 文件                                                              | 需求  | 改动                                                                                             |
| ----------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `apps/desktop/src/pages/CodingPage/components/SettingsDialog.tsx` | 1 + 3 | 删 Qoder 状态块；普通设置实时保存；四 Token 下方各加保存按钮；底部按钮移除；右上角 X；禁遮罩关闭 |
| `apps/desktop/src/layout/TopBar.tsx`                              | 2     | `CredentialStatusPopover` 异常项改红色方框 + 完整错误展示                                        |
| `apps/desktop/electron/main.ts`                                   | 2     | `probeQoderStatus` catch 增加 `QoderCliProcessError.stderr` 增强                                 |
| （可选）`apps/desktop/electron/qoder/qoder-errors.ts`             | 2     | 抽公共 stderr 增强函数，三处复用                                                                 |

## 四、实施顺序

1. 需求 1（SettingsDialog 删状态块，纯删减，独立可交付）；
2. 需求 3（保存交互重构 + 弹窗关闭，改动集中在一个文件）；
3. 需求 2（主进程 stderr 增强 → 前端红色方框，依赖 2B 先落地才能验证错误信息完整度）。

## 五、验证方案

- 类型/静态检查：`npm run typecheck -w @task-pipeline/desktop`、`npm run lint -w @task-pipeline/desktop`
- 回归：根 `npm test`（TopBar/SettingsDialog 无专项测试，跑全量确认无回归）
- 手动验证（`npm run dev`）：
  1. 通用 Tab 不再显示 Qoder 连接状态块，Token 输入框保留；
  2. 填入错误 Qoder Token → 右上角圆点变红 → 打开状态面板 → 错误以红色方框展示，且含完整 `qodercli stderr (tail)`；
  3. 任务自动化开关/URL 修改即实时生效（重启应用后保持）；四 Token 各自下方有「保存」按钮；底部不再有全局保存按钮；
  4. 设置弹窗右上角有 X 可关闭，点击遮罩不关闭。

## 六、风险与注意事项

- **错误文本长度**：stderr 增强后 Qoder 错误可达 2KB+，方框内需 `break-words` + 行高上限保护，避免面板被撑爆。
- **实时保存是行为变化**：URL 用 `onBlur` 防半截输入；开关即时写 store（本地 settings 存储，写入频率低无性能风险）。
- **保存入口分散**：移除底部全局按钮后，四个 Token 各自独立保存；若后续新增需落盘的字段，需显式接入「实时保存」或「Token 式保存按钮」二选一。
- `hideClose` 组件能力保留（`model-selector.tsx`、`AgentAIGenerateDialog.tsx` 仍在使用），本次只改 SettingsDialog 实例。
