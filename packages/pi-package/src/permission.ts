import { resolve } from "node:path";

export type PermissionDecision = { action: "allow" | "confirm" | "block"; reason?: string };

const blockedCommands = [
  /\brm\s+(-rf?|--recursive)\b/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*\b777\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)\b/i,
  /\b(docker|podman)\s+(rm|system\s+prune|volume\s+rm|run|exec)\b/i,
  /(?:^|[\s"'])((?:~|\/)[^\s"']*\.(?:ssh|aws|gnupg)|~\/(?:\.ssh|\.aws|\.gnupg)|\.env(?:\.|\s|$))/i
];
const deliveryCommands = [/\bgit\s+commit\b/i, /\bgit\s+push\b/i, /\bglab\s+mr\s+create\b/i];
const networkCommands = [/\b(curl|wget)\b/i, /\b(npm|pnpm|yarn|pip|cargo|go)\s+(install|add|get)\b/i];

export function evaluatePermission(toolName: string, input: Record<string, unknown>, roots: string[], cwd: string): PermissionDecision {
  if (["write", "edit", "read"].includes(toolName)) {
    const path = String(input.path ?? input.file_path ?? "");
    if (path && roots.length > 0) {
      const absolute = resolve(cwd, path);
      const allowed = roots.some((root) => absolute === resolve(root) || absolute.startsWith(`${resolve(root)}/`) || absolute.startsWith(`${resolve(root)}\\`));
      if (!allowed) return { action: "block", reason: "文件访问超出当前任务 worktree" };
    }
  }
  if (toolName !== "bash") return { action: "allow" };
  const command = String(input.command ?? "");
  if (blockedCommands.some((pattern) => pattern.test(command))) return { action: "block", reason: "命令违反默认安全策略" };
  if (deliveryCommands.some((pattern) => pattern.test(command))) return { action: "confirm", reason: "交付命令始终需要确认" };
  if (networkCommands.some((pattern) => pattern.test(command))) return { action: "confirm", reason: "联网或安装依赖需要确认" };
  return { action: "allow" };
}
