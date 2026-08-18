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
 * 计划模式的通用系统提示（Chat / Coding 共用）。
 *
 * Chat 路径：driver 注入到 system prompt，让 LLM 只读分析并输出 Markdown 格式计划。
 * Coding 路径：OpenAI `runOpenAIPlan` 等场景复用同一份提示，保证行为一致。
 *
 * @param ctx - 可选上下文；Coding 路径传入任务标题/描述，Chat 路径可省略
 */
export function planModeInstruction(ctx?: { title?: string; description?: string }): string {
  const lines = [
    '你处于只读计划模式。禁止修改文件、安装依赖或运行会改变工作区的命令。',
    '请分析用户的需求和代码，制定详细的实施计划。',
    '',
    '请按以下 Markdown 格式输出计划（严格遵循此结构）：',
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
