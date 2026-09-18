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
 *  - `TaskAgentDriver` 暴露核心阶段方法 + collectResult,每个方法返回 `AsyncGenerator<TaskAgentEvent>`;
 *  - driver 内部管自己的 session / 子进程 / 资源;
 *  - `collectResult(phase)` 让任务工作流在 driver 完成后拿到阶段产物 (responseTexts / sessionId);
 *  - 上层 (main.ts) 只负责: 调 driver → 处理事件 → 调 collectResult → 继续任务工作流。
 *
 * 阶段:
 *  - plan: 只读分析,生成计划 JSON;
 *  - implementation: 接受计划,真正改文件 (permissionMode=acceptEdits);
 *  - test_generation: (可选) 在实现完成之后,由配置开关控制是否生成最小测试集。
 */

import type { Task, TaskRepository } from '@task-pipeline/core'
import type { ToolDeclaration } from '../../chat/drivers/tool-source.js'

/** 当前支持的 task agent 运行时。 */
export type TaskAgentId = 'qoder'

/** 任务执行阶段。driver 在事件里标注当前阶段。 */
export type TaskAgentPhase = 'planning' | 'implementation' | 'test_generation'

/**
 * driver 推给上层的事件。main.ts 处理每个事件:
 *  - agent_start / agent_end: 阶段边界（Trace / 渲染层切段）;
 *  - agent_text: 写入 task event (UI 显示);
 *  - agent_log: 写入 Qoder 日志文件;
 *  - agent_session: 持久化 sessionId 供后续续接;
 *  - agent_error: 写 error event + 推 failed。
 *
 * 每个事件都自带 `taskId`（P3）：此前靠 main.ts 的全局 activeTaskId 归因，
 * 两个任务并行时事件会串到别人的 Timeline / 会话指针上。
 */
export type TaskAgentEvent =
  | { type: 'agent_start'; taskId: string; phase: TaskAgentPhase }
  | { type: 'agent_end'; taskId: string; phase: TaskAgentPhase }
  | { type: 'agent_text'; taskId: string; phase: TaskAgentPhase; text: string }
  | { type: 'agent_session'; taskId: string; sessionId: string }
  | {
      type: 'agent_usage'
      taskId: string
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      costUsd?: number
      durationMs?: number
      turns?: number
    }
  | { type: 'agent_log'; taskId: string; message: unknown }
  | { type: 'agent_error'; taskId: string; message: string }

/** 阶段产物 —— `runStage` 的返回值（旧 `collectResult` 仍保留为只读访问器）。 */
export type TaskAgentResult = {
  /** driver 在执行阶段累积的 assistant / result 文本。 */
  responseTexts: string[]
  /** 本阶段实例的会话 id（Qoder sessionId / Pi sessionFile），用于失败后续接与对账。 */
  sessionId?: string
  /** 本阶段实际使用的阶段实例 id（一个阶段实例 = 一个会话）。 */
  stageInstanceId?: string
  /** driver 实际采用的会话启动方式（new/continue/resume/fork），降级后以最后一档为准。 */
  sessionMode?: 'new' | 'continue' | 'resume' | 'fork'
}

/**
 * driver 能力声明（§6）：编排层据此选降级链，不再靠「调一下看它 throw」协商。
 *
 * - `fork`：阶段边界能从一个会话分叉出新会话（阶段边界 = 会话边界）；
 * - `truncateAt`：fork 时能把继承范围截断到指定条目（Qoder `resumeSessionAt` / Pi `createBranchedSession(leafId)`）；
 * - `perPhasePermission`：能否按阶段实例给不同工具权限（Plan 只读 / Exec 可写）。
 */
export type TaskAgentCapabilities = {
  fork: boolean
  truncateAt: boolean
  perPhasePermission: boolean
}

/**
 * 一次「按阶段实例执行」的入参：三个旧 `runPlan/runImplementation/runTestGeneration`
 * 的并集，字段按阶段取用（多余的字段对不相关阶段就是缺省）。
 */
export type TaskStageInput = {
  task: Task
  repos: TaskRepository[]
  phase: TaskAgentPhase
  signal?: AbortSignal
  /** "修订计划" 路径下，把上一版计划的调整意见追加到 prompt。 */
  feedback?: string
  /** 失败后续接：driver 用 resume 恢复原会话，避免重复注入完整上下文。 */
  resumeSessionId?: string
  /** 续接时附加给 agent 的指令（实现阶段）。 */
  extraPrompt?: string
  /** 恢复/续接标记：resumeTask/resumePausedTask 传 'resume'，sendTaskMessage 追加指令传 'followup'。 */
  trigger?: 'resume' | 'followup'
  /** auto-fix 重跑轮次（reviewFixCount）：渲染层据此区分 Exec / ReExec #n。 */
  round?: number
}

/** TaskAgentDriver 构造时需要的依赖。 */
export type TaskAgentDeps = {
  /** 主流程注入的回调,driver 推事件(已经合并了 driver 内部缓冲)。 */
  emit: (event: TaskAgentEvent) => void
  /** 任务级 model 覆盖(可选)。 */
  resolveModel?: (task: Task) => string | undefined
  /**
   * 任务会话创建时注册的 `search_memory` 工具声明列表(可选)。
   * 不再像旧 `resolveMemoryContext` 那样在任务启动前无条件检索并拼进 prompt —— scope
   * (userId / repositoryIds / conversationId) 由调用方在闭包里绑定,模型自主决定何时调用。
   */
  resolveMemoryTools?: (task: Task, repos: TaskRepository[]) => ToolDeclaration[]
  /**
   * 按任务关联仓库解析的 Agent 指引段(可选)。
   * 非 resume 场景注入到 prompt 最前;resume(真实续接)时由调用方不提供。
   */
  resolveAgentContext?: (task: Task, repos: TaskRepository[]) => Promise<{ sections: string[] }>
}

/**
 * 任务阶段运行时的统一契约（§6）。
 *
 * Qoder 与 Pi 两条运行时都必须实现它：阶段边界、产物交接、降级与权限的差异
 * 全部由 `capabilities()` + `runStage` 内部承担，编排层不再写 `provider === 'qoder'` 分支。
 */
export interface TaskAgentDriver {
  readonly id: TaskAgentId
  readonly displayName: string
  /** driver 支持到哪一步（不支持 fork 的运行时会被编排层降为「同任务单会话」）。 */
  capabilities(): TaskAgentCapabilities
  /**
   * 按阶段实例执行一次：拼 prompt、起会话（新建/续接/fork）、收集文本、推事件。
   *
   * 返回本阶段产物；上层拿 `responseTexts` 去 parse 各种决策 JSON。
   */
  runStage(input: TaskStageInput): Promise<TaskAgentResult>
  /**
   * 只读访问已累积的阶段产物（`runStage` 的返回值同一份）。保留是为了 Trace /
   * 重入路径能在 `runStage` 之外拿到缓冲，新代码应直接用 `runStage` 的返回值。
   */
  collectResult(taskId: string, phase: TaskAgentPhase): TaskAgentResult
  /** 释放一个阶段实例的会话（阶段结束后不必再占着）；不级联到同任务的其它阶段。 */
  releaseStage(stageInstanceId: string): void
  /** 关闭指定任务的全部阶段会话（任务终态 / 重置时级联）。 */
  closeSession(taskId: string): void
  /** 释放 driver 持有的资源。 */
  dispose(): void
}
