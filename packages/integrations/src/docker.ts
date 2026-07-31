import { spawn } from "node:child_process";
import { execa } from "execa";

export type SandboxOptions = { image: string; name: string; worktrees: string[]; env?: Record<string, string>; network?: "default" | "none" };

export class DockerSandbox {
  constructor(private readonly command = "docker") {}
  async available(): Promise<boolean> { return (await execa(this.command, ["info"], { reject: false })).exitCode === 0; }
  async start(options: SandboxOptions): Promise<void> {
    const mounts = options.worktrees.flatMap((path) => ["--mount", `type=bind,source=${path},target=${path}`]);
    const env = Object.keys(options.env ?? {}).flatMap((key) => ["-e", key]);
    const existing = await execa(this.command, ["inspect", "-f", "{{.State.Running}}", options.name], { reject: false });
    if (existing.stdout.trim() === "true") return;
    await execa(this.command, ["rm", "-f", options.name], { reject: false });
    const result = await execa(this.command, ["run", "--detach", "--name", options.name, "--network", options.network ?? "default", ...mounts, ...env, "--entrypoint", "sh", options.image, "-c", "trap : TERM INT; sleep infinity & wait"], { reject: false, env: { ...process.env, ...(options.env ?? {}) } });
    if (result.exitCode !== 0) throw new Error(result.stderr || `Unable to start sandbox ${options.name}`);
  }
  async exec(name: string, args: string[], input?: string | Buffer): Promise<Buffer> {
    const result = await this.execResult(name, args, input);
    if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString("utf8") || `Sandbox command failed (${result.exitCode})`);
    return result.stdout;
  }
  async execResult(name: string, args: string[], input?: string | Buffer): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
    const result = await execa(this.command, ["exec", "-i", name, ...args], { reject: false, input });
    return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), exitCode: result.exitCode ?? 1 };
  }
  async execAt(name: string, cwd: string, file: string, args: string[] = [], input?: string | Buffer): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
    const result = await execa(this.command, ["exec", "-i", "-w", cwd, name, file, ...args], { reject: false, input });
    return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), exitCode: result.exitCode ?? 1 };
  }
  execStreaming(name: string, cwd: string, command: string, options: { onData(data: Buffer): void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => value === undefined ? [] : ["-e", `${key}=${value}`]);
      const child = spawn(this.command, ["exec", "-i", "-w", cwd, ...env, name, "sh", "-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
      let timedOut = false;
      const timer = options.timeout ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeout * 1000) : undefined;
      child.stdout.on("data", options.onData);
      child.stderr.on("data", options.onData);
      child.once("error", reject);
      const abort = () => child.kill("SIGKILL");
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("close", (code) => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (options.signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
        else resolve({ exitCode: code });
      });
    });
  }
  async run(options: SandboxOptions, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const mounts = options.worktrees.flatMap((path) => ["--mount", `type=bind,source=${path},target=/workspace/${path.split(/[\\/]/).pop() ?? "repo"}`]);
    const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const result = await execa(this.command, ["run", "--rm", "--name", options.name, "--network", options.network ?? "default", ...mounts, ...env, options.image, ...args], { reject: false });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
  }
  async stop(name: string): Promise<void> { await execa(this.command, ["rm", "-f", name], { reject: false }); }
}
