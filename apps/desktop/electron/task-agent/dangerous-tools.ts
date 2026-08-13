/**
 * 危险工具判定 — 工具调用 HITL 规则。
 *
 * Qoder 实现阶段用 `permissionMode: "acceptEdits"`（自动接受编辑）。
 * 默认"常规可行"：只有不可逆的破坏性操作才拦截给用户确认，避免频繁弹窗打断执行，
 * 也避免并行任务时确认框归属不清。
 *
 * 规则（仅确认删除/重命名/移动类，其余一律放行）：
 * - 工具名含 delete / remove / unlink / rm / rename / mv / move → 确认；
 * - Bash / Shell 命令中出现 rm / rmdir / unlink / mv / git rm → 确认；
 * - 其余（shell 写命令、git push/merge/reset 等写操作、Read/Write/Edit/Glob 等）→ 自动放行。
 *
 * 该判定与 PermissionRequest hook 之间保持接口不变（返回 boolean），
 * 后续如需按工具/按命令细化策略（白名单、按仓库规则等），只需扩展本文件。
 */

/** Bash 命令中的破坏性动词（词边界扫描，任意位置命中即确认，覆盖 sudo/xargs/引号/多行前缀；
 * `(?<!-)` 排除 --rm 这类 flag 形态，避免误拦 docker run --rm 等非删除场景）。 */
const DESTRUCTIVE_BASH_PATTERNS = [
  /(?<!-)\brm\b/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\bmv\b/,
  /\bgit\s+rm\b/,
  /(^|\s)-delete\b/
]

function toolInputString(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'cmd', 'args', 'argument', 'shellCommand', 'action', 'subcommand', 'query']) {
    if (typeof record[key] === 'string') return record[key]
  }
  const args = record.args
  if (Array.isArray(args)) return args.map(String).join(' ')
  return ''
}

/** 危险工具判定：命中返回 true，表示需要用户确认。 */
export function isDangerousTool(toolName: string, input: unknown): boolean {
  const name = toolName.toLowerCase()
  const command = toolInputString(input)

  // 删除 / 重命名 / 移动类工具 → 确认（子串/词边界混合匹配：MoveFile/Rmdir 也能命中，
  // 但 remove 中的 move 因前面是词字符不会被 \bmove 误伤）。
  if (/delete|remove|unlink|rename|\bmove|\brm/.test(name)) return true

  // Bash/Shell 命令中的破坏性操作 → 确认；其余 shell 命令默认放行（常规可行）。
  if (/\bbash\b|shell|terminal|command|exec|run\b/.test(name)) {
    return DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(command.trim()))
  }

  // 其余工具（Read/Write/Edit/Glob/Grep/WebFetch/Git 写操作等）自动放行
  return false
}

/** 读动词(token 精确匹配):命中即视为纯查询,不修改外部状态。 */
const READ_VERBS = new Set([
  'get',
  'search',
  'list',
  'read',
  'find',
  'query',
  'download',
  'browse',
  'describe',
  'info',
  'fetch',
  'view',
  'show',
  'check'
])

/**
 * 写操作判定(工具调用 HITL 用):命中返回 true,表示需要用户确认。
 *
 * 用于 MCP 工具(mcp__server__tool):名字按非字母数字字符拆分 token,
 * 含读动词(get/search/list 等) → 读操作,直接放行 —— 即使同时带
 * merge 等疑似写词(如 list_merge_requests 是读操作),列查询语义优先;
 * 无读动词(写动词 create/update/delete 或特征不明) → 需要用户确认,
 * 不确定时宁可确认,不漏掉写操作。
 */
export function isWriteTool(toolName: string): boolean {
  const tokens = toolName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const hasRead = tokens.some((token) => READ_VERBS.has(token))
  if (hasRead) return false
  // 无读动词:写动词命中或特征不明 → 都需要用户确认。
  return true
}

/** 生成确认框里的人类可读描述。 */
export function describeToolAction(toolName: string, input: unknown): string {
  const command = toolInputString(input)
  if (command) return `${toolName}: ${command}`
  let json: string
  try {
    json = JSON.stringify(input ?? {})
  } catch {
    json = String(input ?? '')
  }
  return `${toolName}: ${json}`
}
