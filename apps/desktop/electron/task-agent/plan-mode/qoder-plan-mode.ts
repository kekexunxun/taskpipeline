import { accessToken, query, QoderCliProcessError, type Query } from '@qoder-ai/qoder-agent-sdk'
import type { ParsedPlan, PlanModeContext, PlanModeProvider, RunPlanOptions } from '@task-pipeline/core'
import { stripQoderModelPrefix } from '../qoder-task-agent.js'

/**
 * Qoder 端的 PlanModeProvider。
 *
 * 使用标准 qodercli plan 模式执行：
 *  - `permissionMode: "plan"` 让 qodercli 启用 EnterPlanMode/ExitPlanMode 工具
 *  - `settings: { general: { plan: { enabled: true } } }` 以"flag"源（最高优先级）
 *    显式覆盖用户 ~/.qodercli/settings.json 中可能存在的
 *    `general.plan.enabled=false`，避免 qodercli warn 后回退到 default
 *    导致行为不一致。
 */
export class QoderPlanModeProvider implements PlanModeProvider {
  readonly providerId = 'qoder' as const

  /** 计划阶段注入的 settings —— 显式启用 CLI plan 模式。 */
  private static readonly SETTINGS = {
    general: {
      plan: {
        enabled: true
      }
    }
  } as const

  constructor(
    private readonly qoderTokenProvider: () => string | undefined,
    private readonly resolveModel: (ctx: PlanModeContext) => string | undefined
  ) {}

  instruction(ctx: PlanModeContext): string {
    return [
      '请只读分析以下 Coding 任务。',
      `任务:${ctx.task.title}`,
      ctx.task.description,
      `验收标准:\n${ctx.task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
      ctx.feedback ? `上一次计划的调整意见:\n${ctx.feedback}` : '',
      '禁止修改文件,禁止执行安装、构建或其他会改变工作区的命令。',
      '最终只输出一个 JSON 对象,不要输出过程说明或 Markdown 代码块。若代码已满足要求,输出 {"outcome":"already_satisfied","summary":"判断依据和验证建议"};否则输出 {"outcome":"changes_required","plan":"完整实施计划,包含涉及文件、实施步骤、验证方式和风险"}。'
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  parseOutput(raw: string): ParsedPlan {
    const match = /\{[\s\S]*?"outcome"[\s\S]*?\}/.exec(raw)
    if (!match) return { outcome: 'unparsed', raw }
    try {
      const parsed = JSON.parse(match[0]) as { outcome?: string; summary?: string; plan?: string }
      if (parsed.outcome === 'already_satisfied' && typeof parsed.summary === 'string') {
        return { outcome: 'already_satisfied', summary: parsed.summary }
      }
      if (parsed.outcome === 'changes_required' && typeof parsed.plan === 'string') {
        return { outcome: 'changes_required', plan: parsed.plan }
      }
    } catch {
      /* fallthrough */
    }
    return { outcome: 'unparsed', raw }
  }

  /**
   * 调 SDK 跑计划阶段：以 `permissionMode: "plan"` + 显式注入 plan 开关
   * 走标准 CLI plan 模式（启用 EnterPlanMode/ExitPlanMode 工具）。等流结束，
   * 解析 plan 产出 ParsedPlan。
   */
  async runPlan(ctx: PlanModeContext, options: RunPlanOptions = {}): Promise<ParsedPlan> {
    const token = this.qoderTokenProvider()
    if (!token) throw new Error('请先配置 Qoder Token')
    const prompt = this.instruction(ctx)
    const model = options.model ?? this.resolveModel(ctx)

    const abort = new AbortController()
    const abortFromParent = () => abort.abort(options.signal?.reason)
    options.signal?.throwIfAborted()
    options.signal?.addEventListener('abort', abortFromParent, { once: true })

    const hardTimer = options.hardTimeoutMs
      ? setTimeout(() => abort.abort(new Error('plan 超时')), options.hardTimeoutMs)
      : undefined

    const q: Query = query({
      prompt,
      options: {
        auth: accessToken(token),
        cwd: options.cwd ?? process.cwd(),
        abortController: abort,
        includePartialMessages: false,
        permissionMode: 'plan',
        settings: QoderPlanModeProvider.SETTINGS,
        persistSession: true,
        ...(model ? { model: stripQoderModelPrefix(model) } : {})
      }
    })

    const texts: string[] = []
    try {
      try {
        for await (const message of q) {
          const text =
            (message as { result?: string }).result ??
            (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content
              ?.filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n') ??
            ''
          if (text) texts.push(text)
        }
      } catch (error) {
        // 跟 driver 一致:qodercli 进程非 0 退出(常见 exit 42)时,SDK 抛
        // QoderCliProcessError,把 stderr 拼到 message 一起抛,方便上层
        // 看到真正的失败原因。
        if (error instanceof QoderCliProcessError && error.stderr) {
          const tail = error.stderr.trim().slice(-2000)
          const enriched = new Error(`${error.message}\n\nqodercli stderr (tail):\n${tail}`)
          ;(enriched as Error & { cause?: unknown }).cause = error
          throw enriched
        }
        throw error
      }
    } finally {
      if (hardTimer) clearTimeout(hardTimer)
      options.signal?.removeEventListener('abort', abortFromParent)
      try {
        await q.close()
      } catch {
        /* ignore */
      }
    }
    return this.parseOutput(texts.join('\n').trim())
  }
}
