/**
 * codebase_search 工具：Chat / Task 两条链路共享的「源码符号检索」工具定义。
 *
 * 复刻 memory-search-tool 的 driver-agnostic `ToolDeclaration` 模板：
 *  - 只产出一条声明，不关心它最终被翻译成 ai-sdk `tool()`（OpenAI driver）
 *    还是 MCP 工具（Qoder chat / Qoder task agent）；
 *  - 检索作用域（要搜哪些工作目录）在闭包里绑定，模型只填 `query`（符号名 / 英文关键词）；
 *  - 有界输出（30KB 硬顶 + 指针 + 5 行片段 + 签名）全在包的 formatBoundedSearch 里，
 *    本文件不拼源码、不返回完整文件内容。
 *
 * 索引服务经模块级单例 `getCodeIndex()` 取用（类比 chatTraceManager 的装配风格），
 * 服务尚未初始化（如非桌面主进程环境）时工具返回降级文案，不抛错。
 */
import { z } from 'zod'
import type { CodeIndexService, IndexRoot } from '@task-pipeline/codeindex'
import type { ToolDeclaration } from '../chat/drivers/tool-source.js'

/** 取索引服务：注入优先，否则回落模块级单例（延迟 require 避免与服务循环依赖）。 */
export type CodebaseSearchToolDeps = {
  /** 本次检索作用域：已绑定的工作目录列表（canonical 或 task worktree）。 */
  roots: IndexRoot[]
  /** 显式注入的服务实例（测试用）；缺省时经 getService() 惰性取单例。 */
  service?: CodeIndexService
  /** 缺省 service 时的取服务回调（通常传 getCodeIndex）。 */
  getService?: () => CodeIndexService | undefined
}

const SERVICE_DOWN_TEXT = '（源码索引服务未就绪，请改用 grep 定位）'

/**
 * 预热一批工作目录的源码索引：对每个 root 调 `ensureIndexed`（懒建、启动 watcher
 * 并异步首扫、不阻塞、按目录 key 去重）。在回合装配工具时调用，把首扫时间点
 * 从「模型首次调用 codebase_search」提前到「回合开始」，避免模型首撞 INDEXING_TEXT 后弃用。
 * 单个目录预热失败不影响其余，也不抛出（模型侧仍有 grep 兜底）。
 */
export function warmCodebaseSearch(service: CodeIndexService, roots: IndexRoot[]): void {
  for (const root of roots) {
    try {
      service.ensureIndexed(root.dir, root.name)
    } catch {
      /* 预热失败不影响工具挂载 */
    }
  }
}

/**
 * 静态使用指引（不依赖检索结果、恒在）：拼进 system，提醒模型「找实现/符号」时
 * 先用 codebase_search 而非盲目 grep。与 memory 的指引并列、各说各的适用场景。
 */
export const CODEBASE_SEARCH_STEERING =
  '定位某个函数/类/接口/组件的定义或了解某块实现 how-it-works 时，先调用 codebase_search 用准确符号名（英文）检索，命中会返回带文件路径与行号的指针及少量片段；它不替代 grep（全文/字符串匹配仍用 grep），也不返回完整文件内容。'

/**
 * 子代理委派补充指引（仅 Qoder 链路用）：`codebase_search` 只挂在主会话的工具管道，
 * 内置 Explore / general-purpose 子代理看不到它、只有原生 Read/Grep/Glob/Bash。若不点破，
 * 主会话习惯把「找实现」整包甩给子代理，子代理只能退回全仓 grep/read——正是 read/bash 刷屏的根因。
 * 因此明确要求：符号定位由主会话亲自先用 codebase_search 取「文件:行号」锚点，再把锚点喂给子代理或定点 Read。
 */
export const CODEBASE_SEARCH_SUBAGENT_STEERING =
  '注意：codebase_search 只有你（主会话）能调用，你委派的子代理（Explore / general-purpose / planner 等）看不到它，只会用原生 Read/Grep/Glob。需要定位某段实现的定义处时，别把探索整包丢给子代理——先由你自己调用 codebase_search 拿到「仓库/文件:行号」锚点，再带着这些具体锚点去委派子代理精读，或对锚点文件做定点 Read。只有当你已经知道确切文件路径、或要做跨全文字符串匹配（codebase_search 不支持中文描述，也不匹配任意文本片段）时，才直接委派子代理或用 grep。'

/**
 * 产出一条 `codebase_search` 工具声明。
 *
 * @param deps 已绑定检索作用域的依赖
 */
export function createCodebaseSearchTool(deps: CodebaseSearchToolDeps): ToolDeclaration {
  return {
    name: 'codebase_search',
    description:
      '在已索引的工作区仓库中按符号名/关键词检索源码结构（函数、类、接口、方法、组件等），返回「仓库/文件:行号」指针、签名与少量上下文片段。用于快速定位实现定义处；不支持中文描述，请用准确的符号名或英文关键词。',
    schema: {
      query: z.string().describe('要检索的符号名或英文关键词，如 "CodeIndexService"、"searchSymbols"'),
      maxNodes: z.number().int().positive().max(50).optional().describe('最多返回的结果条数，默认 20')
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const service = deps.service ?? deps.getService?.()
      if (!service) return SERVICE_DOWN_TEXT
      const query = typeof input.query === 'string' ? input.query : ''
      const maxNodes = typeof input.maxNodes === 'number' ? input.maxNodes : undefined
      const result = await service.search(query, deps.roots, maxNodes)
      return result.text
    }
  }
}
