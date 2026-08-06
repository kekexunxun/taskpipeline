/**
 * Task Agent Driver 抽象层。
 *
 * 背景：
 *  原 `main.ts` 中 `runQoder` / `runQoderPlan` / `runQoderTestCases` 三个函数直接
 *  调 `@qoder-ai/qoder-agent-sdk` 的 `query()`,把会话管理、abort、prompt 拼装、
 *  阶段转换、状态机推进等所有逻辑都堆在 main.ts 里。任务执行是 Qoder-only 的,
 *  但抽象层摆在这里,后续如果接入别的 Agent 运行时不需要重写 main.ts。
 *
 * 设计：
 *  - `TaskAgentDriver` 暴露三个阶段方法 + collectResult,每个方法返回 `AsyncGenerator<TaskAgentEvent>`;
 *  - driver 内部管自己的 session / 子进程 / 资源;
 *  - `collectResult(phase)` 让任务工作流在 driver 完成后拿到阶段产物 (responseTexts / sessionId);
 *  - 上层 (main.ts) 只负责: 调 driver → 处理事件 → 调 collectResult → 继续任务工作流。
 *
 * 阶段:
 *  - plan: 只读分析,生成计划 JSON;
 *  - implementation: 接受计划,真正改文件 (permissionMode=acceptEdits);
 *  - test_generation: 在实现完成之后,生成最小测试集。
 */

import type { Task, TaskRepository } from "@coding-agent/core";

/** 当前支持的 task agent 运行时。 */
export type TaskAgentId = "qoder";

/** 任务执行阶段。driver 在事件里标注当前阶段。 */
export type TaskAgentPhase = "planning" | "implementation" | "test_generation";

/**
 * driver 推给上层的事件。main.ts 处理每个事件:
 *  - agent_start / agent_end: 切换 activeTaskId / 状态;
 *  - agent_text: 写入 task event (UI 显示);
 *  - agent_log: 写入 Qoder 日志文件;
 *  - agent_session: 持久化 sessionId 供后续续接;
 *  - agent_error: 写 error event + 推 failed。
 */
export type TaskAgentEvent =
  | { type: "agent_start"; phase: TaskAgentPhase }
  | { type: "agent_end"; phase: TaskAgentPhase }
  | { type: "agent_text"; phase: TaskAgentPhase; text: string }
  | { type: "agent_session"; sessionId: string }
  | { type: "agent_usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number; durationMs?: number; turns?: number }
  | { type: "agent_log"; message: unknown }
  | { type: "agent_error"; message: string };

/** 阶段产物 — driver 在 collectResult 时返回。 */
export type TaskAgentResult = {
  /** driver 在执行阶段累积的 assistant / result 文本。 */
  responseTexts: string[];
  /** Qoder SDK 输出的 session id (用于失败后续接)。 */
  sessionId?: string;
};

export type RunPlanInput = {
  task: Task;
  repos: TaskRepository[];
  signal?: AbortSignal;
  /** "修订计划" 路径下,把上一版计划的调整意见追加到 prompt。 */
  feedback?: string;
};

export type RunImplementationInput = {
  task: Task;
  repos: TaskRepository[];
  signal?: AbortSignal;
  /** 失败后续接:driver 用 resume 恢复原会话,避免重复注入完整上下文。 */
  resumeSessionId?: string;
  /** 续接时附加给 agent 的指令(实现阶段)。 */
  extraPrompt?: string;
};

export type RunTestGenerationInput = {
  task: Task;
  repos: TaskRepository[];
  signal?: AbortSignal;
};

/** TaskAgentDriver 构造时需要的依赖。 */
export type TaskAgentDeps = {
  /** 主流程注入的回调,driver 推事件(已经合并了 driver 内部缓冲)。 */
  emit: (event: TaskAgentEvent) => void;
  /** 任务级 model 覆盖(可选)。 */
  resolveModel?: (task: Task) => string | undefined;
  /** Qoder 提示词前置的记忆上下文(可选)。 */
  resolveMemoryContext?: (task: Task, repos: TaskRepository[]) => Promise<string | undefined>;
  /**
   * 按任务关联仓库解析的 Agent 指引段(可选)。
   * 非 resume 场景注入到 prompt 最前;resume(真实续接)时由调用方不提供。
   */
  resolveAgentContext?: (task: Task, repos: TaskRepository[]) => Promise<{ sections: string[] }>;
};

export interface TaskAgentDriver {
  readonly id: TaskAgentId;
  readonly displayName: string;
  /**
   * 执行"计划"阶段。driver 内部: 拼 prompt、起 query、解析 plan JSON。
   * 完成后通过 collectResult("plan") 拿到 responseTexts,主流程再 parsePlanDecision。
   */
  runPlan(input: RunPlanInput): Promise<void>;
  /**
   * 执行"实现"阶段。driver 内部: 拼 prompt、起 query (permissionMode=acceptEdits)、
   * 收集 assistant / result 文本、流式推到 emit。失败后续接走 resumeSessionId。
   */
  runImplementation(input: RunImplementationInput): Promise<void>;
  /**
   * 执行"测试用例生成"阶段。driver 内部: 拼 prompt (TEST_CASE_GENERATION_PROMPT)、
   * 跑完返回 parseTestCaseGeneration 的结果文本(在 responseTexts 里)。
   */
  runTestGeneration(input: RunTestGenerationInput): Promise<void>;
  /**
   * 取出 driver 内部累积的阶段产物。driver 内部按 (phase) 缓存最近一次 runXxx 的结果。
   * 主流程拿 responseTexts 去 parse 各种决策 JSON。
   */
  collectResult(phase: "plan" | "implementation" | "test"): TaskAgentResult;
  /** 释放 driver 持有的资源。 */
  dispose(): void;
}
