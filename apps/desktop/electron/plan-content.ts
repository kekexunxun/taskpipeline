export type PlanDecision = { outcome: "changes_required" | "already_satisfied"; content: string };

export function sdkResultText(result: unknown, errors?: unknown): string | undefined {
  if (result == null) {
    return Array.isArray(errors) ? errors.map(String).join("\n") || undefined : undefined;
  }
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function structuredContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const content = structuredContent(item);
      return content ? `${index + 1}. ${content}` : "";
    }).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return String(value);

  const record = value as Record<string, unknown>;
  for (const key of ["markdown", "text", "content"]) {
    const preferred = structuredContent(record[key]);
    if (preferred) return preferred;
  }
  return Object.entries(record).map(([key, item]) => {
    const content = structuredContent(item);
    return content ? `## ${key.replace(/_/g, " ")}\n\n${content}` : "";
  }).filter(Boolean).join("\n\n");
}

/**
 * 从回复文本中尽量提取可解析的 JSON:
 * 1. 依次尝试每个 `{` 起始位置到最后一个 `}` 的切片(模型可能在 JSON 前/后夹带解释或其它 `{}` 块);
 * 2. 修复常见模型瑕疵(尾逗号)后重试;
 * 3. 都失败返回 undefined。
 */
function tryParseJson(text: string): unknown {
  const candidates: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue
    const end = text.lastIndexOf("}")
    if (end > i) candidates.push(text.slice(i, end + 1))
  }
  const fixed = text.replace(/,\s*([}\]])/g, "$1")
  if (fixed !== text) {
    for (let i = 0; i < fixed.length; i++) {
      if (fixed[i] !== "{") continue
      const end = fixed.lastIndexOf("}")
      if (end > i) candidates.push(fixed.slice(i, end + 1))
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch { /* try next */ }
  }
  return undefined
}

/** JSON 解析失败时的展示兜底:从原文宽松提取 `"plan"` 字段的正文(字符串或对象原始文本)。 */
function extractPlanTextFromRaw(full: string): string | undefined {
  const planMatch = full.match(/"plan"\s*:\s*(?:"((?:\\.|[^"\\])*)"|(\{[\s\S]*\}))/)
  if (!planMatch) return undefined
  if (planMatch[1] !== undefined) {
    try {
      return JSON.parse(`"${planMatch[1]}"`) as string
    } catch {
      return planMatch[1]
    }
  }
  const rawObject = planMatch[2]
  if (!rawObject) return undefined
  const lines: string[] = []
  for (const entry of rawObject.matchAll(/"([^"]+)"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
    const raw = entry[2]
    if (raw === undefined) continue
    let value = raw
    try {
      value = JSON.parse(raw) as string
    } catch { /* keep raw */ }
    lines.push(`## ${entry[1]}\n\n${value}`)
  }
  return lines.length > 0 ? lines.join("\n\n") : undefined
}

export function parsePlanDecision(texts: string[]): PlanDecision {
  // 先把流式增量片段按顺序拼成完整文本再解析:
  // responseTexts 可能是"消息粒度"(一条完整回复)或"delta 碎片粒度"(流式每个 text 增量一条),
  // 逐条找 JSON 在碎片粒度下会失效(JSON 横跨多条碎片),导致把原始 JSON 当计划内容存库。
  const full = texts.join("");
  const parsed = tryParseJson(full);
  if (parsed && typeof parsed === "object") {
    const value = parsed as { outcome?: string; plan?: unknown; summary?: unknown };
    if (["changes_required", "already_satisfied"].includes(value.outcome ?? "")) {
      const content = structuredContent(value.plan ?? value.summary);
      if (content) return { outcome: value.outcome as PlanDecision["outcome"], content };
    }
  }
  // JSON 解析失败(模型输出瑕疵):尽量展示 `plan` 字段正文,而不是整段原文/JSON 噪音。
  const rawPlan = extractPlanTextFromRaw(full);
  if (rawPlan) {
    const outcome = /"outcome"\s*:\s*"already_satisfied"/.test(full) ? "already_satisfied" : "changes_required";
    return { outcome, content: rawPlan };
  }
  const content = full.trim() || ([...texts].sort((a, b) => b.length - a.length)[0]?.trim() ?? "");
  if (!content) throw new Error("Agent 未返回有效计划");
  const alreadySatisfied = /(?:结论\s*[:：]?\s*)?(?:该任务|当前代码|代码)?(?:已经|已)(?:完成|满足)|无需(?:任何)?(?:代码)?修改|无需改动|already satisfied|no (?:code )?changes? (?:are )?required/i.test(content);
  return { outcome: alreadySatisfied ? "already_satisfied" : "changes_required", content };
}
