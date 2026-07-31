import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { app } from "electron";

const localRequire = createRequire(import.meta.url);

export function resolveBundledOcrBinary(): string | undefined {
  try {
    const path = localRequire.resolve("@alibaba-group/open-code-review/bin/ocr.js");
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

export function resolveOcrBinary(): string {
  return resolveBundledOcrBinary() ?? "ocr";
}

export type OcrRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  failed?: boolean;
  reason?: string;
  shortMessage?: string;
};

/**
 * 在 electron 打包后,沙盒里没有 PATH 上的 node,直接 spawn .js 会失败。
 * 用 electron 自带的 process.execPath + ELECTRON_RUN_AS_NODE=1 当作 node 用。
 *
 * 同时把 HOME 重定向到 userData,防止 ocr 尝试写 ~/.opencodereview/sessions
 * 时被 macOS 沙盒拒绝(EACCES / "operation not permitted")。
 */
export function createOcrRunner(): (binary: string, args: string[], cwd: string) => Promise<OcrRunResult> {
  return async (binary, args, cwd) => {
    const result = spawnSync(process.execPath, [binary, ...args], {
      cwd,
      timeout: 15 * 60_000,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOME: app.getPath("userData") }
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
      failed: Boolean(result.error),
      reason: result.error ? (result.error as NodeJS.ErrnoException).code : undefined,
      shortMessage: result.error?.message
    };
  };
}
