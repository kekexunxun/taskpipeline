import type { Task, TaskEventSink, TaskRepository, SettingResolver } from "@task-pipeline/core";
import { blockingSeveritiesFor } from "@task-pipeline/core";
import type { GitService } from "./git.js";
import type { OpenCodeReviewService } from "./review.js";
import { extractFirstJsonObject, type ReviewResult } from "./review.js";
import { redactSecrets } from "./process.js";

/** 去掉 model value 上的 `openai:` provider 前缀,让 /chat/completions 能识别真实模型名。 */
function stripOpenAIModelPrefix(model: string | undefined): string | undefined {
  if (!model) return undefined
  return model.startsWith('openai:') ? model.slice('openai:'.length) : model
}

/**
 * 读取默认 OpenAI-Compatible 配置（供系统级调用使用）。
 * - 新格式 `modelProfiles`（数组）：isDefault 优先，否则第一个；
 * - 兼容旧格式 `modelProfile`（单个对象）。
 */
function readDefaultOpenAIProfile(resolver: SettingResolver): { id?: string; baseUrl: string; model: string; apiKeyEnv?: string; isDefault?: boolean } | undefined {
  const raw = resolver.get('modelProfiles')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const profiles = parsed.filter(
          (item): item is { id?: string; baseUrl: string; model: string; apiKeyEnv?: string; isDefault?: boolean } =>
            Boolean(item) && typeof item === 'object' && typeof (item as { baseUrl?: unknown }).baseUrl === 'string'
        )
        const profile = profiles.find((p) => p.isDefault) ?? profiles[0]
        if (profile?.baseUrl && profile.model) return profile
      }
    } catch {
      /* 忽略脏数据，走旧格式兼容 */
    }
  }
  const legacy = resolver.get('modelProfile')
  if (!legacy) return undefined
  try {
    const profile = JSON.parse(legacy) as { id?: string; baseUrl?: string; model?: string; apiKeyEnv?: string }
    if (profile.baseUrl && profile.model) return { ...profile, isDefault: true } as { id?: string; baseUrl: string; model: string; apiKeyEnv?: string; isDefault?: boolean }
  } catch {
    /* 忽略历史脏数据 */
  }
  return undefined
}

/**
 * 委托模式 review 的输入。
 * - repo:仓库名,用于 prompt 上下文。
 * - task:任务标题。
 * - files:相对 worktree 的变更文件路径列表。
 * - rules:从 `ocr delegate rule` 拿到的 markdown 规则。
 * - diff:完整 diff 文本,调用方负责先 redact 敏感信息。
 */
export type DelegateReviewerInput = {
  repo: string;
  task: string;
  files: string[];
  rules: string;
  diff: string;
};

/**
 * LLM 调用方接口。
 * Qoder 走 SDK,OpenAI 兼容走 fetch,都实现这个接口。
 * 返回 LLM 的原始文本响应(parseReviewResult 再做 JSON 提取)。
 *
 * 用 interface 而非 type 是为了 `implements` 校验时,
 * class 里的 `call` 方法签名能直接匹配(避免 method vs property 推断差异)。
 */
export interface Reviewer {
  call(input: DelegateReviewerInput, taskId: string, model?: string, signal?: AbortSignal, prompt?: string): Promise<string>;
}

export type ReviewerFunction = (input: DelegateReviewerInput, taskId: string, model?: string, signal?: AbortSignal, prompt?: string) => Promise<string>;

/**
 * 把一个 function 适配成 `Reviewer` 接口,
 * 便于宿主直接传入 lambda(例如 Qoder reviewer)。
 */
export function asReviewer(fn: ReviewerFunction): Reviewer { return { call: (input, taskId, model, signal, prompt) => fn(input, taskId, model, signal, prompt) }; }

/**
 * 把 DelegateReviewerInput 渲染成 LLM 提示词。
 * 沿用 desktop 原版,字段、顺序、文案不变,确保 timeline / 测试断言一致。
 */
