/**
 * Agent 内容生成器（纯函数模块，可独立单测）。
 *
 * 背景：新增 Agent 弹窗中"AI 生成"按钮——根据用户描述、仓库元信息以及
 * 仓库的 repowiki / agents.md / README.md 等本地背景，让模型一次性产出
 *  `title` / `description` / `systemPrompt` / `engineeringGuidelines`。
 *
 * 设计：
 *  - 只做 prompt 组装与结果解析，不持有任何外部依赖（不调 LLM、不读 IO）；
 *  - 仓库本地背景（repowiki 文档、agents.md、README.md）由 main.ts 读好后
 *    通过 `repoContext` 注入到这里；这样无论 Qoder 还是 OpenAI 兼容模型
 *    都能拿到一致的上下文。
 *  - 模型返回宽松 JSON：`{ title, description, systemPrompt, engineeringGuidelines }`，
 *    用"提取首个 JSON 块"策略兜底（模型偶发多余 ```json 围栏也能解析）。
 *  - 不修改也不评估语义；解析失败抛错由调用方上抛给 UI 反馈。
 */

export type AgentGenerationRepository = {
  id: string
  name: string
  localPath: string
  defaultBranch?: string
}

export type AgentGenerationInput = {
  /** 用户自然语言描述：Agent 关注什么领域、要做哪些任务、希望的产出风格。 */
  description: string
  /** 用户在弹窗中勾选的仓库（至少 0 个；空数组 = 不针对任何具体仓库）。 */
  repositories: AgentGenerationRepository[]
  /**
   * 由调用方预先读好的仓库本地背景（repowiki 文档、agents.md、README.md 等）。
   *  - 已渲染为 Markdown 片段，多个仓库之间用 `---` 分隔；
   *  - 没有仓库或读不到任何东西时，传入空字符串 `""`。
   *  单独抽离这一参数（而不是让本模块读 IO）有两个原因：
   *   1. 单元测试不依赖文件系统；
   *   2. main.ts 同时为 Qoder / OpenAI 两条路径组装 prompt，避免重复实现。
   */
  repoContext: string
}

export type AgentGenerationResult = {
  /**
   * Agent 短名称（≤ 20 字，中文为主）。
   *  - 模型给的；前端 `applyGenerated` 仅在用户原名为空时填入，避免覆盖用户输入。
   *  - 解析失败 / 缺失时为空字符串。
   */
  title: string
  /**
   * Agent 一句话说明（≤ 100 字，中文为主）。
   *  - 模型给的；前端 `applyGenerated` 仅在用户原说明为空时填入。
   *  - 解析失败 / 缺失时为空字符串。
   */
  description: string
  systemPrompt: string
  engineeringGuidelines: string
}

/** 单条仓库本地背景原始数据（由调用方从 repowiki + agents.md + README.md 读好后传入）。 */
export type RepoContextEntry = {
  repositoryName: string
  localPath: string
  /** 仓库的 repowiki 文档（按重要性顺序已截断到前 N 条 / 每条 M 字）。 */
  wikiDocs: Array<{ path: string; title: string; content: string }>
  /** 仓库根目录的 agents.md（已尝试 AGENTS.md / agents.md 两种命名）；不存在时为 undefined。 */
  agentsMd?: string
  /** 仓库根目录的 README.md；不存在时为 undefined。 */
  readme?: string
}

/** 单条 wiki 文档的字节上限（≈ 2 KB 文本，平衡信息量与 prompt 体量）。 */
const WIKI_DOC_MAX_CHARS = 2000
/** 单个仓库最多并入的 wiki 文档数（其余提示用户进 repowiki 详情查看）。 */
const WIKI_DOC_MAX_COUNT = 5
/** agents.md / README.md 的字符上限（超出截断 + 标注「…已截断」）。 */
const ROOT_FILE_MAX_CHARS = 1500

/** 把单个仓库的 wiki 文档渲染为 Markdown 片段。空数组返回空串。 */
function formatWikiDocs(wikiDocs: RepoContextEntry['wikiDocs']): string {
  if (wikiDocs.length === 0) return ''
  return wikiDocs
    .map((doc) => {
      const truncated = doc.content.length > WIKI_DOC_MAX_CHARS
      const body = truncated
        ? `${doc.content.slice(0, WIKI_DOC_MAX_CHARS)}\n…（已截断，原文 ${doc.content.length} 字）`
        : doc.content
      return `### \`${doc.path}\`（${doc.title}）\n\n${body}`
    })
    .join('\n\n')
}

