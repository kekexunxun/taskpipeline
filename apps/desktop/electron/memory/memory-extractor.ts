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
  return [
    '你是记忆整理助手。请从下面的记录中提炼出值得长期保存的记忆。',
    '',
    '只保留满足任一条件的条目:',
    '- 用户明确的偏好、习惯、常用命令、工作方式或沟通风格',
    '- 项目中值得沉淀的工程约定、架构决策、关键路径、踩坑经验',
    '- 本次对话/任务中达成的明确结论、关键决定或后续待办',
    '忽略:寒暄、过程性对话、一次性操作、与项目无关的内容。数量宁少勿多,避免重复。',
    '',
    `允许的作用域(scope)只能是:${allowedScopes.map((scope) => `"${scope}"`).join('、')}`,
    allowedScopes.includes('repo') ? '- "repo":工程约定、项目信息、任务总结等值得沉淀到仓库的内容' : '',
    allowedScopes.includes('user') ? '- "user":用户偏好、习惯、工作方式' : '',
    allowedScopes.includes('conversation') ? '- "conversation":本次对话的临时结论或待办' : '',
    '',
    '只输出一个 JSON 对象,不要输出任何其他内容或 Markdown 代码块:',
    '{"memories":[{"scope":"user","title":"简短标题(不超过20字)","content":"一句话到三句话的完整描述","tags":["标签"]}]}'
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