export function buildReviewPrompt(input: DelegateReviewerInput): string {
  return [
    "You are a code reviewer. Follow the rules below as a checklist.",
    "Review the diff carefully. Report only actionable findings.",
    "Severity: critical (data loss / security / crash) | high (bug) | medium (perf / missing error handling) | low (style).",
    "Drop low unless genuinely valuable.",
    "",
    `Repository: ${input.repo}`,
    `Task: ${input.task}`,
    `Changed files: ${input.files.join(", ")}`,
    "",
    "## Review rules (from ocr)",
    input.rules || "(no rule.json configured, apply general code review heuristics)",
    "",
    "## Diff",
    "```diff",
    input.diff,
    "```",
    "",
    "Respond with strict JSON only (no prose, no code fence). Write each `message` value in Chinese (zh-CN):",
    '{"status":"completed","comments":[{"path":"...","line":<number|null>,"severity":"critical|high|medium|low","message":"..."}],"summary":{"files":<number>,"comments":<number>}}'
  ].join("\n");
}

/**
 * 解析 LLM 文本响应为 ReviewResult。
 * 优先提取 ```json``` code fence 或裸 JSON 里的第一个完整对象,失败时抛错。
 */
export function parseReviewResult(text: string): ReviewResult {
  const trimmed = text.trim();
  let json = "";
  try {
    json = extractFirstJsonObject(trimmed);
  } catch (extractError) {
    throw new Error(`LLM 审查响应中找不到 JSON 对象: ${(extractError as Error).message}; 原始输出前 1000 字符: ${trimmed.slice(0, 1000)}`);
  }
  try {
    const parsed = JSON.parse(json) as ReviewResult;
    return {
      status: typeof parsed.status === "string" ? parsed.status : "completed",
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      summary: parsed.summary,
      warnings: parsed.warnings,
      session_id: parsed.session_id
    };
  } catch (error) {
    throw new Error(`LLM 审查响应不是合法 JSON: ${(error as Error).message}; 提取到的 JSON 前 1000 字符: ${json.slice(0, 1000)}; 原始输出前 1000 字符: ${trimmed.slice(0, 1000)}`);
  }
}

/**
 * OpenAI 兼容 `/chat/completions` 模式的 Reviewer。
 * - 从 setting 读 modelProfile(baseUrl / model / apiKeyEnv)。
 * - 内置 3 分钟超时控制,主动 abort。
 * - 不依赖 Qoder SDK,可被 desktop 与 pi-package 同时使用。
 */
export class OpenAICompatReviewer implements Reviewer {
  constructor(private readonly resolver: SettingResolver, private readonly timeoutMs: number = 3 * 60_000, private readonly fetcher: typeof fetch = fetch) {}
  call = async (input: DelegateReviewerInput, _taskId: string, model?: string, externalSignal?: AbortSignal, prompt?: string): Promise<string> => {
    const profile = readDefaultOpenAIProfile(this.resolver);
    if (!profile) throw new Error("未配置 OpenAI-Compatible 模型,无法在 OpenAI 兼容模式下做委托 Review");
    const scoped = profile.id ? this.resolver.getSecret(`modelApiKey:${profile.id}`) : undefined;
    const apiKey =
      (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined) ??
      scoped ??
      (profile.isDefault || !profile.id ? this.resolver.getSecret("modelApiKey") : undefined);
    if (!apiKey) throw new Error("未配置 modelApiKey 或 apiKeyEnv");
    const url = `${profile.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`OpenAI 兼容 Review 在 ${this.timeoutMs / 1000}s 内未返回,主动 abort`)), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        signal: externalSignal ? AbortSignal.any([abort.signal, externalSignal]) : abort.signal,
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          // model 可能来自 ChatModelSelector 的 value（`openai:<model>` / 历史 `openai:default`），
          // 必须剥离 `openai:` 前缀，否则 /chat/completions 会收到非法模型名。
          model: stripOpenAIModelPrefix(model) ?? profile.model,
          messages: [{ role: "user", content: prompt ?? buildReviewPrompt(input) }],
          response_format: { type: "json_object" },
          temperature: 0
        })
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI 兼容 Review 请求失败 ${response.status}: ${errText.slice(0, 300)}`);
      }
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface ReviewOrchestratorOptions {
  ocr: OpenCodeReviewService;
  git: GitService;
  reviewer: Reviewer;
  /** 阻断级别,默认 "high"。 */
  reviewBlockingLevel?: "critical" | "high" | "medium";
}

