import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileKeyStore } from "./crypto.js";

const dirs: string[] = [];
afterEach(() => { delete process.env.TASK_PIPELINE_TEST_KEY; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("LocalFileKeyStore", () => {
  it("encrypts with AAD and creates a user-only installation key", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-pipeline-key-")); dirs.push(dir);
    const keys = new LocalFileKeyStore(dir);
    const protectedValue = keys.protect("secret-value", "gitlabToken");
    expect(protectedValue).not.toContain("secret-value");
    expect(keys.resolve(protectedValue, "gitlabToken")).toBe("secret-value");
    if (process.platform !== "win32") expect(statSync(join(dir, "install.key")).mode & 0o777).toBe(0o600);
  });

  it("resolves environment references without persistence", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-pipeline-key-")); dirs.push(dir);
    process.env.TASK_PIPELINE_TEST_KEY = "from-env";
    expect(new LocalFileKeyStore(dir).resolve("env:TASK_PIPELINE_TEST_KEY")).toBe("from-env");
  });
});
