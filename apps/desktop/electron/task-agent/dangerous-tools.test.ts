import { describe, expect, it } from "vitest";
import { describeToolAction, isDangerousTool } from "./dangerous-tools.js";

describe("isDangerousTool（工具调用 HITL 规则：仅删除类确认）", () => {
  it("Bash 只读命令自动放行", () => {
    expect(isDangerousTool("Bash", { command: "ls -la" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "cat package.json" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "git status" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "git diff --stat" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "grep -r foo src" })).toBe(false);
  });

  it("Bash 破坏性命令（rm/mv/rmdir/unlink/git rm/find -delete）需要确认", () => {
    expect(isDangerousTool("Bash", { command: "rm -rf node_modules" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "rm file.txt" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "mv a.ts b.ts" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "rmdir dist" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "unlink /tmp/a" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "git rm old.ts" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "cd src && rm -rf build" })).toBe(true);
  });

  it("Bash 删除命令带前缀/包裹时不绕过确认", () => {
    expect(isDangerousTool("Bash", { command: "sudo rm -rf /" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "cd x && sudo rm -rf y" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "xargs rm -rf x" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "sh -c 'rm -rf x'" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "find . -delete" })).toBe(true);
    expect(isDangerousTool("Bash", { command: "git rm -r old/" })).toBe(true);
    // 多行命令第二行的删除
    expect(isDangerousTool("Bash", { command: "npm run build\nrm -rf dist" })).toBe(true);
  });

  it("Bash 写命令默认放行（常规可行，不频繁打断）", () => {
    expect(isDangerousTool("Bash", { command: "npm install" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "git push origin main" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "git checkout -f main" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "echo hi > file.txt" })).toBe(false);
    expect(isDangerousTool("Bash", { command: "python build.py" })).toBe(false);
    // --rm 是 docker 等命令的 flag，不是删除操作，不应拦截
    expect(isDangerousTool("Bash", { command: "docker run --rm -it node:20 bash" })).toBe(false);
  });

  it("Bash 无法解析命令文本时默认放行（不打断执行）", () => {
    expect(isDangerousTool("Bash", {})).toBe(false);
    expect(isDangerousTool("Bash", undefined)).toBe(false);
  });

  it("Git 工具（含写操作）默认放行", () => {
    expect(isDangerousTool("Git", { command: "status" })).toBe(false);
    expect(isDangerousTool("Git", { command: "push" })).toBe(false);
    expect(isDangerousTool("Git", { command: "reset --hard HEAD" })).toBe(false);
    expect(isDangerousTool("GitPush", { branch: "main" })).toBe(false);
    expect(isDangerousTool("GitCommit", { message: "x" })).toBe(false);
  });

  it("删除 / 重命名 / 移动类工具确认", () => {
    expect(isDangerousTool("DeleteFile", { path: "/tmp/a.ts" })).toBe(true);
    expect(isDangerousTool("RemoveFile", { path: "/tmp/a.ts" })).toBe(true);
    expect(isDangerousTool("Unlink", { path: "/tmp/a.ts" })).toBe(true);
    expect(isDangerousTool("Rename", { from: "/tmp/a.ts", to: "/tmp/b.ts" })).toBe(true);
    expect(isDangerousTool("Move", { path: "/tmp/a.ts" })).toBe(true);
    expect(isDangerousTool("MoveFile", { path: "/tmp/a.ts" })).toBe(true);
    expect(isDangerousTool("MoveFileTo", { path: "/tmp/a.ts" })).toBe(true);
    expect(isDangerousTool("Rmdir", { path: "/tmp/dist" })).toBe(true);
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
    expect(describeToolAction("Bash", { command: "rm -rf build" })).toBe("Bash: rm -rf build");
  });
  it("无命令时输出 JSON", () => {
    expect(describeToolAction("DeleteFile", { path: "/tmp/a.ts" })).toContain("/tmp/a.ts");
  });
});
