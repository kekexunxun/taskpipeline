/**
 * 「任务创建」后端抽象层。
 *
 * 背景：
 *  早期实现把任务创建能力写死为 Jira —— ChatService 注入 JiraTaskCreationAgent，
 *  整个 systemPrompt 和 UI 文案都是 Jira 视角。后续要扩展到 GitHub Issues / Linear 时，
 *  每一个后端都要改一长串代码。
 *
 * 设计：
 *  - 定义 `TaskCreationBackend` 接口，对外只暴露 3 个能力：systemPrompt、createTask、close。
 *  - 每个后端（jira / github / linear）放在独立文件中，实现这个接口。
 *  - `listTaskBackends()` 返回所有可用后端（含未实现的占位），UI 据此展示。
 *  - `resolveTaskBackend(settings, id)` 根据设置或默认策略挑一个后端。
 *
 * 注意：本目录是 ChatService 唯一允许访问任务创建后端的地方。其他模块请勿直接 import 具体后端。
 */
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
 * - `systemPrompt`：注入到 Chat Agent 的系统提示词，必须明确说明该后端的创建规则。
 * - `createTask(input)`：在 LLM 决定好字段后，真正向后端发请求创建任务。
 *   input 里的 `payload` 已经是后端特定的形状（由 LLM 在 systemPrompt 引导下产出）。
 * - `close()`：释放该后端持有的资源（mcp client / http pool 等）。
 */
export interface TaskCreationBackend {
    readonly id: TaskBackendId;
    readonly displayName: string;
    readonly configured: boolean;
    systemPrompt(): string;
    createTask(input: {
        payload: Record<string, unknown>;
    }): Promise<TaskCreatedResult>;
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
export declare function resolveTaskBackend(factories: {
    jira: () => TaskCreationBackend;
    github: () => TaskCreationBackend | null;
    linear: () => TaskCreationBackend | null;
}, input: ResolveTaskBackendInput): TaskCreationBackend | undefined;
/**
 * 列出所有后端的展示信息。已配置 / 未配置都返回，UI 据此渲染。
 * `configured=false` 的占位项（如 GitHub / Linear）仍会出现，UI 可以标注"未实现"。
 */
export declare function listTaskBackendInfos(backends: Record<TaskBackendId, TaskCreationBackend | null>): TaskBackendInfo[];
