/**
 * Chat 每轮步数治理的共享常量（两条 driver 统一口径）。
 *
 * 背景：agentic 循环每一轮都有硬步数上限（1 step = 1 次模型往返）。此前 OpenAI 路径
 * 用 `MAX_CHAT_STEPS`、Qoder 路径却各自硬编码（Qoder chat 的 `maxTurns: 10`），
 * 导致复杂「实现类」问答在 Qoder 侧被静默掐断在 10 步（末步停在工具上、无收尾文本）。
 * 这里做单一数据源，两条链路都引用它，避免再次漂移。
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
