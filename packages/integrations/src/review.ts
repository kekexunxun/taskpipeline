import { execa } from "execa";

export type ReviewComment = { path?: string; line?: number; severity?: string; message?: string; [key: string]: unknown };
export type ReviewResult = { status: string; comments: ReviewComment[]; summary?: Record<string, unknown>; warnings?: unknown[]; session_id?: string };
export type ReviewRunner = (binary: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number; failed?: boolean; reason?: string; shortMessage?: string }>;

export class OpenCodeReviewService {
  constructor(
    private readonly binary = "ocr",
    private readonly runner: ReviewRunner = async (binary, args, cwd) => {
      const result = await execa(binary, args, { cwd, reject: false, timeout: 15 * 60_000 });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 1,
        failed: result.failed,
        reason: (result as { reason?: string }).reason,
        shortMessage: (result as { shortMessage?: string }).shortMessage
      };
    },
    private readonly commandPrefix: string[] = []
  ) {}

  private async run(args: string[], cwd: string): Promise<string> {
    const result = await this.runner(this.binary, [...this.commandPrefix, ...args], cwd);
    if (result.exitCode !== 0) {
      const execaInfo = result.failed ? ` [execa failed=${result.failed}${result.reason ? `, reason=${result.reason}` : ""}${result.shortMessage ? `, ${result.shortMessage}` : ""}]` : "";
      const tail = result.stdout.trim() ? `\nstdout: ${result.stdout.slice(0, 500)}` : "";
      throw new Error(`ocr ${[...this.commandPrefix, ...args].join(" ")} exitCode=${result.exitCode}${execaInfo}; stderr: ${result.stderr.trim() || "(空)"}${tail}`);
    }
    return result.stdout;
  }

  private async runJson<T>(args: string[], cwd: string): Promise<T> {
    const stdout = await this.run(args, cwd);
    try { return JSON.parse(stdout) as T; } catch (error) {
      throw new Error(`Invalid ocr JSON (${this.binary} ${args.join(" ")}): ${(error as Error).message}; stdout: ${stdout.slice(0, 500)}`);
    }
  }

  async review(cwd: string): Promise<ReviewResult> {
    return this.runJson<ReviewResult>(["review", "--output", "json"], cwd);
  }

  /**
   * `ocr delegate rule <paths...>` 输出是给人/Agent 读的 Markdown,
   * 不是结构化 JSON。返回原始 stdout,由调用方把它当 prompt 上下文喂给 LLM。
   */
  async rule(cwd: string, paths: string[]): Promise<string> {
    if (paths.length === 0) return "";
    return this.run(["delegate", "rule", ...paths], cwd);
  }
}

/**
 * 从 LLM 文本响应里提取第一个完整 JSON 对象,处理以下边界:
 * - LLM 把 JSON 包在 ```json ... ``` markdown code block 里
 * - 流式输出被分块叠加(同一个 JSON 出现两次)
 * - JSON 字符串字面量里出现 { 或 }
 * 找到第一个 '{' 后用 brace-balance 跟踪,处理 \\ 转义和字符串内字符,
 * 找到匹配的 '}' 时返回完整 slice。
 */
export function extractFirstJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no '{' found in text");
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced JSON braces: no matching '}'");
}
