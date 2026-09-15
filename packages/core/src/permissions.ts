import { homedir } from 'node:os'
import { normalize, relative, resolve, sep } from 'node:path'
import type { TaskState } from './types.js'

/**
 * 执行期权限 —— 任务链路的两条引擎路径（Qoder 的 `canUseTool` 回调、Pi 的 `tool_call` 事件）
 * 共用同一份判定，规则表只在此维护一份。
 *
 * 三层规则（设计说明见 docs/task-fixed-pipeline-plan.md §4.6）：
 *
 * - **L1 硬阻断**：越出本任务 worktree 集合的写 / 移动 / 删除、不可逆破坏性命令、凭据类敏感路径，
 *   以及**阶段级只读 / 测试路径约束**（P4）。不可配置，也不得被任何 HITL 档位绕过。
 * - **L2 交付动作**（`git commit` / `git push` / `mr create`）不在执行期弹框：是否自动提交由任务链路
 *   末尾的交付配置决定，因此这里一律放行。
 * - **L3 其余全部放行**：含 worktree 内的 `mv` / `rm`、覆盖写、联网与依赖安装。
 *   这一层正是「任务执行期尽量少 HITL」的落点 —— 旧实现把每一次 `mv` / `rm` 都弹窗，是打断的主要来源。
 */

export type ExecutionPermission = { action: 'allow' | 'block'; reason?: string }

/**
 * 执行期阶段（P4）：把「Plan 只读」「Test 只改测试文件」从 prompt 里的口头约束
 * 变成 L1 判定的一部分。
 *
 * 取值来自**任务状态机**而不是会话字段：两条引擎都能从 DB 拿到 state，因此
 * 不需要把阶段信息穿过 CLI / Pi 子进程边界（那条路上根本没有可靠的注入口）。
 */
export type ExecutionPhase = 'planning' | 'implementation' | 'test' | 'other'

/** 任务状态 → 执行期阶段；非执行态（草稿 / 评审 / 交付）按 `other` 处理，不附加阶段约束。 */
export function executionPhaseOf(state: TaskState | undefined): ExecutionPhase {
  if (state === 'planning') return 'planning'
  if (state === 'generating_tests') return 'test'
  if (['preparing', 'implementing', 'awaiting_input', 'validating', 'validation_failed'].includes(state ?? ''))
    return 'implementation'
  return 'other'
}

/** 命令串里的破坏性形态：不可逆且破坏面超出单个文件。 */
const DESTRUCTIVE_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b[^\n]*\s-[a-z]*[rf]/i, reason: '递归或强制删除（rm -r / rm -f）已禁用' },
  { pattern: /\brmdir\b[^\n]*\s-/i, reason: '带参数的递归删除目录（rmdir -p 等）已禁用' },
  { pattern: /\b(sudo|doas)\b/i, reason: '提权执行已禁用' },
  { pattern: /\b(chmod|chown)\b[^\n]*\b(777|a\+rwx)\b/i, reason: '全局可写的权限变更已禁用' },
  {
    pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\b[^\n]*--(force|no-verify))/i,
    reason: '会丢弃本地提交或绕过校验的 git 命令已禁用'
  },
  { pattern: /\b(dd|mkfs|diskutil|shutdown|reboot)\b/i, reason: '磁盘与系统级命令已禁用' },
  {
    pattern: /\b(docker|podman)\s+(system\s+prune|volume\s+rm|container\s+rm)\b/i,
    reason: '会影响其他容器或卷的清理命令已禁用'
  }
]

/** 会改动文件系统的外部命令：只有这类命令才需要再做「路径是否越界」判定。 */
const MUTATING_COMMANDS =
  /\b(rm|rmdir|unlink|mv|cp|dd|truncate|touch|mkdir|chmod|chown|install|rsync|ln|git\s+(?:rm|mv|checkout|apply|clean))\b|>>?/i

/** 写 / 删 / 移动类工具（小写工具名片段）。 */
const WRITE_TOOL_FRAGMENT =
  /(write|edit|patch|multiedit|delete|remove|unlink|rename|move|copy|truncate|mkdir|savefile)/i
/** 命令执行类工具。 */
const COMMAND_TOOL_FRAGMENT = /(bash|shell|terminal|execute|exec|command|run[-_]?script)/i

/** 凭据类目录与文件（按路径段精确匹配，避免 `src/aws-utils.ts` 这种误伤）。 */
const SENSITIVE_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.npmrc', '.netrc', '.git-credentials', '.terraformrc'])
const SENSITIVE_BASENAMES = new Set(['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'])
/** `.env` 家族里允许写的模板文件。 */
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/

