/**
 * 把 driver-agnostic 的 `ToolDeclaration` 列表翻译成 Qoder SDK 的 MCP server。
 *
 * 这段原本私有在 `qoder-chat-driver.ts` 里（只服务对话侧的任务创建工具）。
 * 抽出来的唯一原因：任务侧 `draft` 阶段的澄清会话也要注入自定义工具
 * （`updateTaskDraft`），而它不走 ChatDriver，不能再复制一份翻译逻辑。
 *
 * `key` 同时是 `mcpServers` 记录里的键，SDK 侧的工具名前缀由它决定
 * （`mcp__<key>__<tool>`），因此返回完整工具名供 `allowedTools` 白名单使用；
 * server 自身的注册名用同一 key 的连字符形式，保持与历史行为一致。
 */
import type { z } from 'zod'
import { createSdkMcpServer, tool as qoderTool, type SdkMcpToolDefinition } from '@qoder-ai/qoder-agent-sdk'
import type { ToolDeclaration } from '../../chat/drivers/tool-source.js'

export type ToolSourceMcp = {
  server: ReturnType<typeof createSdkMcpServer>
  toolNames: string[]
}

/**
 * 入参收为声明列表而不是整个 `ToolSource`：一个 MCP server 可能由两组工具拼成
 * （澄清会话就是「只读查询工具 + `updateTaskDraft`」），而且任务侧不需要
 * `describeResult` 那套「这次调用是否建了任务」的语义，没必要伪装成对话侧后端。
 *
 * @param key `mcpServers` 记录键，如 `task_creation`
 * @param declarations 工具声明列表
 */
export function buildToolSourceMcp(key: string, declarations: ToolDeclaration[]): ToolSourceMcp {
  const serverName = key.replaceAll('_', '-')
  if (declarations.length === 0) {
    return { server: createSdkMcpServer({ name: serverName, version: '1.0.0', tools: [] }), toolNames: [] }
  }
  const tools: SdkMcpToolDefinition<any>[] = declarations.map((decl) => {
    const annotations = decl.annotations ?? {}
    const mcpAnnotations: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } = {}
    if (annotations.readOnlyHint) mcpAnnotations.readOnlyHint = true
    if (annotations.destructiveHint) mcpAnnotations.destructiveHint = true
    if (annotations.openWorldHint) mcpAnnotations.openWorldHint = true
    return qoderTool(
      decl.name,
      decl.description,
      decl.schema as Record<string, z.ZodTypeAny>,
      async (input: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(await decl.execute(input)) }]
      }),
      // `always_allow`：这些工具由宿主自己校验入参并落库，不该再被 CLI 的权限检查拦一次。
      { annotations: mcpAnnotations, permissionPolicy: 'always_allow' }
    )
  })
  return {
    server: createSdkMcpServer({ name: serverName, version: '1.0.0', tools }),
    toolNames: declarations.map((decl) => `mcp__${key}__${decl.name}`)
  }
}
