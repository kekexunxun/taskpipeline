import type { McpProfile, SettingResolver, Task, TaskStore } from "@coding-agent/core";
import { McpClient } from "./mcp.js";
import { mapJiraTasks, type JiraTaskInput } from "./jira.js";

/**
 * 从一段文本里提取 Jira Key(支持 `PROJ-123` 或 `https://jira.example.com/browse/PROJ-123`)。
 * 抛错当输入里没有匹配的 key,便于在 IPC 边界尽早失败。
 */
export function jiraKeyFrom(value: string): string {
  const match = value.trim().toUpperCase().match(/(?:\/BROWSE\/)?([A-Z][A-Z0-9]+-\d+)(?:[/?#]|$)/i);
  if (!match?.[1]) throw new Error("请输入有效的 Jira Key 或 browse 地址");
  return match[1];
}

/**
 * 把 MCP callTool 响应里的 `content[].text` 字段(JSON 字符串)解析为对象;
 * 如果 content 不是 text 类型或不是 JSON,返回 `{ text: <原始字符串> }`。
 * 抽到独立函数便于在 `importJiraIssue` / `syncJiraTasks` 复用。
 */
export function mcpPayload(result: unknown): any {
  const content = (result as any)?.content;
  const text = Array.isArray(content) ? content.find((item: any) => item?.type === "text")?.text : undefined;
  if (typeof text !== "string") return result;
  try { return JSON.parse(text); } catch { return { text }; }
}

/**
 * Atlassian (Jira / Confluence) MCP 客户端工厂。
 * 内部根据 `kind` 选 `jira` / `confluence` 的 URL + token + env 变量,生成 `McpClient`。
 * URL 与 Token 通过 `SettingResolver` 读取(`jiraUrl` / `confluenceUrl` + `jiraToken` / `confluenceToken`)。
 */
export class AtlassianClientFactory {
  constructor(private readonly resolver: SettingResolver) {}

  create(kind: "jira" | "confluence"): McpClient {
    const prefix = kind === "jira" ? "jira" : "confluence";
    const url = this.resolver.get(`${prefix}Url`);
    const token = this.resolver.getSecret(`${prefix}Token`);
    if (!url || !token) throw new Error(`请先配置 ${kind === "jira" ? "Jira" : "Confluence"} URL 与 Token`);
    return new McpClient({
      id: "atlassian",
      name: "mcp-atlassian",
      transport: "stdio",
      command: "uvx",
      args: ["mcp-atlassian"],
      env: kind === "jira" ? { JIRA_URL: url, JIRA_PERSONAL_TOKEN: token } : { CONFLUENCE_URL: url, CONFLUENCE_PERSONAL_TOKEN: token },
      tools: {}
    } as McpProfile);
  }
}

/**
 * 导入单个 Jira Issue,落库为本地 Task。
 * 入参支持 `PROJ-123` 或 `https://jira.example.com/browse/PROJ-123`。
 */
export async function importJiraIssue(client: McpClient, keyOrUrl: string, store: TaskStore): Promise<Task> {
  const key = jiraKeyFrom(keyOrUrl);
  try {
    const payload = mcpPayload(await client.callTool("jira_get_issue", { issue_key: key }));
    const issue = payload?.issue ?? payload;
    const fields = issue?.fields ?? issue;
    const description = typeof fields?.description === "string"
      ? fields.description
      : fields?.description ? JSON.stringify(fields.description) : payload?.text ?? "";
    return store.upsertJiraTask({
      jiraKey: issue?.key ?? key,
      title: fields?.summary ?? fields?.title ?? key,
      description,
      keywords: fields?.labels ?? [],
      acceptanceCriteria: [],
      state: "draft",
      reviewStatus: "pending"
    });
  } finally {
    client.close();
  }
}

/**
 * 只读取 Jira 任务候选项，不写入本地 store。
 *
 * 分页策略:
 * - 优先用 `next_page_token`(mcp-atlassian 现代接口)
 * - 没有时退回 `start_at` + `total` 传统分页
 * - 最多 100 页,每页 50 条
 */
export async function fetchJiraTasks(client: McpClient, jql?: string): Promise<JiraTaskInput[]> {
  try {
    const tasks = new Map<string, JiraTaskInput & { jiraKey: string }>();
    let startAt = 0;
    let pageToken: string | undefined;
    const finalJql = jql ?? "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
    for (let page = 0; page < 100; page += 1) {
      const result = await client.callTool("jira_search", { jql: finalJql, fields: "summary,description,labels,status", limit: 50, start_at: startAt, ...(pageToken ? { page_token: pageToken } : {}) });
      const mapped = mapJiraTasks(result);
      for (const task of mapped) if (task.jiraKey) tasks.set(task.jiraKey, task as JiraTaskInput & { jiraKey: string });
      const payload = mcpPayload(result);
      const issueCount = Array.isArray(payload?.issues) ? payload.issues.length : mapped.length;
      const total = Number(payload?.total);
      const nextPageToken = typeof payload?.next_page_token === "string" && payload.next_page_token ? payload.next_page_token : undefined;
      if (nextPageToken) { pageToken = nextPageToken; continue; }
      const nextStart = startAt + issueCount;
      if (issueCount === 0 || (Number.isFinite(total) && total >= 0 && nextStart >= total) || issueCount < 50) break;
      startAt = nextStart;
    }
    return [...tasks.values()];
  } finally {
    client.close();
  }
}

/**
 * 同步 Jira 任务到本地 store,按 `jiraKey` 去重,保留每个 key 的最新映射。
 */
export async function syncJiraTasks(client: McpClient, store: TaskStore, jql?: string): Promise<Task[]> {
  const tasks = await fetchJiraTasks(client, jql);
  store.setSetting("lastJiraSync", new Date().toISOString());
  return tasks.map((task) => store.upsertJiraTask({ ...task, reviewStatus: "pending" }));
}

/**
 * 测试 Atlassian MCP 连接,返回 `{ ok, message }`。
 * 不抛错(便于前端 `atlassian:test` handler 直接展示)。
 */
export async function testAtlassianConnection(client: McpClient): Promise<{ ok: boolean; message: string }> {
  try {
    const tools = await client.listTools();
    return { ok: true, message: `连接成功,可用工具 ${tools.length} 个` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    client.close();
  }
}
