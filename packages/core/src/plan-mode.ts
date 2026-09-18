import type { Task } from './types.js'

/** Plan 模式下发给 LLM 的指令上下文 */
export interface PlanModeContext {
  task: Pick<Task, 'title' | 'description' | 'acceptanceCriteria'>
  /** 上一次 plan 被拒 / 需要修订时的反馈,可选 */
  feedback?: string
}

/** `runPlan` 的可选参数 */
export interface RunPlanOptions {
  /** abort signal — 触发后 provider 应尽快取消子进程 / SDK 调用 */
  signal?: AbortSignal
  /** plan 阶段使用的模型,默认走 driver 自己的模型解析 */
  model?: string
  /** 子进程 / SDK 的 cwd,默认走 task 主仓库的 worktree / local 路径 */
  cwd?: string
  /** 硬超时(毫秒),默认 5 分钟 */
  hardTimeoutMs?: number
}

/** 从 LLM 输出里解析出的 plan 结构 */
export type ParsedPlan =
  | { outcome: 'already_satisfied'; summary: string }
  | { outcome: 'changes_required'; plan: string }
  | { outcome: 'unparsed'; raw: string }

/**
 * Plan Mode 抽象。
 *
 * 统一接口: `runPlan(ctx)` 拿到 plan,不管内部是 spawn 子进程还是调 SDK。
 * 两边的实现各有自己的"硬约束"机制:
 *  - Qoder:`QoderTaskAgentDriver.runQuery({ permissionMode: "plan" })`,SDK 负责隔离。
 *  - pi-agent:`spawn()` 拉起一个子 pi 进程,工具集为 `read,grep,find,ls`,根本没有写盘能力 — 这就是 subagent-isolation。
 *
 * `instruction(ctx)` 是"planner 角色"系统 prompt 模板(子进程 `--append-system-prompt` 注入),
 * `parseOutput(raw)` 从 LLM 输出中抽出结构化 plan JSON。
 */
export interface PlanModeProvider {
  readonly providerId: 'qoder' | 'pi-agent' | (string & {})

  /**
   * 跑一次 plan,返回 parsed plan。
   * 本调用期间主 session 状态**完全不会被修改** — Qoder 走 SDK 隔离,pi-agent 走子进程隔离。
   */
  runPlan(ctx: PlanModeContext, options?: RunPlanOptions): Promise<ParsedPlan>

  /** planner 角色的系统 prompt(给子进程 / SDK 用) */
  instruction(ctx: PlanModeContext): string

  /** 从 LLM 输出里抽出结构化 plan */
  parseOutput(raw: string): ParsedPlan
}

/**
 * planner 子代理名。
 *
 * Chat 计划模式的架构定位：计划**不在主线上做**。主会话（对话/任务）始终保留自己的完整
 * 工具权限，开启计划模式只是让主会话把本轮的规划工作委派给这个名字的子代理。
 * Qoder 链路把它注册进 SDK `agents`，由 CLI 的 `Agent` 工具按名委派；
 * ai-sdk 链路没有原生子代理，由 driver 起一次同名的嵌套只读回合（见 openai-chat-driver）。
 */
export const PLANNER_AGENT_NAME = 'planner'

/**
 * planner 子代理的工具硬边界：直接禁掉写类工具，规划期间根本看不到改动能力。
 *
 * 边界只加在子代理身上，**不加在主会话身上** —— 这是与旧实现的关键区别：旧实现按
 * chatMode 裁剪主链路工具，计划轮次被打断/失败后模式残留，后续执行轮次也跟着丢工具。
 */
export const PLANNER_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit']

/** planner 子代理描述（Qoder `Agent` 子代理列表 / 嵌套回合的语义标签共用）。 */
export function plannerAgentDescription(): string {
  return '只读分析与实施计划制定：读取代码现状，产出可落地执行的 Markdown 计划，不改动工作区。'
}

/**
 * 计划模式的 planner 角色系统提示（Chat 子代理 / Coding 共用）。
 *
 * Chat 路径：作为 planner 子代理自己的 prompt（Qoder `agents[planner].prompt`、
 * ai-sdk 嵌套回合的 system），只读分析并输出 Markdown 格式计划。
 * Coding 路径：OpenAI `runOpenAIPlan` 等场景复用同一份提示，保证行为一致。
 * 主链路不会拿到这份提示——它只负责委派与转述（见 `planDelegationInstruction`）。
 *
 * @param ctx - 可选上下文；Coding 路径传入任务标题/描述，Chat 路径可省略
 */
