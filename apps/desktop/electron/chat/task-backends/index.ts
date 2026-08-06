/**
 * 「任务创建」后端抽象层。
 *
 * 背景：
 *  早期实现把任务创建能力写死为 Jira —— ChatService 注入 JiraTaskCreationAgent，
 *  整个 systemPrompt 和 UI 文案都是 Jira 视角。后续要扩展到 GitHub Issues / Linear 时，
 *  每一个后端都要改一长串代码。
 *
 * 设计（重构后）：
 *  - 定义 `TaskCreationBackend` 接口，对外暴露 4 个能力：toToolSource / createTask / close。
 *  - 每个后端（jira / github / linear）放在独立文件中，实现这个接口。
 *  - `listTaskBackends()` 返回所有可用后端（含未实现的占位），UI 据此展示。
 *  - `resolveTaskBackend(settings, id)` 根据设置或默认策略挑一个后端。
 *  - **`toToolSource()`** 把后端的"工具集"以 driver-agnostic 形态暴露:
 *    通用 systemPrompt + 通用 ToolDeclaration[] + describeResult。
 *    各 chat driver (Qoder / OpenAI) 自行把 ToolDeclaration 翻译成自己 SDK 的 tool 协议。
 *
 * 注意：本目录是 ChatService 唯一允许访问任务创建后端的地方。其他模块请勿直接 import 具体后端。
 */

import type { ToolSource } from "../drivers/tool-source.js";

export type TaskBackendId = "jira" | "github" | "linear";

export type TaskBackendInfo = {
  id: TaskBackendId;
  displayName: string;
  configured: boolean;
  description?: string;
};

export type TaskCreatedResult = {
  backend: TaskBackendId;
  externalKey: string;
  summary: string;
  projectKey?: string;
  issueType?: string;
  url?: string;
};

/**
 * 单个任务创建后端必须实现的能力。
 *
 * - `id` / `displayName`：UI 识别用，固定不变。
 * - `configured`：当前是否已配置完成（true 时 UI 可启用）。
 * - `toToolSource()`：把后端的工具集以 driver-agnostic 形态暴露给 chat driver。
 *   ChatService 在 streamChat 时把它注入 `ToolSource`。
 * - `createTask(input)`：当前主要给测试 / 显式调用预留。chat 路径上由 driver 通过
 *   工具执行触发,执行结果经 `ToolSource.describeResult` 转换。
 * - `close()`：释放该后端持有的资源（mcp client / http pool 等）。
 */
export interface TaskCreationBackend {
  readonly id: TaskBackendId;
  readonly displayName: string;
  readonly configured: boolean;
  toToolSource(): ToolSource;
  createTask(input: { payload: Record<string, unknown> }): Promise<TaskCreatedResult>;
  close(): void;
}

export type ResolveTaskBackendInput = {
  jiraConfigured: boolean;
  githubConfigured: boolean;
  linearConfigured: boolean;
  /**
   * 系统设置中可显式指定后端 id。空或未配置时按"先 Jira -> GitHub -> Linear"回退。
   */
  preferredId?: string;
};

/**
 * 挑一个真正可用的后端。无可用后端时返回 undefined，
 * ChatService 在这种情况下应该提示"未配置任何任务创建后端"并继续按 chat 模式工作。
 */
export function resolveTaskBackend(
  factories: { jira: () => TaskCreationBackend; github: () => TaskCreationBackend | null; linear: () => TaskCreationBackend | null },
  input: ResolveTaskBackendInput
): TaskCreationBackend | undefined {
  const candidates: Array<{ id: TaskBackendId; factory: () => TaskCreationBackend | null }> = [
    { id: "jira", factory: factories.jira },
    { id: "github", factory: factories.github },
    { id: "linear", factory: factories.linear }
  ];
  const preferred = candidates.find((candidate) => candidate.id === input.preferredId);
  if (preferred) {
    const backend = preferred.factory();
    if (backend?.configured) return backend;
  }
  for (const candidate of candidates) {
    const backend = candidate.factory();
    if (backend?.configured) return backend;
  }
  return undefined;
}

/**
 * 列出所有后端的展示信息。已配置 / 未配置都返回，UI 据此渲染。
 * `configured=false` 的占位项（如 GitHub / Linear）仍会出现，UI 可以标注"未实现"。
 */
export function listTaskBackendInfos(backends: Record<TaskBackendId, TaskCreationBackend | null>): TaskBackendInfo[] {
  const items: TaskBackendInfo[] = [];
  for (const id of ["jira", "github", "linear"] as const) {
    const backend = backends[id];
    items.push({
      id,
      displayName: backend?.displayName ?? id === "github" ? "GitHub Issues" : id === "linear" ? "Linear" : "Jira",
      configured: backend?.configured ?? false,
      description: id === "jira"
        ? "Jira：使用 Atlassian MCP 创建 Issue。"
        : id === "github"
          ? "GitHub Issues：本期未实现。"
          : "Linear：本期未实现。"
    });
  }
  return items;
}
