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
 * 优先取最后一条包含完整 `{...}` JSON 的文本(agent 通常会把结论放在最后)。
 */
export function parseTestCaseGeneration(texts: string[]): TestCaseGenerationResult {
  for (const text of [...texts].reverse()) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as { files?: unknown; commitSha?: unknown; summary?: unknown };
      const files = Array.isArray(value.files) ? value.files.filter((item): item is string => typeof item === "string") : [];
      const summary = typeof value.summary === "string" ? value.summary : "";
      return { files, commitSha: typeof value.commitSha === "string" ? value.commitSha : undefined, summary };
    } catch { /* fallthrough */ }
  }
  return { files: [], summary: "Agent 未返回有效测试用例 JSON" };
}