/** input 里可能承载文件路径的键（两侧引擎与 MCP 工具的常见命名）。 */
const PATH_KEYS = [
  'path',
  'file_path',
  'notebook_path',
  'target_file',
  'abs_path',
  'filepath',
  'file',
  'directory',
  'dir',
  'destination',
  'source_path',
  'new_path',
  'old_path'
]

/** input 里可能承载 shell 命令的键。 */
const COMMAND_KEYS = ['command', 'cmd', 'shellCommand', 'script']

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 2 || value == null) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1))
  return []
}

/** 入参里没有标准路径键时，只有这类工具才需要把兄弟字段当路径候选。 */
const PATHLESS_MOVE_TOOLS = /(delete|remove|unlink|rename|move|copy)/i

/** 取出 input 中所有可能的路径参数（含批量编辑工具的数组形态）。 */
export function pathArgumentsOf(toolName: string, input: unknown): string[] {
  const record = asRecord(input)
  const found: string[] = []
  for (const key of PATH_KEYS) found.push(...collectStrings(record[key]))
  if (found.length === 0 && PATHLESS_MOVE_TOOLS.test(toolName.toLowerCase())) {
    // 少数 MCP 移动 / 删除工具把路径放在其它字段里。写类工具（Write / Edit）不做这个兜底：
    // 它们的正文字段（new_string / content）含路径字样属于误判源。
    for (const value of Object.values(record)) found.push(...collectStrings(value))
  }
  return found.filter((value) => value.trim() !== '')
}

/** 取出 input 里的 shell 命令串。 */
export function commandOf(toolName: string, input: unknown): string {
  const record = asRecord(input)
  for (const key of COMMAND_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  if (typeof input === 'string' && COMMAND_TOOL_FRAGMENT.test(toolName.toLowerCase())) return input
  return ''
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2))
  return value
}

function normalized(path: string, cwd: string): string {
  const absolute = resolve(cwd, expandHome(path))
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** 路径是否落在任一 worktree 根目录之内。 */
export function isInsideRoots(path: string, roots: string[], cwd: string): boolean {
  if (roots.length === 0) return true // 未关联仓库时不做路径约束，交给命令级规则兜底。
  const target = normalized(path, cwd)
  return roots.some((root) => {
    const base = normalized(root, cwd)
    return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
  })
}

/** 是否为凭据 / 密钥类路径（含 `.env`，但放行 `.env.example` 一类模板）。 */
export function isSensitivePath(value: string): boolean {
  const segments = expandHome(value)
    .split(/[/\\]+/)
    .filter(Boolean)
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment) || SENSITIVE_BASENAMES.has(segment))) return true
  const last = segments[segments.length - 1] ?? ''
  if (!last.startsWith('.env')) return false
  return last === '.env' || (/^\.env\./.test(last) && !ENV_TEMPLATE.test(last))
}

