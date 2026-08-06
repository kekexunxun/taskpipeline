import { accessToken, query, type Query } from "@qoder-ai/qoder-agent-sdk";
import type {
  ParsedPlan,
  PlanModeContext,
  PlanModeProvider,
  RunPlanOptions
} from "@coding-agent/core";

/**
 * Qoder 端的 PlanModeProvider。
 *
 * 真正的"硬约束"在 `QoderTaskAgentDriver.runQuery` 里通过 `permissionMode: "plan"`
 * 给到 SDK options(已经写对)。provider 这层负责"以统一接口包住 SDK 调用 +
 * 解析 plan",便于上层(`task-start`、其它调用方)直接拿 ParsedPlan。
 */
export class QoderPlanModeProvider implements PlanModeProvider {
  readonly providerId = "qoder" as const;

  constructor(
    private readonly qoderTokenProvider: () => string | undefined,
    private readonly resolveModel: (ctx: PlanModeContext) => string | undefined
  ) {}

  instruction(ctx: PlanModeContext): string {
    return [
      "请只读分析以下 Coding 任务。",
      `任务:${ctx.task.title}`,
      ctx.task.description,
      `验收标准:\n${ctx.task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      ctx.feedback ? `上一次计划的调整意见:\n${ctx.feedback}` : "",
      "禁止修改文件,禁止执行安装、构建或其他会改变工作区的命令。",
      "最终只输出一个 JSON 对象,不要输出过程说明或 Markdown 代码块。若代码已满足要求,输出 {\"outcome\":\"already_satisfied\",\"summary\":\"判断依据和验证建议\"};否则输出 {\"outcome\":\"changes_required\",\"plan\":\"完整实施计划,包含涉及文件、实施步骤、验证方式和风险\"}。"
    ].filter(Boolean).join("\n\n");
  }

  parseOutput(raw: string): ParsedPlan {
    const match = /\{[\s\S]*?"outcome"[\s\S]*?\}/.exec(raw);
    if (!match) return { outcome: "unparsed", raw };
    try {
      const parsed = JSON.parse(match[0]) as { outcome?: string; summary?: string; plan?: string };
      if (parsed.outcome === "already_satisfied" && typeof parsed.summary === "string") {
        return { outcome: "already_satisfied", summary: parsed.summary };
      }
      if (parsed.outcome === "changes_required" && typeof parsed.plan === "string") {
        return { outcome: "changes_required", plan: parsed.plan };
      }
    } catch {
      /* fallthrough */
    }
    return { outcome: "unparsed", raw };
  }

  /**
   * 复用 `QoderTaskAgentDriver.runQuery` 的核心逻辑:用 `permissionMode: "plan"`
   * 调 SDK,等 SDK 流结束,拼出 responseTexts。本质上是"把 driver 中
   * "just for the plan phase"的那段抽出来,以 provider 身份暴露。
   */
  async runPlan(ctx: PlanModeContext, options: RunPlanOptions = {}): Promise<ParsedPlan> {
    const token = this.qoderTokenProvider();
    if (!token) throw new Error("请先配置 Qoder Token");
    const prompt = this.instruction(ctx);
    const model = options.model ?? this.resolveModel(ctx);

    const abort = new AbortController();
    const abortFromParent = () => abort.abort(options.signal?.reason);
    options.signal?.throwIfAborted();
    options.signal?.addEventListener("abort", abortFromParent, { once: true });

    const hardTimer = options.hardTimeoutMs
      ? setTimeout(() => abort.abort(new Error("plan 超时")), options.hardTimeoutMs)
      : undefined;

    const q: Query = query({
      prompt,
      options: {
        auth: accessToken(token),
        cwd: options.cwd ?? process.cwd(),
        abortController: abort,
        includePartialMessages: false,
        permissionMode: "plan",
        persistSession: true,
        ...(model ? { model } : {})
      }
    });

    const texts: string[] = [];
    try {
      for await (const message of q) {
        const text = (message as { result?: string }).result
          ?? (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content
            ?.filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n")
          ?? "";
        if (text) texts.push(text);
      }
    } finally {
      if (hardTimer) clearTimeout(hardTimer);
      options.signal?.removeEventListener("abort", abortFromParent);
      try {
        await q.close();
      } catch {
        /* ignore */
      }
    }
    return this.parseOutput(texts.join("\n").trim());
  }
}
