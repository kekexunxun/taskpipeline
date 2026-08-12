/**
 * Chat 页 MCP 服务的 stdio 配置翻译层（Qoder / OpenAI 两个 driver 共用）。
 *
 * 用户在对话里勾选的 MCP 服务（gitlab / jira / confluence）最终要真正注入模型：
 *  - Qoder driver：翻译成 SDK `Options.mcpServers` 的 stdio 配置；
 *  - OpenAI driver：用 McpClient 连上后桥接成 ai-sdk 工具。
 * 凭据（URL / Token）由主进程通过 `McpServiceProfileResolver` 注入（复用
 * protectedValue / store 的现有凭据），driver 本身不感知凭据来源。
 */

import type { McpProfile } from '@task-pipeline/core'
import type { McpServiceId } from './chat-types.js'

/** 按服务 id 解析 stdio McpProfile；凭据缺失时该服务返回 undefined（跳过注入）。 */
export type McpServiceProfileResolver = (serviceId: McpServiceId) => McpProfile | undefined

/**
 * 生成 Chat MCP 服务解析器。凭据读取器由主进程注入：
 * - gitlab：gitlabUrl（可选）+ gitlabToken → `npx -y @zereight/mcp-gitlab`；
 * - jira / confluence：对应 Url + Token → `uvx mcp-atlassian`（与 AtlassianClientFactory 同源配置）。
 */
export function createMcpServiceResolver(credentials: {
  getSetting(key: string): string | undefined
  getSecret(key: string): string | undefined
}): McpServiceProfileResolver {
  return (serviceId) => {
    if (serviceId === 'gitlab') {
      const token = credentials.getSecret('gitlabToken')
      if (!token) return undefined
      const url = credentials.getSetting('gitlabUrl')?.trim().replace(/\/$/, '')
      const profile: McpProfile = {
        id: 'gitlab',
        name: 'GitLab MCP',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@zereight/mcp-gitlab'],
        env: {
          GITLAB_PERSONAL_ACCESS_TOKEN: token,
          ...(url ? { GITLAB_API_URL: `${url}/api/v4` } : {})
        },
        tools: {}
      }
      return profile
    }
    const url = credentials.getSetting(`${serviceId}Url`)?.trim()
    const token = credentials.getSecret(`${serviceId}Token`)
    if (!url || !token) return undefined
    const profile: McpProfile = {
      id: serviceId,
      name: 'mcp-atlassian',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-atlassian'],
      env:
        serviceId === 'jira'
          ? { JIRA_URL: url, JIRA_PERSONAL_TOKEN: token }
          : { CONFLUENCE_URL: url, CONFLUENCE_PERSONAL_TOKEN: token },
      tools: {}
    }
    return profile
  }
}