/**
 * Review 委托模式编排器。
 *
 * 流程(对应每个 status 事件,便于 timeline 观测):
 *  1. review 启动
 *  2. 取变更文件列表(`git diff <base>...HEAD` + working tree 状态)
 *  3. 文件为空 → 直接返回空结果(评审通过)
 *  4. 取 diff(`git diff <base>`),失败时返回空结果(不阻断)
 *  5. diff 为空 → 返回空结果
 *  6. 调 `ocr delegate rule` 拿规则,失败时继续走默认规则
 *  7. redact 敏感信息后调 LLM(`Reviewer.call`)
 *  8. 解析响应为 ReviewResult(由调用方走 `parseReviewResult`)
 *
 * 异常会向上抛,由 `TaskWorkflow.runReview` 统一处理(回 review_blocked)。
 */
export class ReviewOrchestrator {
  private readonly blockingSeverities: string[];
  constructor(private readonly opts: ReviewOrchestratorOptions, private readonly sink: TaskEventSink) {
    this.blockingSeverities = blockingSeveritiesFor(opts.reviewBlockingLevel);
  }

  /**
   * 判断给定的 review comment 是否触发"阻断"。
   * 暴露为公开方法,便于在 `TaskWorkflow.runReview` 末尾复用同一套规则。
   */
  isBlockingComment(comment: { severity?: unknown }): boolean {
    return this.blockingSeverities.includes(String(comment.severity ?? "").toLowerCase());
  }

  /**
   * 判断给定的 review 响应是否触发"阻断"(包含任一阻断级别 comment)。
   * 便捷方法,语义与 isBlockingComment 互补。
   */
  hasBlocking(result: { comments: Array<{ severity?: unknown }> }): boolean {
    return result.comments.some((comment) => this.isBlockingComment(comment));
  }

  async run(task: Task, repo: TaskRepository, signal?: AbortSignal): Promise<ReviewResult> {
    signal?.throwIfAborted();
    this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: review 启动` });
    const ocr = this.opts.ocr;
    const worktree = repo.worktreePath ?? repo.localPath;
    const git = this.opts.git;
    this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: 取变更文件列表 (base=${repo.baseBranch})` });
    const files = (await git.changedFiles(worktree, repo.baseBranch, signal)).map((f) => f.path);
    if (files.length === 0) {
      this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: 无可审查变更` });
      return { status: "completed", comments: [], summary: { files: 0, comments: 0 } };
    }
    this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: 找到 ${files.length} 个变更文件,取 diff` });
    let diff = "";
    try {
      // 用 `<base>`(单 ref)而不是 `<base>...HEAD` 三点模式:
      // 三点模式只对比 commit,会漏掉 AI 实现阶段还没 commit 的工作区修改。
      // 单 ref 模式 `git diff <base>` 会把 working tree 相对 base 的所有差异都算进来。
      diff = await git.diffRange(worktree, repo.baseBranch, files, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: 未能取到 diff`, detail: error instanceof Error ? error.message : String(error) });
      return { status: "completed", comments: [], summary: { files: files.length, comments: 0 } };
    }
    if (diff.length === 0) {
      this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: diff 为空 (worktree 没有相对 ${repo.baseBranch} 的提交变更),跳过 LLM`, detail: "如果预期应该有 diff,先在 worktree 里 commit 或 push 再重试 review" });
      return { status: "completed", comments: [], summary: { files: files.length, comments: 0 } };
    }
    this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: diff 长度 ${diff.length} 字符,调用 ocr delegate rule` });
    let rules = "";
    try {
      rules = await ocr.rule(worktree, files, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: ocr rule 调用失败,继续走默认规则`, detail: error instanceof Error ? error.message : String(error) });
    }
    const redacted = redactSecrets(diff);
    this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: 调用 LLM 审查` });
    try {
      signal?.throwIfAborted();
      const text = await this.opts.reviewer.call({ repo: repo.name, task: task.title, files, rules, diff: redacted }, task.id, task.qoderModel, signal);
      this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: LLM 审查返回` });
      return parseReviewResult(text);
    } catch (error) {
      this.sink.addEvent({ taskId: task.id, kind: "status", title: `${repo.name}: LLM 审查失败` });
      throw error;
    }
  }
}
