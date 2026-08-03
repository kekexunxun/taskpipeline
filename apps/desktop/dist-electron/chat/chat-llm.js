import { accessToken, createSdkMcpServer, query, tool as qoderTool } from "@qoder-ai/qoder-agent-sdk";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, stepCountIs, streamText, tool as aiTool } from "ai";
import { z } from "zod";
function messageText(message) {
    return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
}
export async function* streamChat(options) {
    if (options.model.provider === "qoder")
        yield* streamQoder({ model: options.model, qoderToken: options.qoderToken, messages: options.messages, signal: options.signal, taskAgent: options.taskAgent });
    else
        yield* streamOpenAICompatible({ model: options.model, messages: options.messages, signal: options.signal, taskAgent: options.taskAgent });
    if (options.taskAgent?.createdTask)
        yield { type: "task-created", task: options.taskAgent.createdTask };
}
const creationSchemaShape = {
    projectKey: z.string().optional().describe("Jira 项目 Key，例如 BSADAPT344"),
    issueTypeId: z.string().optional().describe("Jira 问题类型 ID"),
    issueTypeName: z.string().optional().describe("Jira 问题类型名称，例如任务、故事、Bug提单")
};
const createIssueShape = {
    projectKey: z.string().describe("Jira 项目 Key"),
    issueTypeId: z.string().optional().describe("从创建 Schema 获取的 Jira 问题类型 ID"),
    issueTypeName: z.string().describe("从创建 Schema 选择的 Jira 问题类型名称"),
    summary: z.string().describe("简洁明确的 Jira 概要"),
    description: z.string().optional().describe("包含背景、目标、范围和可验证结果的描述"),
    componentId: z.string().optional().describe("从 Schema 获取的模块 ID"),
    componentName: z.string().optional().describe("从 Schema 获取的模块名称"),
    priorityId: z.string().optional().describe("从 Schema 获取的优先级 ID"),
    taskLevelId: z.string().optional().describe("任务级别 customfield_10500 的选项 ID"),
    taskCategoryId: z.string().optional().describe("业务任务类型 customfield_12505 的选项 ID；不要与 Jira 问题类型混淆"),
    sprintId: z.number().int().positive().optional().describe("已动态确认有效的 Sprint ID；不得猜测"),
    originalEstimate: z.string().optional().describe("初始预估，例如 8h、2d"),
    remainingEstimate: z.string().optional().describe("剩余预估；省略时与初始预估一致"),
    assignee: z.string().optional().describe("明确确认过的 Jira 用户名"),
    reporter: z.string().optional().describe("明确确认过的 Jira 用户名"),
    additionalFields: z.record(z.string(), z.unknown()).optional().describe("仅允许放入创建 Schema 明确返回的 customfield 字段")
};
function modelToolResult(value) {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
function openAITaskTools(agent) {
    return {
        get_jira_creation_schema: aiTool({
            description: "创建 Jira 前必须调用。获取项目、问题类型、必填字段、选项 ID 和注意事项。",
            inputSchema: z.object(creationSchemaShape),
            execute: (input) => agent.getCreationSchema(input)
        }),
        create_jira_issue: aiTool({
            description: "信息完整且用户确实要创建时调用。程序会校验字段，并通过已配置的 Jira MCP 创建 Issue。",
            inputSchema: z.object(createIssueShape),
            execute: (input) => agent.createJiraIssue(input)
        }),
        ...(agent.confluenceConfigured ? {
            search_confluence: aiTool({
                description: "只读搜索 Confluence，用于补充创建 Jira 所必需的内部背景。",
                inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).optional() }),
                execute: (input) => agent.searchConfluence(input)
            }),
            get_confluence_page: aiTool({
                description: "只读获取 Confluence 页面正文。",
                inputSchema: z.object({ pageId: z.string() }),
                execute: (input) => agent.getConfluencePage(input)
            })
        } : {})
    };
}
function qoderTaskServer(agent) {
    const tools = [
        qoderTool("get_jira_creation_schema", "创建 Jira 前必须调用。获取项目、问题类型、必填字段、选项 ID 和注意事项。", creationSchemaShape, async (input) => modelToolResult(await agent.getCreationSchema(input)), { annotations: { readOnlyHint: true }, permissionPolicy: "always_allow" }),
        qoderTool("create_jira_issue", "信息完整且用户确实要创建时调用。程序会校验字段，并通过已配置的 Jira MCP 创建 Issue。", createIssueShape, async (input) => modelToolResult(await agent.createJiraIssue(input)), { annotations: { destructiveHint: true, openWorldHint: true }, permissionPolicy: "always_allow" })
    ];
    if (agent.confluenceConfigured) {
        tools.push(qoderTool("search_confluence", "只读搜索 Confluence，用于补充创建 Jira 所必需的内部背景。", { query: z.string(), limit: z.number().int().min(1).max(20).optional() }, async (input) => modelToolResult(await agent.searchConfluence(input)), { annotations: { readOnlyHint: true }, permissionPolicy: "always_allow" }), qoderTool("get_confluence_page", "只读获取 Confluence 页面正文。", { pageId: z.string() }, async (input) => modelToolResult(await agent.getConfluencePage(input)), { annotations: { readOnlyHint: true }, permissionPolicy: "always_allow" }));
    }
    return createSdkMcpServer({ name: "task-creation", version: "1.0.0", tools });
}
async function* streamOpenAICompatible({ model, messages, signal, taskAgent }) {
    const provider = createOpenAICompatible({ name: "desktop-openai-compatible", baseURL: model.baseUrl.replace(/\/$/, ""), apiKey: model.apiKey });
    const tools = taskAgent ? openAITaskTools(taskAgent) : undefined;
    const result = streamText({
        model: provider.chatModel(model.key),
        messages: await convertToModelMessages(messages, tools ? { tools } : undefined),
        abortSignal: signal,
        ...(taskAgent ? { system: taskAgent.systemPrompt, tools, stopWhen: stepCountIs(10) } : {})
    });
    for await (const delta of result.textStream) {
        if (signal.aborted)
            return;
        if (delta)
            yield { type: "delta", delta };
    }
    yield { type: "done" };
}
async function* streamQoder({ model, qoderToken, messages, signal, taskAgent }) {
    if (!qoderToken)
        throw new Error("请先在设置中配置 Qoder Token");
    const prompt = `${messages.map((message) => `${message.role === "user" ? "Human" : message.role === "assistant" ? "Assistant" : "System"}: ${messageText(message)}`).join("\n\n")}\n\nAssistant:`;
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const taskServer = taskAgent ? qoderTaskServer(taskAgent) : undefined;
    const taskToolNames = taskAgent
        ? ["mcp__task_creation__get_jira_creation_schema", "mcp__task_creation__create_jira_issue", ...(taskAgent.confluenceConfigured ? ["mcp__task_creation__search_confluence", "mcp__task_creation__get_confluence_page"] : [])]
        : [];
    const session = query({
        prompt,
        options: {
            auth: accessToken(qoderToken),
            cwd: process.cwd(),
            abortController,
            persistSession: false,
            permissionMode: "default",
            controlRequestTimeoutMs: 15_000,
            model: model.key,
            ...(taskAgent ? {
                systemPrompt: taskAgent.systemPrompt,
                tools: [],
                mcpServers: { task_creation: taskServer },
                allowedMcpServerNames: ["task_creation"],
                allowedTools: taskToolNames,
                maxTurns: 10
            } : {})
        }
    });
    let buffer = "";
    let captured = false;
    try {
        for await (const raw of session) {
            if (signal.aborted)
                return;
            const message = raw;
            if (message.type === "stream_event") {
                const event = message.event;
                if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
                    buffer += event.delta.text;
                    yield { type: "delta", delta: event.delta.text };
                }
                else if (event?.type === "content_block_start" && event.content_block?.type === "text" && event.content_block.text) {
                    buffer += event.content_block.text;
                    yield { type: "delta", delta: event.content_block.text };
                }
                else if (event?.type === "message_stop")
                    captured = true;
                else if (event?.type === "error" && !buffer)
                    throw new Error(typeof event.error === "string" ? event.error : event.error?.message ?? "Qoder SDK 流式错误");
            }
            else if (message.type === "assistant" && Array.isArray(message.message?.content)) {
                for (const part of message.message.content)
                    if (part.type === "text" && part.text && !buffer.includes(part.text)) {
                        buffer += part.text;
                        yield { type: "delta", delta: part.text };
                    }
            }
            else if (message.type === "result") {
                if (message.result && !buffer.includes(message.result)) {
                    const extra = message.result.startsWith(buffer) ? message.result.slice(buffer.length) : message.result;
                    buffer += extra;
                    if (extra)
                        yield { type: "delta", delta: extra };
                }
                captured = true;
            }
            else if (message.type === "error" && !buffer)
                throw new Error(message.error ?? "Qoder SDK 错误");
        }
    }
    catch (error) {
        if (!signal.aborted && !captured && !buffer)
            throw error;
    }
    finally {
        try {
            await session.close();
        }
        catch { /* The SDK may already be closed. */ }
    }
    if (!signal.aborted)
        yield { type: "done" };
}
//# sourceMappingURL=chat-llm.js.map