/** 把根目录文件（agents.md / README.md）渲染为 Markdown 片段；undefined 跳过。 */
function formatRootFile(label: string, content: string | undefined): string {
  if (!content) return ''
  const truncated = content.length > ROOT_FILE_MAX_CHARS
  const body = truncated ? `${content.slice(0, ROOT_FILE_MAX_CHARS)}\n…（已截断，原文 ${content.length} 字）` : content
  return `### ${label}\n\n${body}`
}

/**
 * 把多个仓库的本地背景渲染为 prompt 片段。
 *  - 仓库之间用 `---` 分隔；
 *  - 单个仓库若全空（无 wiki / 无 agents.md / 无 README.md），整段省略；
 *  - 全部为空时返回空串，让调用方走「无仓库本地背景」占位。
 */
export function formatRepoContext(entries: RepoContextEntry[]): string {
  const sections: string[] = []
  for (const entry of entries) {
    const wikiSection = formatWikiDocs(entry.wikiDocs.slice(0, WIKI_DOC_MAX_COUNT))
    const agentsSection = formatRootFile('agents.md（项目内 Agent 约定，优先级最高）', entry.agentsMd)
    const readmeSection = formatRootFile('README.md（项目根说明）', entry.readme)
    const body = [wikiSection, agentsSection, readmeSection].filter(Boolean).join('\n\n')
    if (!body) continue
    sections.push([`### 仓库：${entry.repositoryName}（${entry.localPath}）`, body].filter(Boolean).join('\n\n'))
  }
  return sections.join('\n\n---\n\n')
}

/**
 * 把 AI 生成结果拼成 Trace 详情面板的纯文本内容。
 *  - 顶部：用户输入上下文（描述 / 参考仓库），方便回顾「为什么生成」；
 *  - 分隔线后：4 个生成字段的实际内容（name / description / systemPrompt / engineeringGuidelines），
 *    缺字段时省略该 section 而不是打占位（避免误导用户以为是模型输出）。
 *  - 直接喂给 Timeline 的 `<pre>` 渲染（whitespace-pre-wrap）；不使用 markdown 语法。
 */
export function formatAgentGenerationDetail(input: {
  description: string
  repositoryNames: string
  result: AgentGenerationResult
}): string {
  const parts: string[] = []
  parts.push('[用户输入]')
  parts.push(`描述：${input.description || '（未提供）'}`)
  parts.push(`参考仓库：${input.repositoryNames || '（未选择）'}`)
  parts.push('')
  parts.push('──────────')
  parts.push('')
  parts.push('[AI 生成结果]')
  if (input.result.title) {
    parts.push('')
    parts.push('【名称】')
    parts.push(input.result.title)
  }
  if (input.result.description) {
    parts.push('')
    parts.push('【说明】')
    parts.push(input.result.description)
  }
  if (input.result.systemPrompt) {
    parts.push('')
    parts.push('【系统提示词】')
    parts.push(input.result.systemPrompt)
  }
  if (input.result.engineeringGuidelines) {
    parts.push('')
    parts.push('【工程约定】')
    parts.push(input.result.engineeringGuidelines)
  }
  return parts.join('\n')
}

/** 仓库列表渲染为 prompt 片段；空数组 = 一行占位。 */
function formatRepositories(repositories: AgentGenerationRepository[]): string {
  if (repositories.length === 0) {
    return '（未选择任何仓库）'
  }
  return repositories
    .map((repository, index) => {
      const branch = repository.defaultBranch ? `默认分支 ${repository.defaultBranch}` : '默认分支未知'
      return `${index + 1}. ${repository.name}  路径：${repository.localPath}  ${branch}`
    })
    .join('\n')
}

/**
 * 拼出调 LLM 的最终 prompt。
 *
 * 输入：用户描述 + 选中的仓库（提供本地路径、默认分支等元信息）+ 仓库本地背景（repowiki 等）。
 * 输出：明确的「请输出 JSON」指令 + 字段含义说明 + 仓库背景，让模型可以直接当作 system role 写入。
 */
