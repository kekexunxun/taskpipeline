import { describe, expect, it } from "vitest";
import { evaluatePermission } from "./permission.js";

describe("permission gate policy", () => {
  it("allows reads inside a task worktree and blocks outside access", () => {
    expect(evaluatePermission("read", { path: "src/a.ts" }, ["/workspace/repo"], "/workspace/repo").action).toBe("allow");
    expect(evaluatePermission("read", { path: "../../.ssh/id_rsa" }, ["/workspace/repo"], "/workspace/repo").action).toBe("block");
  });
  it("blocks destructive and Docker commands", () => {
    expect(evaluatePermission("bash", { command: "git reset --hard" }, [], "/workspace").action).toBe("block");
    expect(evaluatePermission("bash", { command: "docker exec task sh" }, [], "/workspace").action).toBe("block");
  });
  it("requires confirmation for networking and delivery", () => {
    expect(evaluatePermission("bash", { command: "npm install" }, [], "/workspace").action).toBe("confirm");
    expect(evaluatePermission("bash", { command: "git push origin branch" }, [], "/workspace").action).toBe("confirm");
  });
});
