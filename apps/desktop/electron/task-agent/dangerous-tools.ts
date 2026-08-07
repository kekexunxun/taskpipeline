/**
 * 危险工具判定 — Phase 2 HITL 的核心规则。
 *
 * Qoder 实现阶段当前用 `permissionMode: "acceptEdits"`（自动接受编辑），
 * 但 shell / git 写操作 / 删除类操作应拦截给用户确认。
 *
 * 规则：
 * - Bash / Shell / Terminal 类：只读命令（ls/cat/head/git status 等）自动放行，其余确认；
 * - Git 类：写操作（push/merge/reset/clean/checkout -f/delete/rm/rebase/pull）确认，只读放行；
 * - Delete / Remove / Unlink / Rm / Rename / Move 类：确认；
 * - 其余工具（Read / Write / Edit / Glob / Grep 等）：自动放行，避免打断 agent 正常节奏。
 */

const READONLY_BASH_COMMANDS = [
  /^ls\b/, /^cat\b/, /^head\b/, /^tail\b/, /^less\b/, /^more\b/, /^pwd\b/, /^whoami\b/,
  /^env\b/, /^echo\b/, /^printf\b/, /^which\b/, /^find\b/, /^grep\b/, /^wc\b/, /^sort\b/,
  /^date\b/, /^uname\b/, /^tree\b/, /^file\b/, /^stat\b/, /^du\b/, /^df\b/
];

const READONLY_GIT_COMMANDS = [
  /^status\b/, /^diff\b/, /^log\b/, /^branch\b/, /^remote\b/, /^show\b/, /^rev-parse\b/,
  /^fetch\b/, /^merge-base\b/, /^ls-files\b/, /^describe\b/, /^config\b/, /^tag\b/,
  /^blame\b/, /^check-ignore\b/, /^symbolic-ref\b/, /^for-each-ref\b/
];

function isReadonlyCommand(command: string, prefixes: RegExp[]): boolean {
  return prefixes.some((pattern) => pattern.test(command.trim()));
}

function toolInputString(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "args", "argument", "shellCommand", "action", "subcommand", "query"]) {
    if (typeof record[key] === "string") return record[key];
  }
  const args = record.args;
  if (Array.isArray(args)) return args.map(String).join(" ");
  return "";
}

/** 危险工具判定：命中返回 true，表示需要用户确认。 */
export function isDangerousTool(toolName: string, input: unknown): boolean {
  const name = toolName.toLowerCase();
  const command = toolInputString(input);

  // 删除 / 重命名 / 移动类
  if (/(^|_)rm\b/.test(name) || /delete|remove|unlink|rename|^mv$|^move\b/.test(name)) return true;

  // Git 写操作（qodercli 通过 Git 工具或 Bash 调用；工具名可能是 Git / GitPush 等复合名）
  if (/git/i.test(name)) {
    if (!command) return true; // 复合工具名无命令文本时无法判断，保守确认
    return !isReadonlyCommand(command, READONLY_GIT_COMMANDS);
  }

  // Shell 类：只读命令放行，其余确认
  if (/\bbash\b|shell|terminal|command|exec|run\b/.test(name)) {
    if (!command) return true; // 无法解析命令文本，保守确认
    // 重定向 / 追加输出（> / >> / 2> 等）会写文件系统，一律视为写操作
    if (/[^=!<>]>/.test(command) || /^>/.test(command)) return true;
    return !isReadonlyCommand(command, READONLY_BASH_COMMANDS) && !(command.startsWith("git ") && isReadonlyCommand(command.slice(4), READONLY_GIT_COMMANDS));
  }

  // 其余工具（Read/Write/Edit/Glob/Grep/WebFetch 等）自动放行
  return false;
}

/** 生成确认框里的人类可读描述。 */
export function describeToolAction(toolName: string, input: unknown): string {
  const command = toolInputString(input);
  if (command) return `${toolName}: ${command}`;
  let json: string;
  try {
    json = JSON.stringify(input ?? {});
  } catch {
    json = String(input ?? "");
  }
  return `${toolName}: ${json}`;
}
