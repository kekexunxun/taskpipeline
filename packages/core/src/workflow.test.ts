import { describe, expect, it } from "vitest";
import { boardColumnFor } from "./types.js";
import { transitionTask } from "./workflow.js";

describe("task workflow", () => {
  it("allows the normal delivery path", () => {
    expect(() => transitionTask("draft", "confirmed")).not.toThrow();
    expect(() => transitionTask("reviewing", "awaiting_commit")).not.toThrow();
    expect(() => transitionTask("awaiting_review", "awaiting_commit")).not.toThrow();
  });
  it("supports planning and validation gates without adding a board lane", () => {
    expect(() => transitionTask("preparing", "planning")).not.toThrow();
    expect(() => transitionTask("planning", "awaiting_plan_approval")).not.toThrow();
    expect(() => transitionTask("planning", "completed")).not.toThrow();
    expect(() => transitionTask("awaiting_plan_approval", "implementing")).not.toThrow();
    expect(() => transitionTask("implementing", "validating")).not.toThrow();
    expect(() => transitionTask("validating", "validation_failed")).not.toThrow();
    expect(() => transitionTask("validation_failed", "validating")).not.toThrow();
    expect(boardColumnFor("planning")).toBe("in_progress");
    expect(boardColumnFor("awaiting_plan_approval")).toBe("in_progress");
    expect(boardColumnFor("validating")).toBe("in_progress");
  });
  it("rejects skipping a human gate", () => {
    expect(() => transitionTask("implementing", "completed")).toThrow();
  });
  it("maps internal states to the four workflow lanes", () => {
    expect(boardColumnFor("draft")).toBe("todo");
    expect(boardColumnFor("implementing")).toBe("in_progress");
    expect(boardColumnFor("await_merge")).toBe("in_review");
    expect(boardColumnFor("completed")).toBe("done");
  });
  it("keeps post-implementation states in in_review, only failed lands in in_progress", () => {
    // 提交 MR 失败 (delivering -> awaiting_commit) 必须落回 in_review,
    // 否则会被当成"实现失败"误导用户。failed 留给真正的实现失败。
    expect(boardColumnFor("awaiting_commit")).toBe("in_review");
    expect(boardColumnFor("delivering")).toBe("in_review");
    expect(boardColumnFor("review_blocked")).toBe("in_review");
    expect(boardColumnFor("failed")).toBe("in_progress");
  });
  it("waits for merge before completion", () => {
    expect(() => transitionTask("delivering", "await_merge")).not.toThrow();
    expect(() => transitionTask("await_merge", "completed")).not.toThrow();
  });
  it("allows a blocked review to be run again", () => {
    expect(() => transitionTask("review_blocked", "reviewing")).not.toThrow();
  });
  it("allows resetting a stuck delivery back to awaiting_commit", () => {
    // commit/push/MR 中途失败、进程崩溃或 hook 卡死时,delivering 状态需要有一个
    // 回到 awaiting_commit 的合法出口,让用户能重新提交 MR,不必被迫进入 failed。
    expect(() => transitionTask("delivering", "awaiting_commit")).not.toThrow();
    expect(() => transitionTask("delivering", "failed")).not.toThrow();
    expect(() => transitionTask("delivering", "await_merge")).not.toThrow();
  });

  it("allows manually completing after implementation without review or MR", () => {
    expect(() => transitionTask("awaiting_review", "completed")).not.toThrow();
    expect(() => transitionTask("reviewing", "completed")).not.toThrow();
    expect(() => transitionTask("review_blocked", "completed")).not.toThrow();
    expect(() => transitionTask("awaiting_commit", "completed")).not.toThrow();
  });

  it("allows completed tasks to be reimplemented", () => {
    expect(() => transitionTask("completed", "preparing")).not.toThrow();
  });
});
