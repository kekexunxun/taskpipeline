import type { AtlassianClientFactory } from "@coding-agent/integrations";
import { JiraTaskCreationAgent } from "../task-creation-agent.js";
import type { TaskCreationBackend, TaskCreatedResult } from "./index.js";
/**
 * Jira 后端实现。
 *
 * 设计：保留原有 `JiraTaskCreationAgent` 的所有能力（getCreationSchema / createJiraIssue /
 * searchConfluence / getConfluencePage），外层用 `JiraTaskCreationBackend` 包一层，
 * 对外只暴露 `TaskCreationBackend` 接口。
 *
 * 这样：
 * - chat-llm.ts 现有的 Jira-specific tool 定义（zod 形状 + qoder/openai 工具包装）继续可用；
 * - 后续接入 GitHub / Linear 时只需在 chat-llm.ts 加一个 backend.id 分支，并在 task-backends/
 *   下提供对应实现；
 * - IPC 暴露面只依赖 `TaskCreationBackend` 接口，避免上层 import 到 Jira 细节。
 */
export declare class JiraTaskCreationBackend implements TaskCreationBackend {
    readonly id: "jira";
    readonly displayName = "Jira";
    private readonly agent;
    constructor(factory: AtlassianClientFactory);
    get configured(): boolean;
    systemPrompt(): string;
    createTask(input: {
        payload: Record<string, unknown>;
    }): Promise<TaskCreatedResult>;
    close(): void;
    /** 给 chat-llm.ts 使用的逃生口：直接拿到 agent 暴露 Jira-specific 工具（schema / createJiraIssue / Confluence）。 */
    get jiraAgent(): JiraTaskCreationAgent;
}