export function planModeInstruction(ctx?: { title?: string; description?: string }): string {
  const lines = [
    `你是 ${PLANNER_AGENT_NAME} 子代理：职责是产出一份完整、可直接落地执行的实施计划。分析阶段只读不改动工作区，真正的改动会在计划确定后由主会话接手执行。`,
    '请分析用户的需求和代码，制定详细的实施计划。',
    '',
    '【关键：把完整计划直接写进你的回复正文】把整篇计划作为普通消息正文输出（严格用下面的 Markdown 结构）。系统会自动捕获你的正文、渲染为计划卡片，并把这份完整正文落盘到工作区仓库的 docs/ 目录，无需你或用户手动保存。',
    '绝对不要输出「我无法落盘 / 请你手动保存 / 建议手动保存」这类免责说明，也不要因为看起来只有只读工具就只回一段能力介绍——计划正文的落盘由系统负责。',
    '优先把完整计划写进正文（便于渲染卡片与落盘）；若用户明确指定了某个仓库文件路径，才额外调用 write_plan(path, content) 精确写到该路径。',
    '',
    '请按以下 Markdown 格式输出计划（严格遵循此结构，输出完整、可执行的真实计划，而非限制说明）：',
    '',
    '## 问题分析',
    '（对用户需求的理解和代码现状分析）',
    '',
    '## 涉及文件',
    '- `path/to/file1.ts`',
    '- `path/to/file2.ts`',
    '',
    '## 实施步骤',
    '1. **步骤标题**：详细描述...',
    '2. **步骤标题**：详细描述...',
    '',
    '## 验证方式',
    '（如何验证计划执行成功）',
    '',
    '## 风险点',
    '- 风险1：描述...',
    '- 风险2：描述...'
  ]
  if (ctx?.title) lines.push(`\n任务：${ctx.title}`)
  if (ctx?.description) lines.push(ctx.description)
  return lines.join('\n')
}

/** 计划轮次用户消息的委派标记（单独一行，供主会话识别本轮走委派而非自行作答）。 */
export const PLAN_REQUEST_MARK = '[计划模式]'

/**
 * 普通（非计划）模式下的「任务复杂度自检 + 主动建议出计划」提示（Chat 各 driver 共用）。
 *
 * 目标：让模型在正常作答后自行评估请求复杂度；若属较复杂任务，则在回复末尾
 * 主动附一句建议，引导用户回复“出个计划”等关键词以进入计划模式。
 * 与 `planModeInstruction` 同源，避免 openai / qoder 两个 driver 文案漂移。
 */
export function planSuggestionGuidance(): string {
  return [
    '【任务复杂度自检】在正常作答后，评估用户这次请求的复杂度：',
    '- 若属于简单问答、单点修改、解释澄清——不要提及计划，正常回答即可。',
    '- 若属于较复杂的任务（多步骤、跨多个仓库/目录、涉及架构或数据模型改造、大范围重构、需要拆解阶段与影响面），',
    '  则在回复的最末尾另起一行，用一句简短中文主动提议先生成一份开发计划，例如：',
    '  「💡 这个任务较复杂，建议先出一份开发计划梳理步骤与影响面。需要的话回复「出个计划」。」',
    `注意：这只是建议，不要擅自展开完整计划、也不要尝试写文件；把是否进入计划模式的决定权交给用户。`,
    `（以 ${PLAN_REQUEST_MARK} 开头的消息属计划轮次，按委派规则处理，不要再附这句建议。）`
  ].join('\n')
}

/** 给本轮用户消息打上委派标记（Qoder 常驻会话无法逐轮换 system prompt，只能随消息传递）。 */
export function markPlanRequest(text: string): string {
  return `${PLAN_REQUEST_MARK}\n${text}`
}

/**
 * 主链路的「委派规划」规则（常驻在 Chat 主会话系统提示里，不随 chatMode 变动）。
 *
 * 关键不变量：这条规则**不改变主会话的任何工具权限**——主会话该读读、该写写，
 * 只是遇到打了委派标记的那一轮，把规划工作交给 planner 子代理，自己转述结果。
 */
export function planDelegationInstruction(): string {
  return [
    '【规划委派】用户消息若以 ' + PLAN_REQUEST_MARK + ' 开头，本轮的规划工作不要自己展开：',
    `1. 调用 Agent 工具，subagent_type=${PLANNER_AGENT_NAME}，description 简述规划目标，prompt 交代用户的需求与需要覆盖的范围（原样转述用户本轮诉求，去掉标记行）。`,
    '2. 子代理返回完整 Markdown 计划后，把这份计划正文原样作为你的回复输出，不要压缩成摘要、不要改写成「已生成计划」这类回执。',
    '3. 若当前环境没有可用的 Agent 子代理工具，才自行按 planner 的只读方式产出计划。',
    '注意：标记只表示本轮走规划委派，不代表你失去任何工具权限；没有标记的轮次正常作答即可（包括直接改代码），无需继续停留在计划语境里。'
  ].join('\n')
}
