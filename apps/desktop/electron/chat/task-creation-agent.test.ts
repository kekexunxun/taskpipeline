import type { AtlassianClientFactory, McpClient } from "@coding-agent/integrations";
import { describe, expect, it, vi } from "vitest";
import { JiraTaskCreationAgent } from "./task-creation-agent.js";

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
