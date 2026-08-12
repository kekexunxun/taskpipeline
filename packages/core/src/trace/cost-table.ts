/**
 * 模型单价表 —— 指标预计算时估算 costUsd。
 *
 * 优先级：provider 显式返回的 cost（Qoder result.total_cost_usd / Pi getSessionStats().costUsd）
 * 高于本表估算；本表仅在缺失时兜底，可按 settings 覆盖。
 *
 * 单位：USD / 1K tokens。匹配规则：model 小写前缀/包含匹配，命中第一个即返回。
 */

export type ModelCostEntry = {
  /** model 小写匹配串（含匹配）。 */
  match: string
  inputPer1k: number
  outputPer1k: number
}

// 常见模型近似单价（美元 / 1K tokens）。条目顺序即优先级，长名放前面。
// 数值 = 官方刊例 per 1M 价 ÷ 1000（此前美系/kimi 条目误填 per 1M 原值，估算虚高 1000 倍）。
const COST_TABLE: ModelCostEntry[] = [
  { match: 'gpt-5-nano', inputPer1k: 0.00005, outputPer1k: 0.0004 },
  { match: 'gpt-5-mini', inputPer1k: 0.00025, outputPer1k: 0.002 },
  { match: 'gpt-5', inputPer1k: 0.00125, outputPer1k: 0.01 },
  { match: 'gpt-4o-mini', inputPer1k: 0.00015, outputPer1k: 0.0006 },
  { match: 'gpt-4o', inputPer1k: 0.0025, outputPer1k: 0.01 },
  { match: 'gpt-4.1-mini', inputPer1k: 0.0004, outputPer1k: 0.0016 },
  { match: 'gpt-4.1', inputPer1k: 0.002, outputPer1k: 0.008 },
  { match: 'gpt-4-turbo', inputPer1k: 0.01, outputPer1k: 0.03 },
  { match: 'gpt-4', inputPer1k: 0.03, outputPer1k: 0.06 },
  { match: 'o3-mini', inputPer1k: 0.0011, outputPer1k: 0.0044 },
  { match: 'o1-mini', inputPer1k: 0.003, outputPer1k: 0.012 },
  { match: 'o1', inputPer1k: 0.015, outputPer1k: 0.06 },
  { match: 'deepseek-reasoner', inputPer1k: 0.00055, outputPer1k: 0.00219 },
  { match: 'deepseek-chat', inputPer1k: 0.00027, outputPer1k: 0.0011 },
  { match: 'deepseek-v3', inputPer1k: 0.00027, outputPer1k: 0.0011 },
  // deepseek 通用兜底（v3.1/v3.2 等新形态按 chat 刊例估算）。
  { match: 'deepseek', inputPer1k: 0.00027, outputPer1k: 0.0011 },
  { match: 'claude-opus-4', inputPer1k: 0.015, outputPer1k: 0.075 },
  { match: 'claude-sonnet-4', inputPer1k: 0.003, outputPer1k: 0.015 },
  { match: 'claude-haiku-4', inputPer1k: 0.001, outputPer1k: 0.005 },
  { match: 'claude-3-7-sonnet', inputPer1k: 0.003, outputPer1k: 0.015 },
  { match: 'claude-3-5-sonnet', inputPer1k: 0.003, outputPer1k: 0.015 },
  { match: 'claude-3-5-haiku', inputPer1k: 0.0008, outputPer1k: 0.004 },
  { match: 'claude-3-haiku', inputPer1k: 0.00025, outputPer1k: 0.00125 },
  { match: 'gemini-2.0-flash', inputPer1k: 0.0001, outputPer1k: 0.0004 },
  { match: 'gemini-2.5-pro', inputPer1k: 0.00125, outputPer1k: 0.01 },
  { match: 'gemini-2.5-flash', inputPer1k: 0.0003, outputPer1k: 0.0025 },
  { match: 'gemini-1.5-pro', inputPer1k: 0.00125, outputPer1k: 0.005 },
  { match: 'gemini-1.5-flash', inputPer1k: 0.000075, outputPer1k: 0.0003 },
  { match: 'qwen-max', inputPer1k: 0.0016, outputPer1k: 0.0064 },
  { match: 'qwen-plus', inputPer1k: 0.0004, outputPer1k: 0.0012 },
  { match: 'qwen-turbo', inputPer1k: 0.00005, outputPer1k: 0.0002 },
  { match: 'qwen3', inputPer1k: 0.0004, outputPer1k: 0.0012 },
  { match: 'kimi', inputPer1k: 0.0006, outputPer1k: 0.0025 },
  { match: 'glm-4.5-air', inputPer1k: 0.0002, outputPer1k: 0.0011 },
  { match: 'glm-4.5', inputPer1k: 0.0006, outputPer1k: 0.0022 },
  { match: 'glm-4', inputPer1k: 0.0001, outputPer1k: 0.0001 },
  { match: 'moonshot', inputPer1k: 0.0006, outputPer1k: 0.0025 }
]

/** 可被 settings 覆盖的单价表（key = model 匹配串，value = JSON [inputPer1k, outputPer1k]）。 */
export function overrideCostTable(overrides: Record<string, [number, number]> | undefined): void {
  if (!overrides) return
  for (const [match, [inputPer1k, outputPer1k]] of Object.entries(overrides)) {
    const hit = COST_TABLE.find((entry) => entry.match === match)
    if (hit) {
      hit.inputPer1k = inputPer1k
      hit.outputPer1k = outputPer1k
    } else {
      COST_TABLE.push({ match, inputPer1k, outputPer1k })
    }
  }
}

/** 按 model 查单价条目（小写 contains 匹配、首个命中生效）；无匹配返回 undefined。 */
export function lookupCostRate(model: string | undefined): ModelCostEntry | undefined {
  if (!model) return undefined
  const name = model.toLowerCase()
  return COST_TABLE.find((entry) => name.includes(entry.match))
}

/** 按 model 匹配单价，估算 costUsd；无匹配或 tokens 为 0 时返回 undefined。 */
export function estimateCostUsd(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number
): number | undefined {
  if (inputTokens <= 0 && outputTokens <= 0) return undefined
  const entry = lookupCostRate(model)
  if (!entry) return undefined
  const cost = (inputTokens / 1000) * entry.inputPer1k + (outputTokens / 1000) * entry.outputPer1k
  return Number(cost.toFixed(6))
}
