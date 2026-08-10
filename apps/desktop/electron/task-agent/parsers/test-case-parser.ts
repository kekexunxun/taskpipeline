/**
 * Test case generation 结果 JSON 解析 — 从 `main.ts` 迁出。
 */

export type TestCaseGenerationResult = {
  files: string[];
  commitSha?: string;
  summary: string;
};

/**
 * 从 driver 流出来的 responseTexts 解析测试用例生成结果。
 * 先把流式增量片段按顺序拼成完整文本再提取 JSON(兼容消息粒度与 delta 碎片粒度,
 * JSON 可能横跨多条碎片,逐条找会漏判,回退成"Agent 未返回有效测试用例 JSON")。
 */
export function parseTestCaseGeneration(texts: string[]): TestCaseGenerationResult {
  const full = texts.join("");
  const start = full.indexOf("{");
  const end = full.lastIndexOf("}");
  let value: { files?: unknown; commitSha?: unknown; summary?: unknown } | undefined;
  if (start >= 0 && end > start) {
    try {
      value = JSON.parse(full.slice(start, end + 1));
    } catch {
      // 模型常见瑕疵:尾逗号。修复后重试。
      try {
        value = JSON.parse(full.replace(/,\s*([}\]])/g, "$1").slice(start, end + 1));
      } catch { /* fallthrough */ }
    }
  }
  if (value) {
    const files = Array.isArray(value.files) ? value.files.filter((item): item is string => typeof item === "string") : [];
    const summary = typeof value.summary === "string" ? value.summary : "";
    return { files, commitSha: typeof value.commitSha === "string" ? value.commitSha : undefined, summary };
  }
  return { files: [], summary: "Agent 未返回有效测试用例 JSON" };
}
