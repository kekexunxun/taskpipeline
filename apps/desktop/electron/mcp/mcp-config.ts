/**
 * MCP 配置统一管理（dataDir/mcp.json）。
 *
 * 背景：MCP 服务此前硬编码为三个固定服务（gitlab/jira/confluence），散落三处重复
 * （chat/mcp-services.ts、integrations jira-mcp.ts、main.ts testGitlabMcp）。本模块是
 * MCP 配置的唯一真相：
 *  - 内置三个服务启动时自动合并写入（builtin=true，不允许修改参数/删除，仅可切换 enabled）；
 *  - 自定义服务由设置页弹窗维护（可增/改/删/启停）；
 *  - 内置服务的凭据（URL/Token）不落盘，运行时由 resolver 从 store/keyStore 注入；
 *  - 自定义服务 env/headers 原样持久化（与 .mcp.json 行业惯例一致）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type McpServerTransport = 'stdio' | 'sse' | 'streamable-http'

export type McpServerEntry = {
  id: string
  name: string
  description?: string
  /** 内置服务（gitlab/jira/confluence）：不可修改参数/删除，仅可切换 enabled。 */
  builtin: boolean
  enabled: boolean
  transport: McpServerTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export type McpConfigFile = {
  version: 1
  servers: McpServerEntry[]
}

/** 内置三个服务（参数与旧 mcp-services.ts / main.ts testGitlabMcp 一致，凭据不落盘）。 */
export const BUILTIN_MCP_SERVERS: McpServerEntry[] = [
  {
    id: 'gitlab',
    name: 'GitLab MCP',
    description: '通过 MCP 协议让 AI 访问 GitLab 数据（npx @zereight/mcp-gitlab）。',
    builtin: true,
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@zereight/mcp-gitlab']
  },
  {
    id: 'jira',
    name: 'Jira MCP',
    description: '通过 MCP 协议让 AI 访问 Jira 数据（uvx mcp-atlassian）。',
    builtin: true,
    enabled: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-atlassian']
  },
  {
    id: 'confluence',
    name: 'Confluence MCP',
    description: '通过 MCP 协议让 AI 访问 Confluence 数据（uvx mcp-atlassian）。',
    builtin: true,
    enabled: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-atlassian']
  }
]

/** 内置服务 id 集合（保护：不允许修改参数/删除）。 */
export const BUILTIN_MCP_IDS = new Set(BUILTIN_MCP_SERVERS.map((s) => s.id))

/** 合并内置：文件里缺失的内置项按默认值补入；已存在的仅确保 builtin 标志，不覆盖用户数据。 */
function mergeBuiltins(servers: McpServerEntry[]): McpServerEntry[] {
  const byId = new Map(servers.map((s) => [s.id, s]))
  for (const builtin of BUILTIN_MCP_SERVERS) {
    const existing = byId.get(builtin.id)
    if (!existing) {
      byId.set(builtin.id, { ...builtin })
    } else {
      byId.set(builtin.id, { ...existing, builtin: true })
    }
  }
  return [...byId.values()]
}

/** 读取 mcp.json（不存在或损坏时回落为内置三服务，不抛错）。 */
export function loadMcpServers(filePath: string): McpServerEntry[] {
  if (!existsSync(filePath)) {
    return BUILTIN_MCP_SERVERS.map((s) => ({ ...s }))
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<McpConfigFile>
    const servers = Array.isArray(raw.servers)
      ? (raw.servers as McpServerEntry[]).filter((s) => s && typeof s.id === 'string' && s.id)
      : []
    return mergeBuiltins(servers)
  } catch {
    return BUILTIN_MCP_SERVERS.map((s) => ({ ...s }))
  }
}

/** 写 mcp.json（自动合并内置后落盘）。 */
export function saveMcpServers(filePath: string, servers: McpServerEntry[]): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const merged = mergeBuiltins(servers)
  const file: McpConfigFile = { version: 1, servers: merged }
  writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf8')
}

/**
 * 校验单个条目（设置页保存前调用）。返回错误信息或 null。
 * - 内置条目：仅允许切换 enabled，参数锁定（编辑模式校验时忽略其余字段）；
 * - 自定义条目：id 合法性 / 重名（含内置 id）/ transport 与 command|url 配套。
 */
export function validateMcpServerEntry(
  input: Partial<McpServerEntry>,
  existing: McpServerEntry[],
  editingId?: string
): string | null {
  const id = input.id?.trim()
  if (!id) return 'id 不能为空'
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return 'id 仅允许字母、数字、下划线、连字符'
  const isBuiltinEdit = BUILTIN_MCP_IDS.has(id)
  if (!isBuiltinEdit && existing.some((s) => s.id === id && s.id !== editingId)) return `id "${id}" 已存在`
  if (isBuiltinEdit && id !== editingId) return `id "${id}" 是内置服务，不能复用`
  // 内置：只校验 enabled（布尔），其余参数不允许改（由 save 端强制锁定）。
  if (isBuiltinEdit) {
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return 'enabled 必须是布尔值'
    return null
  }
  if (!input.name?.trim()) return '名称不能为空'
  if (input.transport !== 'stdio' && input.transport !== 'sse' && input.transport !== 'streamable-http')
    return 'transport 必须是 stdio / sse / streamable-http'
  if (input.transport === 'stdio' && !input.command?.trim()) return 'stdio 传输需要填写 command'
  if (input.transport !== 'stdio' && !input.url?.trim()) return 'sse / http 传输需要填写 url'
  return null
}
