import type { AtlassianClientFactory, McpClient } from "@coding-agent/integrations";
import { describe, expect, it, vi } from "vitest";
import { JiraTaskCreationAgent } from "./task-creation-agent.js";
import { JiraTaskCreationBackend } from "./task-backends/jira.js";

function setup(options: { configured?: boolean; tools?: unknown[]; result?: unknown } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    listTools: vi.fn(async () => options.tools ?? [{
      name: "jira_create_issue",
      inputSchema: { type: "object", properties: { project_key: {}, summary: {}, issue_type: {}, description: {}, components: { type: "array" }, additional_fields: { type: "object" } } }
    }]),
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return options.result ?? { content: [{ type: "text", text: JSON.stringify({ issueKey: "BSADAPT344-42" }) }] };
    }),
    close: vi.fn()
  } as unknown as McpClient;
  const factory = {
    isConfigured: vi.fn((kind: string) => kind === "jira" && options.configured !== false),
    create: vi.fn(() => client)
  } as unknown as AtlassianClientFactory;
  return { agent: new JiraTaskCreationAgent(factory), client, calls };
}

describe("JiraTaskCreationAgent", () => {
  it("returns the 任务 type template when MCP has no create-metadata tool", async () => {
    const { agent } = setup();
    await expect(agent.getCreationSchema({ projectKey: "BSADAPT344", issueTypeId: "10002" })).resolves.toMatchObject({
      available: true,
      source: "template:任务",
      issueType: { id: "10002", name: "任务" },
      requestedIssueType: "10002"
    });
  });

  it("requires the issue type before resolving a template", async () => {
    const { agent } = setup();
    await expect(agent.getCreationSchema({ projectKey: "BSADAPT344" })).resolves.toMatchObject({
      available: true,
      requiresIssueType: true,
      knownIssueTypeExample: { id: "10002", name: "任务" }
    });
  });

  it("falls back to the generic schema for issue types without a registered template", async () => {
    const { agent } = setup();
    await expect(agent.getCreationSchema({ projectKey: "PAY", issueTypeName: "故事" })).resolves.toMatchObject({
      available: true,
      source: "generic-fallback"
    });
  });

  it("prefers a create-metadata tool exposed by Jira MCP", async () => {
    const { agent, calls } = setup({
      tools: [{ name: "jira_get_create_issue_metadata", inputSchema: { properties: { project_key: {}, issue_type_id: {} } } }],
      result: { content: [{ type: "text", text: JSON.stringify({ fields: { summary: { required: true } } }) }] }
    });
    await expect(agent.getCreationSchema({ projectKey: "PAY", issueTypeId: "10001" })).resolves.toMatchObject({ source: "mcp:jira_get_create_issue_metadata" });
    expect(calls[0]).toEqual({ name: "jira_get_create_issue_metadata", args: { project_key: "PAY", issue_type_id: "10001" } });
  });

  it("validates and maps task fields before creating through Jira MCP", async () => {
    const { agent, calls } = setup();
    await agent.getCreationSchema({ projectKey: "BSADAPT344", issueTypeId: "10002" });
    await expect(agent.createJiraIssue({
      projectKey: "bsadapt344",
      issueTypeId: "10002",
      issueTypeName: "任务",
      summary: "新增任务创建 Agent",
      description: "通过聊天创建 Jira",
      componentName: "Adaptor",
      priorityId: "3",
      originalEstimate: "8h"
    })).resolves.toEqual({ taskKey: "BSADAPT344-42", projectKey: "BSADAPT344", issueType: "任务", summary: "新增任务创建 Agent" });
    expect(calls[0]).toMatchObject({
      name: "jira_create_issue",
      args: {
        project_key: "BSADAPT344",
        summary: "新增任务创建 Agent",
        issue_type: "任务",
        components: ["Adaptor"],
        additional_fields: {
          customfield_10500: { id: "10602" },
          priority: { id: "3" },
          timetracking: { originalEstimate: "8h", remainingEstimate: "8h" }
        }
      }
    });
    expect(agent.createdTask?.taskKey).toBe("BSADAPT344-42");
  });

  it("reports missing Jira configuration without starting MCP", async () => {
    const { agent } = setup({ configured: false });
    await expect(agent.getCreationSchema({ projectKey: "BSADAPT344" })).resolves.toMatchObject({ available: false });
    await expect(agent.createJiraIssue({ projectKey: "BSADAPT344", issueTypeName: "任务", summary: "x" })).rejects.toThrow("未配置 Jira MCP");
  });
});

