/**
 * search_memory 工具：Chat / Task 两条链路共享的记忆检索工具定义。
 *
 * 背景：
 *  旧实现里 Chat（chat-init.ts 的 memoryContext 闭包）和 Task（memory-context.ts 的
 *  `taskMemoryContext`）各自写了一份「无条件预先检索 + 拼进 system/prompt」的流程,
 *  底层调的其实是同一个 `memoryService.search()` + `renderMemoryContext()`。两份包装代码
 *  除了注入时机不同,检索 / 渲染 / trace 采集逻辑几乎完全重复。
 *
 * 设计：
 *  - 这里只产出一条 driver-agnostic 的 `ToolDeclaration`,不关心它最终被翻译成 ai-sdk
 *    `tool()`（OpenAI driver）还是 MCP 工具（Qoder chat / Qoder task agent）；
 *  - scope（userId / repositoryIds / conversationId）在闭包里绑定,模型只填 `query`——
 *    调用方负责在正确的时机（对话轮次 / 任务会话创建）用正确的 scope 调本工厂；
 *  - trace 采集（对话侧「记忆与 Repowiki 检索」span）通过 `onSearched` 回调旁路透出,
 *    不在这里直接依赖 `TracePipeline`,保持本文件与具体 trace 实现解耦。
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import type { ToolDeclaration } from '../chat/drivers/tool-source.js'
import type { MemorySearchResult } from './memory-service.js'
import { renderMemoryContext } from './memory-service.js'

/** 本工具只需要 `MemoryService.search`；收窄到这个方法签名，方便测试注入 fake。 */
export type MemorySearchTarget = {
  search(options: {
    userId?: string
    repositoryIds?: string[]
    conversationId?: string
    query: string
  }): Promise<MemorySearchResult>
}

export type MemorySearchToolDeps = {
  userId: string
  repositoryIds?: string[]
  conversationId?: string
  memoryService: MemorySearchTarget
  /**
   * 检索完成回调（旁路观测，不影响返回值）：对话侧用它记录 trace span；任务侧不需要。
   */
  onSearched?: (query: string, result: MemorySearchResult) => void
}

/** 未命中时返回给模型的固定文案（区别于"没查"，让模型知道这次是查过了但没有结果）。 */
const NO_HIT_TEXT = '未检索到相关记忆或仓库文档。'

/**
 * 产出一条 `search_memory` 工具声明。
 *
 * @param deps 已绑定 scope 的检索依赖（userId / repositoryIds / conversationId 由调用方
 *   按当前对话或任务的实际归属传入）
 */
export function createMemorySearchTool(deps: MemorySearchToolDeps): ToolDeclaration {
  return {
    name: 'search_memory',
    description:
      '检索与当前问题相关的长期记忆与仓库 Wiki 文档(repowiki)。涉及工程约定、编码规范、历史决策或需要了解项目既有实现时，应先调用本工具再作答，不要凭空假设项目约定；若与用户最新指令冲突，以用户指令为准。',
    schema: {
      query: z.string().describe('检索关键词或自然语言问句，例如「支付模块 编码约定」')
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const query = typeof input.query === 'string' ? input.query : ''
      const result = await deps.memoryService.search({
        userId: deps.userId,
        repositoryIds: deps.repositoryIds,
        conversationId: deps.conversationId,
        query
      })
      deps.onSearched?.(query, result)
      return renderMemoryContext(result.memories, result.wikiDocs) ?? NO_HIT_TEXT
    }
  }
}

/** Pi 原生工具适配：复用检索与范围绑定，SDK 负责工具注册、提示词指引及执行事件。 */
export function createPiMemorySearchTool(deps: MemorySearchToolDeps): ToolDefinition {
  const declaration = createMemorySearchTool(deps)
  const inputSchema = z.object(declaration.schema).strict()
  return {
    name: declaration.name,
    label: '记忆检索',
    description: declaration.description,
    promptSnippet: '检索当前任务范围内的长期记忆与仓库 Wiki 文档',
    promptGuidelines: [
      '涉及工程约定、编码规范或历史决策时，先调用 search_memory 查询已有记忆；记忆与用户最新指令冲突时，以用户指令为准。'
    ],
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: declaration.schema.query?.description } },
      required: ['query'],
      additionalProperties: false
    },
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted()
      const result = await declaration.execute(inputSchema.parse(input))
      signal?.throwIfAborted()
      return {
        content: [{ type: 'text', text: typeof result === 'string' ? result : (JSON.stringify(result) ?? '') }],
        details: {}
      }
    }
  }
}
