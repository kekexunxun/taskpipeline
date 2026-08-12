import type { McpProfile, SettingResolver, Task, TaskStore } from '@task-pipeline/core'
import { McpClient } from './mcp.js'
import { mapJiraTasks, type JiraTaskInput } from './jira.js'

/**
 * 从一段文本里提取 Jira Key(支持 `PROJ-123` 或 `https://jira.example.com/browse/PROJ-123`)。
 * 抛错当输入里没有匹配的 key,便于在 IPC 边界尽早失败。
 */
export function jiraKeyFrom(value: string): string {
  const match = value
    .trim()
    .toUpperCase()
    .match(/(?:\/BROWSE\/)?([A-Z][A-Z0-9]+-\d+)(?:[/?#]|$)/i)
  if (!match?.[1]) throw new Error('请输入有效的 Jira Key 或 browse 地址')
  return match[1]
}

/**
 * 把 MCP callTool 响应里的 `content[].text` 字段(JSON 字符串)解析为对象;
 * 如果 content 不是 text 类型或不是 JSON,返回 `{ text: <原始字符串> }`。
 * 抽到独立函数便于在 `importJiraIssue` / `syncJiraTasks` 复用。
 */
export function mcpPayload(result: unknown): any {
  const content = (result as any)?.content
  const text = Array.isArray(content) ? content.find((item: any) => item?.type === 'text')?.text : undefined
  if (typeof text !== 'string') return result
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

/**
 * Atlassian (Jira / Confluence) MCP 客户端工厂。
 * 内部根据 `kind` 选 `jira` / `confluence` 的 URL + token + env 变量,生成 `McpClient`。
 * URL 与 Token 通过 `SettingResolver` 读取(`jiraUrl` / `confluenceUrl` + `jiraToken` / `confluenceToken`)。
 */
export class AtlassianClientFactory {
  constructor(private readonly resolver: SettingResolver) {}

  isConfigured(kind: 'jira' | 'confluence'): boolean {
    const prefix = kind === 'jira' ? 'jira' : 'confluence'
    return Boolean(this.resolver.get(`${prefix}Url`) && this.resolver.getSecret(`${prefix}Token`))
  }

  create(kind: 'jira' | 'confluence'): McpClient {
    const prefix = kind === 'jira' ? 'jira' : 'confluence'
    const url = this.resolver.get(`${prefix}Url`)
    const token = this.resolver.getSecret(`${prefix}Token`)
    if (!url || !token) throw new Error(`请先配置 ${kind === 'jira' ? 'Jira' : 'Confluence'} URL 与 Token`)
    return new McpClient({
      id: 'atlassian',
      name: 'mcp-atlassian',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-atlassian'],
      env:
        kind === 'jira'
          ? { JIRA_URL: url, JIRA_PERSONAL_TOKEN: token }
          : { CONFLUENCE_URL: url, CONFLUENCE_PERSONAL_TOKEN: token },
      tools: {}
    } as McpProfile)
  }

  /** REST 校验通道的连接配置：URL+Token 未配置时返回 undefined。 */
  restConfig(kind: 'jira' | 'confluence'): AtlassianRestConfig | undefined {
    const prefix = kind === 'jira' ? 'jira' : 'confluence'
    const url = this.resolver.get(`${prefix}Url`)
    const token = this.resolver.getSecret(`${prefix}Token`)
    if (!url || !token) return undefined
    return { url, token }
  }
}

/** REST 鉴权校验连接配置（与 MCP 配置同源，供不走 MCP 的快速校验使用）。 */
export type AtlassianRestConfig = { url: string; email?: string; token: string }

/**
 * 走 REST API 直接校验 Atlassian Token（不拉起 MCP / uvx，秒级返回）。
 * - Jira：GET /rest/api/2/myself（Cloud / Server / DC 同路径）；
 * - Confluence：GET /rest/api/user/current（Cloud 实例 REST v1 挂在 /wiki 前缀下）。
 * 鉴权方式：配置了 email 用 Basic(email:token)（Cloud API Token），否则 Bearer（PAT）。
 * 判定：200 → 通过；401/403 → Token 失效；其他状态 → 校验失败。
 */
export async function testAtlassianConnectionRest(
  kind: 'jira' | 'confluence',
  config: AtlassianRestConfig
): Promise<{ ok: boolean; message: string }> {
  const base = config.url.replace(/\/$/, '')
  let endpoint: string
  if (kind === 'jira') {
    endpoint = `${base}/rest/api/2/myself`
  } else {
    let wikiBase = base
    try {
      if (/\.atlassian\.net$/i.test(new URL(base).hostname) && !/\/wiki$/i.test(base)) wikiBase = `${base}/wiki`
    } catch {
      /* URL 非法时保持原值，由 fetch 报错。 */
    }
    endpoint = `${wikiBase}/rest/api/user/current`
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: config.email
      ? `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`
      : `Bearer ${config.token}`
  }
  try {
    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) })
    if (response.ok) {
      return {
        ok: true,
        message: `连接成功,鉴权验证通过（REST ${kind === 'jira' ? '/rest/api/2/myself' : '/rest/api/user/current'}）`
      }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `Token 无效或已过期（HTTP ${response.status}），请在设置中重新配置` }
    }
    return { ok: false, message: `校验失败：HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 导入单个 Jira Issue,落库为本地 Task。
 * 入参支持 `PROJ-123` 或 `https://jira.example.com/browse/PROJ-123`。
 */
export async function importJiraIssue(client: McpClient, keyOrUrl: string, store: TaskStore): Promise<Task> {
  const key = jiraKeyFrom(keyOrUrl)
  try {
    const result = await client.callTool('jira_get_issue', { issue_key: key })
    const payload = mcpPayload(result)
    // 部分版本 mcp-atlassian 失败时不抛错也不置 isError，而是把错误文案当普通 text 返回。
    // 不在此拦截，401/404 文案会被当作 description 落库，导入一条标题为 key 的脏任务。
    const errorText = typeof payload?.text === 'string' ? payload.text : ''
    if ((result as { isError?: boolean } | undefined)?.isError || errorText) {
      if (looksLikeAuthError(errorText)) throw new Error(`Jira Token 无效或已过期：${errorText}`)
      if (looksLikeNotFoundError(errorText)) throw new Error(`Jira Issue ${key} 不存在`)
      throw new Error(errorText || `获取 Jira Issue ${key} 失败`)
    }
    const issue = payload?.issue ?? payload
    const fields = issue?.fields ?? issue
    const description =
      typeof fields?.description === 'string'
        ? fields.description
        : fields?.description
          ? JSON.stringify(fields.description)
          : (payload?.text ?? '')
    const rawUrl = /^https?:\/\//i.test(keyOrUrl.trim()) ? keyOrUrl.trim() : (issue?.url ?? issue?.self)
    // REST API URL → browse URL; 都没有则不设置 sourceUrl
    const sourceUrl = rawUrl ? rawUrl.replace(/\/rest\/api\/(?:2|3)\/issue\//i, '/browse/') : undefined
    return store.upsertJiraTask({
      taskKey: issue?.key ?? key,
      source: 'jira',
      ...(sourceUrl ? { sourceUrl } : {}),
      title: fields?.summary ?? fields?.title ?? key,
      description,
      keywords: fields?.labels ?? [],
      acceptanceCriteria: [],
      state: 'draft',
      reviewStatus: 'pending'
    })
  } finally {
    client.close()
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
    const tasks = new Map<string, JiraTaskInput & { taskKey: string }>()
    let startAt = 0
    let pageToken: string | undefined
    const finalJql = jql ?? 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
    for (let page = 0; page < 100; page += 1) {
      const result = await client.callTool('jira_search', {
        jql: finalJql,
        fields: 'summary,description,labels,status',
        limit: 50,
        start_at: startAt,
        ...(pageToken ? { page_token: pageToken } : {})
      })
      const mapped = mapJiraTasks(result)
      for (const task of mapped) if (task.taskKey) tasks.set(task.taskKey, task as JiraTaskInput & { taskKey: string })
      const payload = mcpPayload(result)
      const issueCount = Array.isArray(payload?.issues) ? payload.issues.length : mapped.length
      const total = Number(payload?.total)
      const nextPageToken =
        typeof payload?.next_page_token === 'string' && payload.next_page_token ? payload.next_page_token : undefined
      if (nextPageToken) {
        pageToken = nextPageToken
        continue
      }
      const nextStart = startAt + issueCount
      if (issueCount === 0 || (Number.isFinite(total) && total >= 0 && nextStart >= total) || issueCount < 50) break
      startAt = nextStart
    }
    return [...tasks.values()]
  } finally {
    client.close()
  }
}

/**
 * 同步 Jira 任务到本地 store,按 `taskKey` 去重,保留每个 key 的最新映射。
 */
export async function syncJiraTasks(client: McpClient, store: TaskStore, jql?: string): Promise<Task[]> {
  const tasks = await fetchJiraTasks(client, jql)
  store.setSetting('lastJiraSync', new Date().toISOString())
  return tasks.map((task) => store.upsertJiraTask({ ...task, reviewStatus: 'pending' }))
}

/**
 * 鉴权探测工具配置。
 * 不用 jira_search / confluence_search：部分实例允许匿名搜索，search 不校验 Token，
 * 错误 Token 也会被误判为通过。改用必然鉴权的 get_issue / get_page + 假 key：
 * - Token 无效 → 401/Authentication failed → 判失效；
 * - Token 有效 → 404/does not exist（凭据被接受，只是对象不存在）→ 判通过。
 */
const ATLASSIAN_PROBES: Record<'jira' | 'confluence', { candidates: string[]; args: Record<string, unknown> }> = {
  jira: { candidates: ['jira_get_issue'], args: { issue_key: 'PROBE-0' } },
  confluence: { candidates: ['confluence_get_page'], args: { page_id: '0' } }
}

/** 工具报错文案是否指向凭据问题（401/403/未授权等）。 */
function looksLikeAuthError(message: string): boolean {
  return /401|403|unauthorized|forbidden|token.*(invalid|expired)|authentication/i.test(message)
}

/** 文案是否指向「对象不存在」（404）：凭据有效、仅探测目标不存在，应视为鉴权通过。 */
function looksLikeNotFoundError(message: string): boolean {
  return /\b404\b|does not exist|not found|no issue|cannot find/i.test(message)
}

/**
 * 探测结果是否具有预期的成功形态。
 * 白名单式判定：只有真正拿到数据结构才算直接通过。
 * 部分版本的 mcp-atlassian 工具失败时不置 `isError`，而是把错误文案当普通 text 返回，
 * 只看标志位会把错误 Token 误判为通过，必须以数据形态为准。
 */
function probeHasExpectedShape(payload: unknown, kind: 'jira' | 'confluence'): boolean {
  if (kind === 'jira') {
    const issue = payload as { key?: unknown; fields?: unknown } | undefined
    return issue?.key !== undefined || issue?.fields !== undefined
  }
  const page = payload as { id?: unknown; title?: unknown } | undefined
  return page?.id !== undefined || page?.title !== undefined
}

/**
 * 测试 Atlassian MCP 连接,返回 `{ ok, message }`。
 * 不抛错(便于前端 `atlassian:test` handler 直接展示)。
 *
 * 两步探测:
 * 1. listTools 验证 MCP 握手;
 * 2. 调必然鉴权的只读工具(jira_get_issue / confluence_get_page + 假 key)验证 Token：
 *    401/未授权 → 失效；404/不存在 → 凭据有效；拿到数据形态 → 有效。
 *    部分版本 mcp-atlassian 失败时不置 isError，而是把错误文案当普通 text 返回，
 *    因此判定以文案特征 + 数据形态为准。
 */
export async function testAtlassianConnection(
  client: McpClient,
  kind?: 'jira' | 'confluence'
): Promise<{ ok: boolean; message: string }> {
  try {
    const tools = await client.listTools()
    if (!kind) return { ok: true, message: `连接成功,可用工具 ${tools.length} 个` }
    const probe = ATLASSIAN_PROBES[kind]
    const names = new Set(tools.map((tool) => (tool as { name?: string } | undefined)?.name ?? ''))
    const tool = probe.candidates.find((name) => names.has(name))
    // 未知版本的 mcp-atlassian 找不到探测工具时退回握手结果,不误报失效。
    if (!tool) return { ok: true, message: `连接成功,可用工具 ${tools.length} 个` }
    const result = (await client.callTool(tool, probe.args)) as { isError?: boolean; content?: unknown } | undefined
    const payload = mcpPayload(result)
    const text = typeof payload?.text === 'string' ? payload.text : JSON.stringify(payload ?? result)
    // 404/不存在：凭据被 API 接受，仅探测对象不存在 → 鉴权通过（无论是否置 isError）。
    if (looksLikeNotFoundError(text)) {
      return { ok: true, message: `连接成功,鉴权验证通过（${tool}）` }
    }
    // 拿到预期数据形态（极端情况下探测对象恰好存在）→ 通过。
    if (!result?.isError && probeHasExpectedShape(payload, kind)) {
      return { ok: true, message: `连接成功,鉴权验证通过（${tool}）` }
    }
    // 其余（isError 显式失败 / 错误文案）：均判为不通过。
    const detail = text || '鉴权探测失败'
    return { ok: false, message: looksLikeAuthError(detail) ? `Token 已失效或过期：${detail}` : detail }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, message: looksLikeAuthError(detail) ? `Token 已失效或过期：${detail}` : detail }
  } finally {
    client.close()
  }
}
