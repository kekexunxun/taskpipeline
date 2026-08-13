/**
 * Chat 页 MCP 服务的 stdio 配置翻译层（Qoder / OpenAI 两个 driver 共用）。
 *
 * 用户在对话里勾选的 MCP 服务（内置 gitlab / jira / confluence + 自定义）最终要真正注入模型：
 *  - Qoder driver：翻译成 SDK `Options.mcpServers` 的 stdio 配置；
 *  - OpenAI driver：用 McpClient 连上后桥接成 ai-sdk 工具。
 * 配置来源是统一 mcp.json（见 mcp-config.ts）：
 *  - 内置服务的凭据（URL / Token）由主进程通过 credentials 注入（不落盘 mcp.json）；
 *  - 自定义服务参数/凭据原样来自 mcp.json；
 *  - enabled=false 的条目解析为 undefined（driver 不注入，选择器侧也置灰，双保险）。
 */

import type { McpProfile } from '@task-pipeline/core'
import type { McpServerEntry } from './mcp-config.js'
import type { McpServiceId } from './chat-types.js'

/** 按服务 id 解析 McpProfile；未找到 / 未启用 / 凭据缺失时该服务返回 undefined（跳过注入）。 */
export type McpServiceProfileResolver = (serviceId: McpServiceId) => McpProfile | undefined

/**
 * 生成 Chat MCP 服务解析器。
 * @param loadServers 读取统一 mcp.json 的服务列表（每次调用实时读，配置修改立即生效）。
 * @param credentials 凭据读取器（内置服务 URL/Token 由主进程注入）。
 */
export function createMcpServiceResolver(
  loadServers: () => McpServerEntry[],
  credentials: {
    getSetting(key: string): string | undefined
    getSecret(key: string): string | undefined
  }
): McpServiceProfileResolver {
  return (serviceId) => {
    const entry = loadServers().find((s) => s.id === serviceId && s.enabled)
    if (!entry) return undefined
    return entry.builtin ? resolveBuiltinProfile(entry, credentials) : resolveCustomProfile(entry)
  }
}

/** 自定义服务：参数/凭据全部来自 mcp.json。 */
function resolveCustomProfile(entry: McpServerEntry): McpProfile {
  return {
    id: entry.id,
    name: entry.name,
    transport: entry.transport,
    ...(entry.transport === 'stdio'
      ? { command: entry.command ?? '', args: entry.args ?? [] }
      : { url: entry.url ?? '' }),
    ...(entry.env && Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
    ...(entry.headers && Object.keys(entry.headers).length > 0 ? { headers: entry.headers } : {}),
    tools: {}
  }
}

/** 内置服务：参数来自 mcp.json 默认值，凭据由 credentials 注入（保持历史行为）。 */
function resolveBuiltinProfile(
  entry: McpServerEntry,
  credentials: {
    getSetting(key: string): string | undefined
    getSecret(key: string): string | undefined
  }
): McpProfile | undefined {
  if (entry.id === 'gitlab') {
    const token = credentials.getSecret('gitlabToken')
    if (!token) return undefined
    const url = credentials.getSetting('gitlabUrl')?.trim().replace(/\/$/, '')
    return {
      id: entry.id,
      name: entry.name,
      transport: 'stdio',
      command: entry.command ?? 'npx',
      args: entry.args ?? ['-y', '@zereight/mcp-gitlab'],
      env: {
        GITLAB_PERSONAL_ACCESS_TOKEN: token,
        ...(url ? { GITLAB_API_URL: `${url}/api/v4` } : {})
      },
      tools: {}
    }
  }
  // jira / confluence：同一 uvx mcp-atlassian，按 id 注入不同环境变量。
  const url = credentials.getSetting(`${entry.id}Url`)?.trim()
  const token = credentials.getSecret(`${entry.id}Token`)
  if (!url || !token) return undefined
  const env: Record<string, string> =
    entry.id === 'jira'
      ? { JIRA_URL: url, JIRA_PERSONAL_TOKEN: token }
      : { CONFLUENCE_URL: url, CONFLUENCE_PERSONAL_TOKEN: token }
  return {
    id: entry.id,
    name: entry.name,
    transport: 'stdio',
    command: entry.command ?? 'uvx',
    args: entry.args ?? ['mcp-atlassian'],
    env,
    tools: {}
  }
}
