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
/**
 * 挑一个真正可用的后端。无可用后端时返回 undefined，
 * ChatService 在这种情况下应该提示"未配置任何任务创建后端"并继续按 chat 模式工作。
 */
export function resolveTaskBackend(factories, input) {
    const candidates = [
        { id: "jira", factory: factories.jira },
        { id: "github", factory: factories.github },
        { id: "linear", factory: factories.linear }
    ];
    const preferred = candidates.find((candidate) => candidate.id === input.preferredId);
    if (preferred) {
        const backend = preferred.factory();
        if (backend?.configured)
            return backend;
    }
    for (const candidate of candidates) {
        const backend = candidate.factory();
        if (backend?.configured)
            return backend;
    }
    return undefined;
}
/**
 * 列出所有后端的展示信息。已配置 / 未配置都返回，UI 据此渲染。
 * `configured=false` 的占位项（如 GitHub / Linear）仍会出现，UI 可以标注"未实现"。
 */
export function listTaskBackendInfos(backends) {
    const items = [];
    for (const id of ["jira", "github", "linear"]) {
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
//# sourceMappingURL=index.js.map