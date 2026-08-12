import { randomUUID } from 'node:crypto'
import type { ChatDriver } from '../chat/drivers/chat-driver.js'
import type { ChatDriverId, StoredMessage } from '../chat/chat-types.js'

const MAX_KEYWORDS = 10
const FALLBACK_MAX = 10
const MAX_QUERY_CHARS = 2000

/**
 * 把查询词转成 FTS5 trigram 可命中的关键词。
 *
 * 设计动机：原 FTS5 默认用 unicode61 处理中文按码点切，召回几乎为 0。
 * 现已切到 `tokenize='trigram'`，但 trigram 至少要 3 字符建索引，单独短词查不到；
 * 多个关键词用 OR 合并 + bm25() 排序，由"长尾词"兜住"短词"才算稳。
 *
 * 因此关键词提取的首要目标是**产出几个高区分度、长度 ≥3 的检索词**，
 * 而非"还原用户原句的语义"。
 */
function keywordExtractionPrompt(): string {
  return [
    '你是检索关键词提取助手。',
    '从用户的查询/提示中提取能在全文索引里真正命中候选文档的检索词。',
    '',
    '挑选规则：',
    '- 优先具体实体：项目名 / 模块名 / 技术术语 / 函数名 / 错误码 / 接口路径 / 工具名 / 文件名',
    '- 优先动作短语：用户想做什么（排查、修复、迁移、重构、查询、配置、部署…）',
    '- 避免泛词（「这个」「那个」「帮我」「怎么」「如何」）和常见停用词',
    '- 中英文混排时分别列出，不要拼成整体；保留原始大小写与专有名词',
    '',
    '格式要求：',
    `- 输出一个 JSON 对象，keywords 是字符串数组，元素 1~${MAX_KEYWORDS} 个`,
    '- 单个关键词建议 ≥3 字符（≤2 字符也能写，但需要搭配长词一起出现才有效）',
    '- 只输出 JSON，禁止任何解释 / Markdown 包裹：',
    '{"keywords":["关键词1","关键词2"]}'
  ].join('\n')
}

/**
 * 调一次 chat driver 让 LLM 提取关键词。
 *
 * 与 memory-extractor 同源：driver.streamChat 是异步流，循环收集 text part 后退出；
 * 失败 / 解析为空时回退到 `fallbackKeywords` 兜底（不抛错，避免检索链路被关键词阶段卡死）。
 *
 * 会话隔离：每次调用使用一次性 conversationId，用完即关（finally closeSession）。
 * 此前固定用 'memory-keyword-extract' 常驻会话 —— Qoder driver 按 conversationId 持有
 * 活 qodercli 子进程且会话上下文跨调用累积，跨任务/跨对话的关键词内容会互相串扰，
 * 既影响数据隔离也拉低提取质量。牺牲进程复用换隔离；OpenAI 路径无状态天然隔离
 * （closeSession 未实现，?. 调用为空操作）。
 */
export async function extractKeywords(input: {
  driver: ChatDriver
  driverId: ChatDriverId
  model: string
  text: string
  signal?: AbortSignal
  /** 所属对话回合/任务 traceId：join 同一执行树，避免辅助 LLM 调用产生独立 trace。 */
  traceId?: string
}): Promise<string[]> {
  const abort = new AbortController()
  const forwardAbort = () => abort.abort()
  input.signal?.addEventListener('abort', forwardAbort, { once: true })
  // 一次性会话 id：每次提取独立上下文，结束后立刻释放（含报错/中止路径）。
  const conversationId = `memory-keyword-extract-${randomUUID()}`
  const userText = [keywordExtractionPrompt(), '', '用户输入:', input.text.slice(0, MAX_QUERY_CHARS)].join('\n')
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
      traceLabel: '关键词提取',
      ...(input.traceId ? { traceId: input.traceId } : {})
    })) {
      if (chunk.type === 'part' && chunk.part.type === 'text') {
        result += chunk.part.text
      } else if (chunk.type === 'error') {
        console.warn('[memory] keyword extract llm error:', chunk.message)
      }
    }
  } catch (error) {
    console.warn('[memory] keyword extract llm failed:', error)
  } finally {
    input.signal?.removeEventListener('abort', forwardAbort)
    // 用完即关：释放常驻会话与 qodercli 子进程。幂等 —— driver 内部错误路径
    // 可能已 closeSession 过同一个 id，重复关闭为空操作。
    try {
      input.driver.closeSession?.(conversationId)
    } catch {
      /* 关闭失败不影响提取结果 */
    }
  }
  const parsed = parseExtractedKeywords(result)
  if (parsed.length) return parsed
  return fallbackKeywords(input.text)
}

/**
 * 从 LLM 输出里解析关键词。容错链：直接 JSON.parse → 从文本里抓最外层 {...} → 抓所有
 * 被双引号包裹的字符串。注：JSON 解析成功但 `keywords` 不是数组时不再走引号扫描，
 * 避免把 JSON 的 key / 非数组 value 误判为关键词。
 */
export function parseExtractedKeywords(text: string): string[] {
  if (!text) return []
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  let jsonObj: { keywords?: unknown } | undefined
  try {
    jsonObj = JSON.parse(stripped)
  } catch {
    const objMatch = findTopLevelJsonObject(stripped)
    if (objMatch) {
      try {
        jsonObj = JSON.parse(objMatch)
      } catch {
        /* 下面会走纯引号扫描 */
      }
    }
  }
  if (jsonObj) {
    return Array.isArray(jsonObj.keywords) ? dedupeKeywords(jsonObj.keywords, MAX_KEYWORDS) : []
  }
  const candidates: unknown[] = []
  for (const m of stripped.matchAll(/"([^"\\]{1,60})"/g)) candidates.push(m[1])
  return dedupeKeywords(candidates, MAX_KEYWORDS)
}

/**
 * 拿不到 LLM 关键词时，从原始 query 里尽量"挤"出 trigram 可命中的 token。
 *
 * - Latin 段：按非字母数字切，长度 ≥1 都保留（短词单独不命中但 OR 里靠长词兜底）。
 * - CJK 段：保留整段（≥2 字）；≥3 字时再切 3 字 n-gram 提升召回。
 * - 数字、错误码、文件名里的标点保留：允许 `-` `_` `.` 作为 token 内部字符。
 */
export function fallbackKeywords(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (raw: string) => {
    const kw = raw.trim()
    if (!kw || seen.has(kw)) return
    seen.add(kw)
    out.push(kw)
  }

  for (const token of text.split(/[^A-Za-z0-9_.-]+/)) {
    if (token.length > 0) push(token)
  }

  const cjkStretches = text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []
  for (const stretch of cjkStretches) {
    if (stretch.length >= 2) push(stretch)
    if (stretch.length >= 3) {
      for (let i = 0; i + 3 <= stretch.length; i += 1) push(stretch.slice(i, i + 3))
    }
  }

  return out.slice(0, FALLBACK_MAX)
}

function dedupeKeywords(items: unknown[], limit: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    if (typeof raw !== 'string') continue
    const kw = raw.trim()
    if (!kw) continue
    if (seen.has(kw)) continue
    seen.add(kw)
    out.push(kw)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 在 `text` 里定位最外层的 `{...}`（允许内部嵌套），找不到返回 undefined。
 * 用于 LLM 在 JSON 之外夹了开场白/解释的场景。
 */
function findTopLevelJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}
