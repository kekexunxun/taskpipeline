/**
 * Qoder Task Agent Driver — TaskAgentDriver 的 Qoder SDK 实现。
 *
 * 职责(全部封在本文件内):
 *  - runPlan / runImplementation / runTestGeneration: 调 `@qoder-ai/qoder-agent-sdk` 的 `query()`,
 *    拼 prompt / 处理 for-await 循环 / 累积 responseTexts + sessionId;
 *  - emit `TaskAgentEvent` 给上层(agent_start / agent_text / agent_log / agent_session / agent_end);
 *  - collectResult(phase) 让调用方拿到累积的 `responseTexts / sessionId`。
 *
 * 不负责:任务工作流(状态机 / 计划 / 实现后续的校验、Review、MR) — 这些仍在 main.ts 里。
 * 上层 main.ts 调用 driver → 拿到 collectResult → 调 `parsePlanDecision` / `parseImplementationDecision`
 * / `parseTestCaseGeneration` 解析产物 → 走 taskWorkflow 推进状态。
 */

import { accessToken, query, type Query, type SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import type { HookCallback, HookEvent, HookJSONOutput } from "@qoder-ai/qoder-agent-sdk";
import type { Task, TaskRepository, TaskStore } from "@coding-agent/core";
import { implementationOutcomeInstruction } from "../task-readiness.js";
import type { TaskAgentDriver, TaskAgentDeps, TaskAgentEvent, TaskAgentResult, TaskAgentPhase, RunPlanInput, RunImplementationInput, RunTestGenerationInput } from "./task-agent-driver.js";
import { logQoderMessage, qoderLogFile, qoderText, recordQoderMessage, closeQoderQuerySafely } from "./log.js";

/**
 * Driver 注入的依赖(由 main.ts 在构造时传入,driver 不 import 顶层常量)。
 *
 * - `qoderTokenProvider`: 每次 run 都会重新拿一次 token(用户可在系统设置里改 qoderToken);
 * - `dataDir`: 日志根目录;
 * - `addTaskEvent`: 写任务事件;
 * - `emitPi`: emit qoder_event 给前端。
 */
export type QoderTaskAgentDeps = TaskAgentDeps & {
  store: TaskStore;
  qoderTokenProvider: () => string | undefined;
  dataDir: string;
  addTaskEvent: (event: { taskId: string; kind: "message" | "status" | "error"; title: string; detail?: string }) => void;
  emitPi: (event: { type: "qoder_event"; taskId: string; message: SDKMessage }) => void;
  /** 切换 driver 时给上层信号,让 main.ts 把 activeQoderQuery 状态清掉。 */
  onQueryStarted?: (query: Query, abort: AbortController) => void;
  onQueryFinished?: (query: Query) => void;
  /**
   * Phase 2 HITL：工具调用确认回调。
   * 返回 "allow" 放行该工具调用，返回 "deny" 拒绝（SDK 会把拒绝消息反馈给 agent，让它换方案）。
   * `signal` 为 SDK 传入的会话中止信号：任务被 abort 时确认框应立刻按拒绝处理。
   * 未注入时所有 PermissionRequest hook 直接放行（保持原行为）。
   */
  onPermissionRequest?: (taskId: string, toolName: string, toolInput: unknown, signal?: AbortSignal) => Promise<"allow" | "deny">;
  /**
   * 测试用例生成阶段的 Agent 上下文（角色定义 + 领域指引）。
   * 存在时优先使用，回退现有 resolveAgentContext。
   */
  resolveTestContext?: (task: Task, repos: TaskRepository[]) => Promise<{ sections: string[] }>;
};

const TEST_CASE_GENERATION_PROMPT = [
  "你是一个测试用例生成 Agent，专为当前 Coding 任务生成最小测试集。",
  "硬性约束：",
  "1. 不得修改任何业务逻辑文件、不得重构、不得调整非测试相关的配置。",
  "2. 仅为本次改动产出可被现有 testCommand 跑通的最小测试集（单元测试为主，必要时一个集成测试）。",
  "3. 若现有 testCommand 不存在或无法识别测试文件，请按仓库常见约定新增。",
  "4. 所有新增文件必须以 _test.* / .test.* / .spec.* 结尾，并放到合理的测试目录。",
  "5. 完成后请把测试相关的修改 commit 到当前 feature 分支（一个 commit 即可），commit message 形如 `test: <简短说明>`。",
  "",
  "请在最后输出一个 JSON 对象（不要输出额外说明）：",
  "{\"files\":[\"path/to/test1\", \"path/to/test2\"], \"commitSha\":\"<短 sha 或全 sha>\", \"summary\":\"<一句话概述>\"}",
  "若没有任何可测试的逻辑面，输出 {\"files\":[], \"summary\":\"<解释原因>\"}。"
].join("\n");

const PLAN_TIMEOUT_MS = 5 * 60_000;

type PhaseBuffers = {
  responseTexts: string[];
  sessionId?: string;
};

/**
 * Qoder Task Agent Driver。
 */
export class QoderTaskAgentDriver implements TaskAgentDriver {
  readonly id = "qoder" as const;
  readonly displayName = "Qoder Agent SDK";

  private readonly buffers = new Map<TaskAgentPhase, PhaseBuffers>();

  constructor(private readonly deps: QoderTaskAgentDeps) {
    if (!deps) throw new Error("QoderTaskAgentDriver requires deps");
    if (!deps.qoderTokenProvider) throw new Error("QoderTaskAgentDriver requires qoderTokenProvider");
  }

  async runPlan(input: RunPlanInput): Promise<void> {
    const { task, repos, signal, feedback } = input;
    const buffers: PhaseBuffers = { responseTexts: [] };
    this.buffers.set("planning", buffers);

    const [agentContext, memoryContext] = await Promise.all([
      this.deps.resolveAgentContext?.(task, repos),
      this.deps.resolveMemoryContext?.(task, repos)
    ]);
    const prompt = [
      ...(agentContext?.sections ?? []),
      memoryContext ?? "",
      "请只读分析以下 Coding 任务。",
      `任务:${task.title}`,
      task.description,
      `验收标准:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      feedback ? `上一次计划的调整意见:\n${feedback}` : "",
      "禁止修改文件，禁止执行安装、构建或其他会改变工作区的命令。",
      "最终只输出一个 JSON 对象，不要输出过程说明或 Markdown 代码块。若代码已满足要求，输出 {\"outcome\":\"already_satisfied\",\"summary\":\"判断依据和验证建议\"}；否则输出 {\"outcome\":\"changes_required\",\"plan\":\"完整实施计划，包含涉及文件、实施步骤、验证方式和风险\"}。"
    ].filter(Boolean).join("\n\n");

    await this.runQuery({
      phase: "planning",
      task,
      repos,
      prompt,
      model: this.deps.resolveModel?.(task),
      signal,
      permissionMode: "plan",
      persistSession: true,
      buffers,
      recordText: false,
      hardTimeoutMs: PLAN_TIMEOUT_MS
    });
  }

  async runImplementation(input: RunImplementationInput): Promise<void> {
    const { task, repos, signal, resumeSessionId, extraPrompt } = input;
    const buffers: PhaseBuffers = { responseTexts: [] };
    this.buffers.set("implementation", buffers);

    // resume 走 Qoder 真实续接：会话上下文已包含原 Agent 指引，不重新拼（与 memoryContext 一致）。
    const [agentContext, memoryContext] = resumeSessionId
      ? [undefined, undefined]
      : await Promise.all([
          this.deps.resolveAgentContext?.(task, repos),
          this.deps.resolveMemoryContext?.(task, repos)
        ]);
    const prompt = resumeSessionId
      ? (extraPrompt ?? "任务此前执行失败/中断，请基于当前会话上下文继续完成剩余工作。")
      : [
          ...(agentContext?.sections ?? []),
          memoryContext ?? "",
          task.title,
          task.description,
          task.planContent ? `Approved implementation plan:\n${task.planContent}` : "",
          `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
          extraPrompt ? `Additional request:\n${extraPrompt}` : "",
          implementationOutcomeInstruction
        ].filter(Boolean).join("\n\n");
    if (resumeSessionId) buffers.sessionId = resumeSessionId;

    await this.runQuery({
      phase: "implementation",
      task,
      repos,
      prompt,
      model: this.deps.resolveModel?.(task),
      signal,
      permissionMode: "acceptEdits",
      persistSession: true,
      resumeSessionId,
      buffers,
      recordText: true
    });
  }

  async runTestGeneration(input: RunTestGenerationInput): Promise<void> {
    const { task, repos, signal } = input;
    const buffers: PhaseBuffers = { responseTexts: [] };
    this.buffers.set("test_generation", buffers);
  
    // 优先使用角色 Agent 的测试上下文（角色定义 + 领域指引），回退通用 resolveAgentContext
    const agentContext = this.deps.resolveTestContext
      ? await this.deps.resolveTestContext(task, repos)
      : await this.deps.resolveAgentContext?.(task, repos);
    const prompt = [
      ...(agentContext?.sections ?? []),
      task.title,
      task.description,
      task.planContent ? `Approved implementation plan:\n${task.planContent}` : "",
      TEST_CASE_GENERATION_PROMPT
    ].filter(Boolean).join("\n\n");
  
    await this.runQuery({
      phase: "test_generation",
      task,
      repos,
      prompt,
      model: this.deps.resolveModel?.(task),
      signal,
      permissionMode: "acceptEdits",
      persistSession: true,
      buffers,
      recordText: true
    });
  }

  collectResult(phase: "plan" | "implementation" | "test"): TaskAgentResult {
    const phaseKey: TaskAgentPhase = phase === "plan" ? "planning" : phase === "test" ? "test_generation" : "implementation";
    const buffers = this.buffers.get(phaseKey);
    return {
      responseTexts: buffers?.responseTexts ? [...buffers.responseTexts] : [],
      ...(buffers?.sessionId ? { sessionId: buffers.sessionId } : {})
    };
  }

  dispose(): void { /* driver 不持有长期资源 */ }

  // === 内部实现 =============================================================

  private emit(event: TaskAgentEvent): void { this.deps.emit(event); }

  private async runQuery(options: {
    phase: TaskAgentPhase;
    task: Task;
    repos: TaskRepository[];
    prompt: string;
    model?: string;
    signal?: AbortSignal;
    permissionMode: "default" | "plan" | "acceptEdits";
    persistSession: boolean;
    resumeSessionId?: string;
    buffers: PhaseBuffers;
    recordText: boolean;
    hardTimeoutMs?: number;
  }): Promise<void> {
    const { phase, task, repos, prompt, model, signal, permissionMode, persistSession, resumeSessionId, buffers, recordText, hardTimeoutMs } = options;
    if (repos.length === 0) throw new Error("任务未关联代码仓库");
    const primary = repos[0]!;

    const abort = new AbortController();
    const abortFromParent = () => abort.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abortFromParent, { once: true });

    const token = this.deps.qoderTokenProvider();
    if (!token) throw new Error("请先配置 Qoder Token");
    // Phase 2 HITL：PermissionRequest hook —— 危险工具由上层（main.ts）弹 UI 确认，
    // 其余直接 allow，保持 acceptEdits 的流畅节奏。
    const permissionHooks = this.deps.onPermissionRequest
      ? ({
          PermissionRequest: [{
            hooks: [async (input: Parameters<HookCallback>[0], _toolUseID?: string, options?: { signal: AbortSignal }): Promise<HookJSONOutput> => {
              if (input.hook_event_name !== "PermissionRequest") return { hookEventName: "PermissionRequest", decision: { behavior: "allow" } };
              const decision = await this.deps.onPermissionRequest!(task.id, input.tool_name, input.tool_input, options?.signal);
              return decision === "deny"
                ? { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "用户拒绝了此操作，请改用其他方案", interrupt: false } }
                : { hookEventName: "PermissionRequest", decision: { behavior: "allow" } };
            }]
          }]
        } satisfies Partial<Record<HookEvent, { hooks: HookCallback[] }>>)
      : undefined;
    const q = query({
      prompt,
      options: {
        auth: accessToken(token),
        cwd: primary.worktreePath ?? primary.localPath,
        additionalDirectories: repos.slice(1).map((repo) => repo.worktreePath ?? repo.localPath),
        abortController: abort,
        includePartialMessages: true,
        permissionMode,
        persistSession,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(model ? { model } : {}),
        ...(permissionHooks ? { hooks: permissionHooks } : {})
      }
    });
    this.deps.onQueryStarted?.(q, abort);

    const logFile = qoderLogFile(this.deps.dataDir, task.id);
    this.emit({ type: "agent_start", phase });
    if (logFile && phase === "implementation") {
      try {
        logQoderMessage(logFile, { t: new Date().toISOString(), kind: "meta", taskId: task.id, prompt, options: { cwd: primary.worktreePath ?? primary.localPath, model, resume: resumeSessionId } } as unknown as SDKMessage);
      } catch { /* 忽略 */ }
    }

    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const hardTimeout = hardTimeoutMs
      ? new Promise<never>((_, reject) => {
        hardTimer = setTimeout(() => reject(new Error(`计划生成超时(>${hardTimeoutMs / 1000}s)，已强制中止当前 query`)), hardTimeoutMs);
      })
      : undefined;
    try {
      const loop = (async () => {
        for await (const message of q) {
          logQoderMessage(logFile, message);
          const sid = (message as { session_id?: string }).session_id;
          if (sid) buffers.sessionId = sid;
          const text = qoderText(message);
          if ((message.type === "assistant" || message.type === "result") && text) {
            buffers.responseTexts.push(text);
            this.emit({ type: "agent_text", phase, text });
          }
          recordQoderMessage(this.deps.store, task.id, message, {
            recordText,
            addTaskEvent: this.deps.addTaskEvent,
            emitPi: this.deps.emitPi
          });
        }
      })();
      if (hardTimeout) await Promise.race([loop, hardTimeout]);
      else await loop;
    } catch (error) {
      abort.abort();
      await closeQoderQuerySafely(q, 5_000).catch(() => undefined);
      this.deps.onQueryFinished?.(q);
      signal?.removeEventListener("abort", abortFromParent);
      if (hardTimer) clearTimeout(hardTimer);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortFromParent);
      if (hardTimer) clearTimeout(hardTimer);
    }
    this.deps.onQueryFinished?.(q);
    this.emit({ type: "agent_end", phase });
  }
}