/**
 * JiraTaskCreationBackend 是 driver 视角的入口。`toToolSource()` 把后端能力以 driver-agnostic
 * 形态暴露给 chat driver（Qoder / OpenAI）,driver 自行翻译成自己的 SDK 协议。
 *
 * 这些断言确保 4 个工具声明完整、Confluence 工具条件性出现、describeResult 能从 agent 输出
 * 识别出"任务已创建"事件。
 */
describe("JiraTaskCreationBackend.toToolSource()", () => {
  function backendWith(overrides: { configured?: boolean; withConfluence?: boolean } = {}) {
    const factory = {
      isConfigured: vi.fn((kind: string) => {
        if (kind === "jira") return overrides.configured !== false;
        if (kind === "confluence") return !!overrides.withConfluence;
        return false;
      }),
      create: vi.fn(() => ({
        listTools: vi.fn(async () => [{
          name: "jira_create_issue",
          inputSchema: { type: "object", properties: { project_key: {}, summary: {}, issue_type: {} } }
        }]),
        callTool: vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({ issueKey: "BSADAPT344-7" }) }] })),
        close: vi.fn()
      }))
    } as unknown as AtlassianClientFactory;
    return new JiraTaskCreationBackend(factory);
  }

  it("exposes the 2 core Jira tools when Confluence is not configured", () => {
    const backend = backendWith();
    const source = backend.toToolSource();
    const tools = source.tools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_jira_creation_schema");
    expect(names).toContain("create_jira_issue");
    expect(names).not.toContain("search_confluence");
    expect(names).not.toContain("get_confluence_page");
  });

  it("exposes the 4 tools including Confluence when Confluence is configured", () => {
    // 直接用 backendWith({ withConfluence: true }),driver 走 toToolSource().tools() 时会包出 4 个
    const backend = backendWith({ withConfluence: true });
    const names = backend.toToolSource().tools().map((t) => t.name);
    expect(names).toContain("get_jira_creation_schema");
    expect(names).toContain("create_jira_issue");
    expect(names).toContain("search_confluence");
    expect(names).toContain("get_confluence_page");
  });

  it("tools carry a zod schema and annotations", () => {
    const backend = backendWith();
    const tools = backend.toToolSource().tools();
    const create = tools.find((t) => t.name === "create_jira_issue");
    expect(create).toBeDefined();
    // schema 是单层 zod record
    expect(create!.schema).toBeDefined();
    expect(typeof create!.schema.projectKey).toBe("object");
    expect(create!.annotations?.destructiveHint).toBe(true);
  });

  it("describeResult identifies a created task from the agent's return shape", () => {
    const backend = backendWith();
    const source = backend.toToolSource();
    const created = source.describeResult({
      taskKey: "BSADAPT344-42",
      summary: "demo",
      projectKey: "BSADAPT344",
      issueType: "任务"
    });
    expect(created).toEqual({
      backend: "jira",
      externalKey: "BSADAPT344-42",
      summary: "demo",
      projectKey: "BSADAPT344",
      issueType: "任务"
    });
  });

  it("describeResult walks MCP-style { content: [{ type: 'text', text: '...' }] } envelope", () => {
    const backend = backendWith();
    const created = backend.toToolSource().describeResult({
      content: [{ type: "text", text: JSON.stringify({ taskKey: "BSADAPT344-99", summary: "from mcp", projectKey: "BSADAPT344", issueType: "任务" }) }]
    });
    expect(created?.externalKey).toBe("BSADAPT344-99");
  });

  it("describeResult returns undefined for non-task outputs", () => {
    const backend = backendWith();
    expect(backend.toToolSource().describeResult({ unrelated: "value" })).toBeUndefined();
    expect(backend.toToolSource().describeResult(null)).toBeUndefined();
  });

  it("configured flag reflects Jira availability", () => {
    const on = backendWith();
    const off = backendWith({ configured: false });
    expect(on.configured).toBe(true);
    expect(off.configured).toBe(false);
  });
});