export function buildAgentGenerationPrompt(input: AgentGenerationInput): string {
  const description = input.description.trim() || '（用户未提供额外说明）'
  const repositories = formatRepositories(input.repositories)
  const repoContext =
    input.repoContext.trim() || '（无仓库本地背景：未选择仓库或本地读不到 agents.md / README.md / repowiki）'
  return [
    '你是一名资深架构师，需要根据用户描述与所选仓库的本地背景，为一个 Coding Agent 生成「系统提示词」与「工程约定」。',
    '这个 Agent 后续会被注入到所有阶段 prompt（plan / implementation / test_generation / review）里，仅约束其行为风格与领域知识。',
    '',
    '## 用户原始说明',
    description,
    '',
    '## 选中的仓库（仅供技术栈推断；不要复述路径，不要把仓库名当作硬性目标）',
    repositories,
    '',
    '## 仓库本地背景（必读：优先采用这些真实约定，不要凭空捏造框架名）',
    repoContext,
    '',
    '## 输出要求（严格遵守）',
    '- 仅输出一个 JSON 对象，不要任何解释、markdown 围栏或前后缀文本；',
    '- `title`：Agent 短名称，≤ 20 字，中文为主；不要包含空格外的标点；',
    '- `description`：一句话说明（≤ 100 字，中文为主）讲清楚"这个 Agent 关注什么领域 / 擅长什么任务"；',
    '- `systemPrompt`：Agent 的角色定位 + 领域知识 + 编码风格硬性约束；使用仓库本地背景中已存在的约定优先（不要凭空捏造新框架名）；',
    '- `engineeringGuidelines`：实现前/中需要遵守的工程流程，如：先查看哪些现有文件、复用哪些工具类、提交流程、测试策略。',
    '  当用户没有明确说明时，给出与仓库技术栈一致的可执行约定。',
    '- 字段值用中文（zh-CN）；保留必要的列表/换行（用 `\\n`）。',
    '- 不要输出仓库名之外的任何具体业务字段（如订单号、金额、用户 ID）。',
    '',
    '## 输出 JSON 形态',
    '{"title":"<string>","description":"<string>","systemPrompt":"<string>","engineeringGuidelines":"<string>"}'
  ].join('\n')
}

/**
 * 从模型原始返回中解析 `AgentGenerationResult`。
 *
 * 容错策略（按顺序）：
 *  1. 直接 JSON.parse；
 *  2. 抓取首个 `{...}` 块（处理 ```json 围栏、首尾多余文本等）；
 *  3. 校验字段形态。
 *
 * 关于 `title` / `description`：
 *  - 都是可选字符串；缺失 / 非字符串时回退为空串。
 *  - 但 `systemPrompt` 与 `engineeringGuidelines` 至少要有 1 个非空，否则视为生成失败。
 */
export function parseAgentGenerationResult(raw: string): AgentGenerationResult {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('模型返回为空，请重试或换一个模型')
  const candidate = extractFirstJsonObject(trimmed) ?? trimmed
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (reason) {
    throw new Error(
      `模型返回无法解析为 JSON：${reason instanceof Error ? reason.message : String(reason)}\n原始返回：${trimmed.slice(0, 240)}`
    )
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('模型返回不是对象')
  }
  const object = parsed as Record<string, unknown>
  const title = typeof object.title === 'string' ? object.title.trim() : ''
  const description = typeof object.description === 'string' ? object.description.trim() : ''
  const systemPrompt = typeof object.systemPrompt === 'string' ? object.systemPrompt.trim() : ''
  const engineeringGuidelines =
    typeof object.engineeringGuidelines === 'string' ? object.engineeringGuidelines.trim() : ''
  if (!systemPrompt && !engineeringGuidelines) {
    throw new Error('模型返回的 systemPrompt 与 engineeringGuidelines 都为空')
  }
  return { title, description, systemPrompt, engineeringGuidelines }
}

/** 抓取文本中第一个大括号匹配的 JSON 对象（不考虑嵌套字符串内的 `{}` —— prompt 简单，无需更复杂）。 */
function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}