/** 命令串拆成候选 token：去掉重定向符号与引号分隔，供路径判定复用。 */
function commandTokens(command: string): string[] {
  return command
    .split(/[\s;&|()<>"'`\n]+/)
    .map((token) => token.replace(/^>+/, ''))
    .filter(Boolean)
}

/** 命令里是否触碰了凭据路径。 */
function commandTouchesSensitive(command: string): boolean {
  return commandTokens(command).some((token) => isSensitivePath(token))
}

/** 从命令串里挑出「会改动工作区之外路径」的 token。 */
function escapedPathsInCommand(command: string, roots: string[], cwd: string): string[] {
  return commandTokens(command).filter((token) => {
    if (!/^(~|\.\.?[/\\]|\/|[a-zA-Z]:[\\/])/.test(token)) return false // 相对路径在 worktree 内执行，视为安全
    return !isInsideRoots(token, roots, cwd)
  })
}

/** 任务关联仓库的 worktree 根集合，两条引擎共用同一算法。 */
export function taskRoots(repositories: Array<{ worktreePath?: string; localPath: string }>): string[] {
  return repositories.map((repo) => repo.worktreePath ?? repo.localPath).filter(Boolean)
}

/**
 * 测试产物路径（P4：Test 阶段的写入白名单）。
 *
 * 按「目录名 + 文件名后缀」两类形态宽松匹配：各语言/框架的约定都在里面，
 * 宁可宽一点 —— 拦错会让 Test 阶段直接跑不下去，放宽只少一层约束。
 */
const TEST_PATH_PATTERN =
  /(^|[/\\])(tests?|__tests__|spec|specs|testfixtures?|fixtures?)([/\\]|$)|\.(test|spec)\.(tsx?|jsx?|mts|cts|mjs|cjs|vue|svelte)$|_test\.(go|py|rb|java)$|(^|[/\\])test_[^/\\]+\.py$/i

/** 是否为测试相关路径（相对路径与绝对路径都按字符串形态判断）。 */
export function isTestArtifactPath(path: string): boolean {
  return TEST_PATH_PATTERN.test(expandHome(path))
}

/**
 * 先换成「仓库内相对路径」再判测试路径。
 *
 * 不能直接拿绝对路径去匹配：工作区路径自己带 `test` / `spec` 字样时（`~/test/repo`）会把
 * 整个仓库洗成“测试目录”，约束直接失效。
 */
function repoRelativeTarget(path: string, roots: string[], cwd: string): string {
  const absolute = normalize(resolve(cwd, expandHome(path)))
  const root = roots.find((candidate) => isInsideRoots(path, [candidate], cwd))
  if (!root) return absolute
  return relative(normalize(resolve(cwd, expandHome(root))), absolute) || absolute
}

/**
 * 执行期权限判定。
 *
 * @param toolName 工具名（Qoder 内置工具、MCP 工具名、Pi 工具名都适用）
 * @param input 工具入参
 * @param options.roots 本任务允许的 worktree 根目录集合
 * @param options.cwd 当前工作目录（相对路径的解析基准）
 * @param options.phase 执行期阶段（P4）：缺省 `other` = 不附加阶段约束，行为与加参数前完全一致
 */
export function evaluateExecutionPermission(
  toolName: string,
  input: unknown,
  options: { roots: string[]; cwd: string; phase?: ExecutionPhase }
): ExecutionPermission {
  const { roots, cwd, phase = 'other' } = options
  const name = toolName.toLowerCase()
  const paths = pathArgumentsOf(toolName, input)
  const isWriteTool = WRITE_TOOL_FRAGMENT.test(name)

  // 1) 越出任务工作区的写 / 删 / 移动
  if (isWriteTool) {
    const escaped = paths.filter((path) => !isInsideRoots(path, roots, cwd))
    if (escaped.length > 0)
      return { action: 'block', reason: `文件操作超出本任务工作区：${escaped.slice(0, 2).join('、')}` }
  }

  // 2) 凭据路径：任何工具、任何档位、任何阶段都阻断（读也拦，避免把密钥内容带进上下文）
  if (paths.some((path) => isSensitivePath(path))) return { action: 'block', reason: '禁止访问凭据与密钥类路径' }

  // 3) 阶段级约束（P4）。
  //    Plan：任何写 / 删 / 移动都拦 —— Qoder 侧另有 `disallowedTools` 硬边界，但那只是 CLI 层，
  //    Pi 运行时没有等价原语（`capabilities().perPhasePermission === false`），只读必须由这里保证。
  //    Test：只允许改测试产物 —— 它不该动业务逻辑（§2.2）。
  if (phase === 'planning' && isWriteTool)
    return { action: 'block', reason: '计划阶段只读：不得改动文件，请把结论写进计划正文' }
  if (phase === 'test' && isWriteTool) {
    const outside = paths.filter((path) => !isTestArtifactPath(repoRelativeTarget(path, roots, cwd)))
    if (outside.length > 0)
      return { action: 'block', reason: `测试阶段只允许改动测试文件：${outside.slice(0, 2).join('、')} 不是测试路径` }
  }

  // 4) 命令执行类工具
  const command = commandOf(toolName, input)
  if (COMMAND_TOOL_FRAGMENT.test(name) || command !== '') {
    if (!command) return { action: 'allow' }
    const destructive = DESTRUCTIVE_COMMANDS.find((item) => item.pattern.test(command))
    if (destructive) return { action: 'block', reason: destructive.reason }
    if (commandTouchesSensitive(command)) return { action: 'block', reason: '禁止访问凭据与密钥类路径' }
    // Plan 阶段的命令只允许只读探索：任何会改动工作区的命令都拦（含 `>` 重定向与依赖安装）。
    // 放在越界判定之前：阶段约束比「落在哪个路径」更优先，报错也更好解释。
    if (phase === 'planning' && MUTATING_COMMANDS.test(command))
      return { action: 'block', reason: '计划阶段只读：该命令会改动工作区，请改为只读探索' }
    if (MUTATING_COMMANDS.test(command)) {
      const escaped = escapedPathsInCommand(command, roots, cwd)
      if (escaped.length > 0)
        return { action: 'block', reason: `命令将改动本任务工作区之外的路径：${escaped.slice(0, 2).join('、')}` }
    }
  }

  // 5) 读类工具碰到的凭据路径已由第 2 条覆盖，其余一律放行
  return { action: 'allow' }
}
