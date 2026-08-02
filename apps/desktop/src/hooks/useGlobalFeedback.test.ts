import { describe, expect, it } from "vitest";
import { normalizeFeedbackMessage } from "./useGlobalFeedback";

describe("normalizeFeedbackMessage", () => {
  it("removes Electron IPC error prefixes", () => {
    expect(
      normalizeFeedbackMessage(
        "Error invoking remote method 'tasks:manual-complete': Error: 当前状态不支持手动完成"
      )
    ).toBe("当前状态不支持手动完成");
  });

  it("keeps ordinary application errors readable", () => {
    expect(normalizeFeedbackMessage("任务执行失败")).toBe("任务执行失败");
  });
});
