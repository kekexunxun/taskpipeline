import { z } from "zod";
import type { AtlassianClientFactory } from "@task-pipeline/integrations";
import { JiraTaskCreationAgent, type JiraCreateInput } from "../task-creation-agent.js";
import type { ToolSource, ToolDeclaration } from "../drivers/tool-source.js";
import type { ChatTaskCreationResult } from "../chat-types.js";
import type { TaskCreationBackend, TaskCreatedResult } from "./index.js";

/**
 * Jira 工具的 zod 字段定义。
 *
 * 之前 `chat-llm.ts` 里把这套字段用 `z.object(creationSchemaShape)` 各打包一次
 * 给 ai-sdk 和 qoderSdk 各自使用。重构后字段单层 record (`z.object` 已经拆好),
 * driver 内部按 SDK 重新组装 (ai-sdk: `z.object(shape)`;qoder: 直接传 shape)。
 */
const creationSchemaShape = {
  projectKey: z.string().optional().describe("Jira 项目 Key，例如 BSADAPT344"),
  issueTypeId: z.string().optional().describe("Jira 问题类型 ID"),
  issueTypeName: z.string().optional().describe("Jira 问题类型名称，例如任务、故事、Bug提单")
} as const;

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
} as const;

const confluenceSearchShape = {
  query: z.string(),
  limit: z.number().int().min(1).max(20).optional()
} as const;

const confluenceGetPageShape = {
  pageId: z.string()
} as const;

/**
 * Jira 任务创建后端的 ToolSource 实现。
 *
 * 内部委托给 `JiraTaskCreationAgent` 的 getCreationSchema / createJiraIssue / searchConfluence / getConfluencePage。
 * 工具声明以 driver-agnostic 形态 (`ToolDeclaration[]`) 暴露,driver 自行翻译成自己 SDK 的 tool 协议。
 *
 * `describeResult(output)` 通过判断 `output` 形状 (有 `taskKey / externalKey`) 来识别任务已创建事件。
 */
class JiraToolSource implements ToolSource {
  readonly id = "jira" as const;
  readonly displayName = "Jira";

  constructor(private readonly agent: JiraTaskCreationAgent) {}

  systemPrompt(): string { return this.agent.systemPrompt; }

  tools(): ToolDeclaration[] {
    const agent = this.agent;
    const tools: ToolDeclaration[] = [
      {
        name: "get_jira_creation_schema",
        description: "创建 Jira 前必须调用。获取项目、问题类型、必填字段、选项 ID 和注意事项。",
        schema: creationSchemaShape,
        annotations: { readOnlyHint: true },
        execute: async (input) => agent.getCreationSchema(input as { projectKey?: string; issueTypeId?: string; issueTypeName?: string })
      },
      {
        name: "create_jira_issue",
        description: "信息完整且用户确实要创建时调用。程序会校验字段，并通过已配置的 Jira MCP 创建 Issue。",
        schema: createIssueShape,
        annotations: { destructiveHint: true, openWorldHint: true },
        execute: async (input) => agent.createJiraIssue(input as JiraCreateInput)
      }
    ];
    if (agent.confluenceConfigured) {
      tools.push(
        {
          name: "search_confluence",
          description: "只读搜索 Confluence，用于补充创建 Jira 所必需的内部背景。",
          schema: confluenceSearchShape,
          annotations: { readOnlyHint: true },
          execute: async (input) => agent.searchConfluence(input as { query: string; limit?: number })
        },
        {
          name: "get_confluence_page",
          description: "只读获取 Confluence 页面正文。",
          schema: confluenceGetPageShape,
          annotations: { readOnlyHint: true },
          execute: async (input) => agent.getConfluencePage(input as { pageId: string })
        }
      );
    }
    return tools;
  }

  describeResult(output: unknown): ChatTaskCreationResult | undefined {
    if (!output || typeof output !== "object") return undefined;
    const record = output as Record<string, unknown>;
    // agent.createJiraIssue 返回 { taskKey, summary, projectKey, issueType }
    if (typeof record.taskKey === "string" && typeof record.summary === "string") {
      return {
        backend: "jira",
        externalKey: record.taskKey,
        summary: record.summary,
        projectKey: typeof record.projectKey === "string" ? record.projectKey : "",
        issueType: typeof record.issueType === "string" ? record.issueType : ""
      };
    }
    // Qoder MCP 返回的 tool result 在 { content: [{ type: "text", text: "..." }] } 里包了 JSON
    const content = record.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") {
            try {
              const parsed = JSON.parse(text) as unknown;
              if (parsed && typeof parsed === "object") return this.describeResult(parsed);
            } catch { /* not JSON, skip */ }
          }
        }
      }
    }
    return undefined;
  }

  close(): void { this.agent.close(); }
}

/**
 * Jira 后端实现。
 *
 * 设计：保留原有 `JiraTaskCreationAgent` 的所有能力,外层用 `JiraTaskCreationBackend` 包一层,
 * 对外只暴露 `TaskCreationBackend` 接口(`toToolSource / createTask / close`)。
 *
 * 这样：
 * - chat driver 看到的工具声明是 driver-agnostic (`ToolDeclaration[]`),由 driver 翻译成 ai-sdk / qoder 协议;
 * - 后续接入 GitHub / Linear 时只需在 `task-backends/` 下提供对应实现 + 实现 `toToolSource`;
 * - IPC 暴露面只依赖 `TaskCreationBackend` 接口,避免上层 import 到 Jira 细节。
 */
export class JiraTaskCreationBackend implements TaskCreationBackend {
  readonly id = "jira" as const;
  readonly displayName = "Jira";
  private readonly agent: JiraTaskCreationAgent;
  private readonly source: JiraToolSource;

  constructor(factory: AtlassianClientFactory) {
    this.agent = new JiraTaskCreationAgent(factory);
    this.source = new JiraToolSource(this.agent);
  }

  get configured(): boolean { return this.agent.jiraConfigured; }

  toToolSource(): ToolSource { return this.source; }

  async createTask(input: { payload: Record<string, unknown> }): Promise<TaskCreatedResult> {
    const created = await this.agent.createJiraIssue(input.payload as JiraCreateInput);
    return {
      backend: "jira",
      externalKey: created.taskKey,
      summary: created.summary,
      projectKey: created.projectKey,
      issueType: created.issueType
    };
  }

  close(): void { this.agent.close(); }
}
