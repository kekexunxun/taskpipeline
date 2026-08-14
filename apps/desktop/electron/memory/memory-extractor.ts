import { randomUUID } from 'node:crypto'
import type { ChatDriver } from '../chat/drivers/chat-driver.js'
import type { ChatDriverId, StoredMessage } from '../chat/chat-types.js'

export type ExtractedMemoryDraft = {
  scope: 'user' | 'repo' | 'conversation'
  title: string
  content: string
  tags: string[]
}

const MAX_TRANSCRIPT_CHARS = 12_000

function extractionPrompt(allowedScopes: ExtractedMemoryDraft['scope'][]): string {
  const hasRepo = allowedScopes.includes('repo')
  const hasUser = allowedScopes.includes('user')
  const hasConversation = allowedScopes.includes('conversation')

  const scopeDescriptions: string[] = [
    `允许的作用域(scope)只能是:${allowedScopes.map((scope) => `"${scope}"`).join('、')}`,
    '',
    '作用域判定规则（按优先级从高到低）:',
    '1. 先判断内容是否与特定项目/仓库相关（涉及具体技术栈、框架、目录结构、构建配置、',
    '   API 设计、编码规范、部署方式等）—— 如果是，归为 "repo"。',
    '2. 只有当内容纯粹描述用户个人的通用偏好、习惯、沟通方式，与任何具体项目无关时，',
    '   才归为 "user"。',
    '3. 仅属于本次对话的临时结论、待办事项，不具长期价值时，归为 "conversation"。',
    '',
    '常见误判示例（这些应该是 "repo" 而不是 "user"）:',
    '- "项目使用 React + TypeScript" → repo（技术栈）',
    '- "API 采用 RESTful 风格，分页用 cursor" → repo（架构约定）',
    '- "测试框架用 Vitest，覆盖率要求 80%" → repo（工程规范）',
    '- "数据库用 PostgreSQL，ORM 用 Drizzle" → repo（技术选型）',
    '',
    '这些才是 "user":',
    '- "用户偏好中文沟通" → user',
    '- "用户喜欢简洁的代码风格" → user',
    '- "用户习惯先写测试再写实现" → user',
    ''
  ]

  if (hasRepo) {
    scopeDescriptions.push(
      '- "repo": 特定项目的工程约定、架构决策、技术栈、编码规范、踩坑经验、任务总结 —— ',
      '  内容必须与某个具体项目相关，换到别的项目就不适用了'
    )
  }
  if (hasUser) {
    scopeDescriptions.push(
      '- "user": 用户个人的通用偏好、习惯、工作方式、沟通风格 —— ',
      '  内容必须与具体项目无关，在任何项目场景下都成立'
    )
  }
  if (hasConversation) {
    scopeDescriptions.push('- "conversation": 本次对话的临时结论、阶段性决定或后续待办')
  }

  return [
    '你是记忆整理助手。请从下面的记录中提炼出值得长期保存的记忆。',
    '',
    '只保留满足任一条件的条目:',
    '- 用户明确的偏好、习惯、常用命令、工作方式或沟通风格',
    '- 项目中值得沉淀的工程约定、架构决策、关键路径、踩坑经验',
    '- 本次对话/任务中达成的明确结论、关键决定或后续待办',
    '忽略:寒暄、过程性对话、一次性操作、与项目无关的内容。数量宁少勿多,避免重复。',
    '',
    ...scopeDescriptions,
    '',
    '只输出一个 JSON 对象,不要输出任何其他内容或 Markdown 代码块:',
    '{"memories":[{"scope":"repo","title":"简短标题(不超过20字)","content":"一句话到三句话的完整描述","tags":["标签"]}]}'
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 跑一次 chat driver 让 LLM 总结记忆。
 *
 * 设计:memory extraction 是一次性"非流式"任务,所以用 driver 自带的 streamChat 收集
 * 全部 text part 后退出。driver 的流式事件只关心 `text` / `error` 两种,其它 (thinking /
 * tool-use / tool-result) 不参与这里,只让 text 拼起来。
 *
 * 会话隔离（与关键词提取同一原则）：每次调用一次性 conversationId + 用完即关。
 * 记忆整理处理的是对话正文，比关键词更敏感 —— 此前按 `memory-extract-${context}`
 * 固定常驻会话，跨任务/跨对话共享同一会话上下文，存在内容串扰风险。
 */
export async function extractMemories(input: {
  driver: ChatDriver
  driverId: ChatDriverId
  model: string
  text: string
  context: 'chat' | 'task'
  allowedScopes: ExtractedMemoryDraft['scope'][]
  signal?: AbortSignal
  /** 所属对话回合/任务 traceId：join 同一执行树，避免辅助 LLM 调用产生独立 trace。 */
  traceId?: string
}): Promise<ExtractedMemoryDraft[]> {
  const abort = new AbortController()
  const forwardAbort = () => abort.abort()
  input.signal?.addEventListener('abort', forwardAbort, { once: true })
  // 一次性会话 id：每次整理独立上下文，结束后立刻释放（含报错/中止路径）。
  const conversationId = `memory-extract-${input.context}-${randomUUID()}`
  const userText = [
    extractionPrompt(input.allowedScopes),
    '',
    '待整理的记录(已截断):',
    input.text.slice(0, MAX_TRANSCRIPT_CHARS)
  ].join('\n\n')
  const userRecord = input.driver.serializeUserMessage({
    id: randomUUID(),
    text: userText,
    createdAt: new Date().toISOString()
  })
  const history: StoredMessage[] = [input.driver.deserializeMessage(userRecord)]
  let result = ''
  try {
    for await (const chunk of input.driver.streamChat({
      conversationId,
      model: input.model,
      history,
      userInput: { id: userRecord.id, text: userText, createdAt: userRecord.createdAt },
      signal: abort.signal,
      traceLabel: '记忆整理',
      ...(input.traceId ? { traceId: input.traceId } : {})
    })) {
      if (chunk.type === 'part' && chunk.part.type === 'text') {
        result += chunk.part.text
      } else if (chunk.type === 'error') {
        console.warn('[memory] extract llm error:', chunk.message)
      }
    }
  } catch (error) {
    console.warn('[memory] extract llm failed:', error)
  } finally {
    input.signal?.removeEventListener('abort', forwardAbort)
    // 用完即关：释放常驻会话与 qodercli 子进程（幂等，driver 错误路径可能已关过）。
    try {
      input.driver.closeSession?.(conversationId)
    } catch {
      /* 关闭失败不影响提取结果 */
    }
  }
  return parseExtractedMemories(result, input.allowedScopes)
}

export function parseExtractedMemories(
  text: string,
  allowedScopes: ExtractedMemoryDraft['scope'][]
): ExtractedMemoryDraft[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  try {
    const parsed = JSON.parse(cleaned) as { memories?: unknown }
    if (!Array.isArray(parsed.memories)) return []
    const drafts: ExtractedMemoryDraft[] = []
    for (const raw of parsed.memories) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const scope = String(item.scope ?? '')
      const title = typeof item.title === 'string' ? item.title.trim().slice(0, 60) : ''
      const content = typeof item.content === 'string' ? item.content.trim().slice(0, 2000) : ''
      const tags = Array.isArray(item.tags)
        ? item.tags
            .filter((tag): tag is string => typeof tag === 'string')
            .map((tag) => tag.trim())
            .filter(Boolean)
            .slice(0, 8)
        : []
      if (!allowedScopes.includes(scope as ExtractedMemoryDraft['scope']) || !title || !content) continue
      drafts.push({ scope: scope as ExtractedMemoryDraft['scope'], title, content, tags })
    }
    return drafts
  } catch {
    return []
  }
}
