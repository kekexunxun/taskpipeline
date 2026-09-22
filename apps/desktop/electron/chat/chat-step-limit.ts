/**
 * Chat 每轮步数治理的共享常量（两条 driver 统一口径）。
 *
 * 背景：agentic 循环每一轮都有硬步数上限（1 step = 1 次模型往返）。此前 OpenAI 路径
 * 用 `MAX_CHAT_STEPS`、Qoder 路径却各自硬编码（Qoder chat 的 `maxTurns: 10`），
 * 导致复杂「实现类」问答在 Qoder 侧被静默掐断在 10 步（末步停在工具上、无收尾文本）。
 * 这里做单一数据源，两条链路都引用它，避免再次漂移。
 *
 * 注：步数「口径同源」指语义一致（1 回合 = 1 次模型往返），不代表数值必须相等——Qoder 走常驻
 * 会话、多给回合的成本远低于 OpenAI 全量重发，故任务 chat 的回合预算单列（见 `MAX_QODER_CHAT_TURNS`）。
 */

/**
 * 每轮 agentic 循环的硬步数上限。OpenAI 走 `stepCountIs`，Qoder 走 SDK `maxTurns`
 * （二者语义一致：一次 LLM 生成步 = 一个含 tool_call 的往返）。
 */
export const MAX_CHAT_STEPS = 15

/**
 * 撞到步数上限、本轮被截断时补给用户的可见提示（Qoder 路径：SDK 发
 * `result.subtype === 'error_max_turns'`，此前静默收尾，界面表现为「没说完就停了」）。
 * 作为 text part 落盘，历史回放同样可见。
 */
export const STEP_LIMIT_NOTICE =
  '⚠️ 已达到单轮步数上限，本轮回复被中断。如果任务尚未完成，请回复「继续」，我会接着上一步往下做。'

/**
 * Qoder 任务 chat 的每轮 SDK 回合上限（`maxTurns`），比 OpenAI 的 `MAX_CHAT_STEPS` 更宽。
 *
 * 为什么与 OpenAI 口径分叉：实证 trace（chat-7a69530f）里真·编码回合是 read→edit→read 串行
 * 推进，正当需要 >15 个往返（观测到两回合各 16 步被硬切），而 OpenAI 每步全量重发历史、抬预算
 * 会近线性涨成本；Qoder 走常驻会话、SDK 自管上下文（任务链路另有 autoCompact），多给回合的成本
 * 远低于 OpenAI。故给任务 chat 单列一个更宽的预算。仍撞线时不直接甩提示，见 `MAX_QODER_AUTO_CONTINUES`。
 */
export const MAX_QODER_CHAT_TURNS = 25

/**
 * Qoder 撞 `error_max_turns` 后，在同一常驻会话里自动补推「继续」的最大次数（每次续跑重新给满
 * `MAX_QODER_CHAT_TURNS`）。真编码任务常需远超单轮预算，此前直接把「请回复继续」甩给用户手动敲
 * （trace 标题「继续」即其佐证）；改为有界自动续跑，等价于替用户自动点几次「继续」。预算用尽仍
 * 不收敛才降级到 `STEP_LIMIT_NOTICE`。有界是为兜住真·死循环：不给无限 credit 烧下去的口子。
 */
export const MAX_QODER_AUTO_CONTINUES = 2

/**
 * 自动续跑时注入的内部用户消息（只进 SDK 会话上下文、不落 chat 历史、UI 不可见为独立回合，
 * 输出接续同一条 assistant 答案）。措辞强调「自主推进做完」而非「停下等确认」，与真编码任务诉求一致。
 */
export const QODER_AUTO_CONTINUE_PROMPT =
  '请从中断处继续完成尚未做完的步骤，保持自主推进、不要中途停下等确认；若所有工作确已完成，请给出简洁的收尾总结。'
