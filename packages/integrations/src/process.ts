import { execa, type ResultPromise } from "execa";

export type ProcessRunner = (file: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; cancelSignal?: AbortSignal }) => ResultPromise;

export const runProcess: ProcessRunner = (file, args, options) => execa(file, args, { ...options, reject: true });
export type ShellRunner = (command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; cancelSignal?: AbortSignal }) => ResultPromise;
export const runShell: ShellRunner = (command, options) => execa(command, { ...options, shell: true, reject: true });

export function redactSecrets(value: string): string {
  return value.replace(/(token|secret|password|api[_-]?key|authorization)([=:]\s*)([^\s,;]+)/gi, "$1$2[redacted]").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}
