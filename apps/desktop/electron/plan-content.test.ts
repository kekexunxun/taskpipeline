import { describe, expect, it } from "vitest";
import { parsePlanDecision, sdkResultText } from "./plan-content";

describe("sdkResultText", () => {
  it("preserves structured SDK results as JSON instead of object coercion", () => {
    expect(sdkResultText({ outcome: "changes_required", plan: "1. update width" }))
      .toBe('{"outcome":"changes_required","plan":"1. update width"}');
  });
});

describe("parsePlanDecision", () => {
  it("renders structured plan fields as readable markdown", () => {
    expect(parsePlanDecision([
      JSON.stringify({ outcome: "changes_required", plan: { steps: ["调整宽度", "补充测试"], verification: "检查详情布局" } })
    ])).toEqual({
      outcome: "changes_required",
      content: "## steps\n\n1. 调整宽度\n2. 补充测试\n\n## verification\n\n检查详情布局"
    });
  });
});
