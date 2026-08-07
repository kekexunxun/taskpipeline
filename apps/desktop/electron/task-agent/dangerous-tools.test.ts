import { describe, expect, it } from "vitest";
import { describeToolAction, isDangerousTool } from "./dangerous-tools.js";

describe("isDangerousTool（Phase 2 危险工具判定）", () => {
  it("Bash 只读命令自动放行", () => {
    expect(isDangerousTool("Bash", { command: "ls -la" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "cat package.json" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "git status" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "git diff --stat" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "grep -r foo src" })).toBe(false);
  });

  it("Bash 写命令需要确认", () => {
    expect(isDangerousTool("Bash", { command: "rm -rf node_modules" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "npm install" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "git push origin main" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "git checkout -f main" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "echo hi > file.txt" })).toBe(true);
  });

  it("Bash 无法解析命令文本时保守确认", () => {
    expect(isDangerousTool("Bash", {})).toBe(true);
    expect(isDangerousTool("Bash", undefined)).toBe(true);
  });

  it("Git 工具：写操作确认、只读放行", () => {
    expect(isDangerousTool("Git", { command: "status" })).toBe(false);
    expect(isDangerousTool("Git", { command: "diff" })).toBe(false);
    expect(isDangerousTool("Git", { command: "push" })).toBe(true);
    expect(isDangerousTool("Git", { command: "reset --hard HEAD" })).toBe(true);
    expect(isDangerousTool("Git", { command: "merge feature/x" })).toBe(true);
    expect(isDangerousTool("Git", { command: "clean -fd" })).toBe(true);
  });

  it("Git 复合工具名（GitPush/GitCommit）不绕过确认，无命令文本时保守确认", () => {
    expect(isDangerousTool("GitPush", { branch: "main" })).toBe(true);
    expect(isDangerousTool("GitCommit", { message: "x" })).toBe(true);
    expect(isDangerousTool("GitStatus", {})).toBe(true); // 无命令文本，保守确认
    expect(isDangerousTool("GitStatus", { command: "status" })).toBe(false);
  });

  it("删除 / 重命名 / 移动类工具确认", () => {
    expect(isDangerousTool("DeleteFile", { path: "/tmp/a.ts" })).toBe(true);
    expect(isDangerousTool("RemoveFile", { path: "/tmp/a.ts" })).toBe(true);
    expect(isDangerousTool("Unlink", { path: "/tmp/a.ts" })).toBe(true);
    expect(isDangerousTool("Rename", { from: "/tmp/a.ts", to: "/tmp/b.ts" })).toBe(true);
    expect(isDangerousTool("Move", { path: "/tmp/a.ts" })).toBe(true);
  });

  it("普通编辑 / 只读工具自动放行（不打断 agent 节奏）", () => {
    expect(isDangerousTool("Write", { file_path: "/tmp/a.ts", content: "x" })).toBe(false);
    expect(isDangerousTool("Edit", { file_path: "/tmp/a.ts" })).toBe(false);
    expect(isDangerousTool("Read", { file_path: "/tmp/a.ts" })).toBe(false);
    expect(isDangerousTool("Glob", { pattern: "**/*.ts" })).toBe(false);
    expect(isDangerousTool("Grep", { pattern: "foo" })).toBe(false);
    expect(isDangerousTool("WebFetch", { url: "https://example.com" })).toBe(false);
  });
});

describe("describeToolAction", () => {
  it("优先输出命令文本", () => {
    expect(describeToolAction("Bash", { command: "git push" })).toBe("Bash: git push");
  });
  it("无命令时输出 JSON", () => {
    expect(describeToolAction("DeleteFile", { path: "/tmp/a.ts" })).toContain("/tmp/a.ts");
  });
});
