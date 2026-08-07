import { describe, expect, it } from 'vitest'
import {
  buildAgentGenerationPrompt,
  formatAgentGenerationDetail,
  formatRepoContext,
  parseAgentGenerationResult,
  type RepoContextEntry
} from './agent-generator.js'

describe('buildAgentGenerationPrompt', () => {
  it('包含用户描述、仓库路径、仓库本地背景，明确要求严格 JSON 输出', () => {
    const prompt = buildAgentGenerationPrompt({
      description: '负责 Java 服务的幂等性改造',
      repositories: [
        { id: 'r1', name: 'payment-service', localPath: '/workspaces/payment-service', defaultBranch: 'main' }
      ],
      repoContext: '### agents.md（项目内 Agent 约定）\n请使用公司规范。'
    })
    expect(prompt).toContain('Java 服务的幂等性改造')
    expect(prompt).toContain('payment-service')
    expect(prompt).toContain('/workspaces/payment-service')
    expect(prompt).toContain('默认分支 main')
    expect(prompt).toContain('请使用公司规范')
    expect(prompt).toContain('"systemPrompt"')
    expect(prompt).toContain('"engineeringGuidelines"')
    expect(prompt).toContain('"title"')
    expect(prompt).toContain('"description"')
  })

  it('用户描述为空时给出占位说明，不抛错', () => {
    const prompt = buildAgentGenerationPrompt({ description: '  ', repositories: [], repoContext: '' })
    expect(prompt).toContain('（用户未提供额外说明）')
    expect(prompt).toContain('（未选择任何仓库）')
    expect(prompt).toContain('（无仓库本地背景')
  })

  it('仓库本地背景为空时给出占位', () => {
    const prompt = buildAgentGenerationPrompt({
      description: 'X',
      repositories: [],
      repoContext: '   '
    })
    expect(prompt).toContain('（无仓库本地背景')
  })

  it('只选一个仓库时按单行展示', () => {
    const prompt = buildAgentGenerationPrompt({
      description: '前端 React 通用 Agent',
      repositories: [{ id: 'r2', name: 'web', localPath: '/workspaces/web' }],
      repoContext: ''
    })
    expect(prompt).toMatch(/1\. web\s+路径：\/workspaces\/web\s+默认分支未知/)
  })

  it('中文场景下不做翻译、保留换行', () => {
    const prompt = buildAgentGenerationPrompt({ description: '中文描述', repositories: [], repoContext: '' })
    // 提示词本身必须是中文，避免模型对输出语言产生歧义。
    expect(prompt).toMatch(/zh-CN/)
  })

  it('明确告知模型：title/description 长度上限与中文为主', () => {
    const prompt = buildAgentGenerationPrompt({ description: 'X', repositories: [], repoContext: '' })
    expect(prompt).toMatch(/title.*≤\s*20\s*字/)
    expect(prompt).toMatch(/description.*≤\s*100\s*字/)
  })
})

describe('parseAgentGenerationResult', () => {
  it('解析标准 JSON 并 trim 字段（含 title + description）', () => {
    const raw = JSON.stringify({
      title: '  Java 后端  ',
      description: '  负责 Spring Boot 服务的实现  ',
      systemPrompt: '  角色定位  ',
      engineeringGuidelines: '\n  工程约定 \n'
    })
    expect(parseAgentGenerationResult(raw)).toEqual({
      title: 'Java 后端',
      description: '负责 Spring Boot 服务的实现',
      systemPrompt: '角色定位',
      engineeringGuidelines: '工程约定'
    })
  })

  it('从 ```json 围栏中提取首个 JSON 块', () => {
    const raw = '```json\n{"title":"A","description":"B","systemPrompt":"C","engineeringGuidelines":"D"}\n```'
    expect(parseAgentGenerationResult(raw)).toEqual({
      title: 'A',
      description: 'B',
      systemPrompt: 'C',
      engineeringGuidelines: 'D'
    })
  })

  it('容忍模型在 JSON 前后输出多余文字', () => {
    const raw =
      '好的，下面是结果：\n{"title":"A","description":"B","systemPrompt":"C","engineeringGuidelines":"D"}\n以上。'
    expect(parseAgentGenerationResult(raw)).toEqual({
      title: 'A',
      description: 'B',
      systemPrompt: 'C',
      engineeringGuidelines: 'D'
    })
  })

  it('title / description 缺失或非字符串时回退为空串', () => {
    const raw = JSON.stringify({ systemPrompt: 'X', engineeringGuidelines: 'Y' })
    expect(parseAgentGenerationResult(raw)).toEqual({
      title: '',
      description: '',
      systemPrompt: 'X',
      engineeringGuidelines: 'Y'
    })
  })

  it('title 错传成数字时回退为空串', () => {
    const raw = JSON.stringify({
      title: 123,
      description: ['不是字符串'],
      systemPrompt: 'P',
      engineeringGuidelines: 'G'
    })
    expect(parseAgentGenerationResult(raw)).toEqual({
      title: '',
      description: '',
      systemPrompt: 'P',
      engineeringGuidelines: 'G'
    })
  })

  it('忽略多余字段（仅取所需四个）', () => {
    const raw = JSON.stringify({
      title: 'T',
      description: 'D',
      systemPrompt: 'X',
      engineeringGuidelines: 'Y',
      extra: '忽略'
    })
    expect(parseAgentGenerationResult(raw)).toEqual({
      title: 'T',
      description: 'D',
      systemPrompt: 'X',
      engineeringGuidelines: 'Y'
    })
  })

  it('systemPrompt / engineeringGuidelines 字段类型不符时仍能保留下有效的那一个', () => {
    const raw = JSON.stringify({ systemPrompt: 123, engineeringGuidelines: '有效' })
    expect(parseAgentGenerationResult(raw)).toEqual({
      title: '',
      description: '',
      systemPrompt: '',
      engineeringGuidelines: '有效'
    })
  })

  it('两个核心字段都为空时抛错', () => {
    const raw = JSON.stringify({ title: 'T', description: 'D', systemPrompt: '', engineeringGuidelines: '' })
    expect(() => parseAgentGenerationResult(raw)).toThrow(/都为空/)
  })

  it('完全无法解析时抛错并附带原始返回片段', () => {
    expect(() => parseAgentGenerationResult('not json at all')).toThrow(/无法解析为 JSON/)
  })

  it('顶层为基本类型时抛错', () => {
    expect(() => parseAgentGenerationResult('123')).toThrow(/不是对象/)
  })

  it('空字符串时抛「返回为空」可读错误', () => {
    expect(() => parseAgentGenerationResult('')).toThrow(/返回为空/)
  })

  it('捕获嵌套大括号字符串（不影响解析）', () => {
    const raw = 'prelude {"title":"T","description":"D","systemPrompt":"A {X} B","engineeringGuidelines":"Y"} tail'
    expect(parseAgentGenerationResult(raw)).toEqual({
      title: 'T',
      description: 'D',
      systemPrompt: 'A {X} B',
      engineeringGuidelines: 'Y'
    })
  })
})

/**
 * 「AI 生成 Agent 模板」走轻量 Qoder 调用（120s 超时、只读工具 Read/Glob/Grep、3 轮）。
 * 下面这些不变量必须维持：
 *  -  超时错误文案是用户可读的中文，不是程序内部 token；
 *  -  模型返回里能正确抽取到 4 个字段；
 *  -  即便轻量调用取了空内容，parseAgentGenerationResult 仍然报可读错误。
 */
describe('agents:generate-content 轻量调用后的解析约束', () => {
  it('Qoder 超时错误文案是中文且含“重试 / 换模型”建议', () => {
    // 由 main.ts 的 callQoderForAgentGeneration 抛出的错误消息，必须是用户可读
    const timeoutMsg =
      'Qoder 模型在 120s 内未返回。可能原因：Qoder 后端拥塞 / 网络问题 / 当前模型不在线。建议：稍后重试，或在「模型」下拉中切到 OpenAI 兼容模型。'
    expect(timeoutMsg).toMatch(/Qoder 模型/)
    expect(timeoutMsg).toMatch(/重试|换模型|OpenAI 兼容/)
  })

  it('Qoder 返回带 json 围栏的多余文本仍能解析', () => {
    const raw =
      '这是模型自言自语：\n```json\n{"title":"P","description":"D","systemPrompt":"S","engineeringGuidelines":"G"}\n```\n以上。'
    expect(parseAgentGenerationResult(raw)).toEqual({
      title: 'P',
      description: 'D',
      systemPrompt: 'S',
      engineeringGuidelines: 'G'
    })
  })

  it('Qoder 返回空字符串会报可读错误（不是 parse 异常）', () => {
    expect(() => parseAgentGenerationResult('')).toThrow(/返回为空/)
  })

  it('Qoder 返回仅有「思考过程」但无 JSON 块时报「无法解析」错误', () => {
    const raw = '我考虑一下这个 Agent 应该负责什么领域……'
    expect(() => parseAgentGenerationResult(raw)).toThrow(/无法解析为 JSON/)
  })
})

describe('formatRepoContext', () => {
  it('空 entries 返回空串（让调用方走「无背景」占位）', () => {
    expect(formatRepoContext([])).toBe('')
  })

  it('单个仓库：包含标题、wiki 列表、agents.md、README.md', () => {
    const entry: RepoContextEntry = {
      repositoryName: 'payment-service',
      localPath: '/workspaces/payment-service',
      wikiDocs: [
        { path: 'AGENTS.md', title: 'Agent 指引', content: '请使用公司规范。' },
        { path: 'architecture.md', title: '架构', content: '微服务。' }
      ],
      agentsMd: '项目内约定：所有 controller 走统一封装。',
      readme: '# payment-service\n\n支付服务。'
    }
    const out = formatRepoContext([entry])
    expect(out).toContain('### 仓库：payment-service（/workspaces/payment-service）')
    expect(out).toContain('### `AGENTS.md`（Agent 指引）')
    expect(out).toContain('请使用公司规范')
    expect(out).toContain('### `architecture.md`（架构）')
    expect(out).toContain('### agents.md（项目内 Agent 约定，优先级最高）')
    expect(out).toContain('项目内约定：所有 controller 走统一封装')
    expect(out).toContain('### README.md（项目根说明）')
    expect(out).toContain('# payment-service')
  })

  it('多个仓库用 --- 分隔', () => {
    const entries: RepoContextEntry[] = [
      {
        repositoryName: 'a',
        localPath: '/a',
        wikiDocs: [],
        agentsMd: '约定 A',
        readme: undefined
      },
      {
        repositoryName: 'b',
        localPath: '/b',
        wikiDocs: [],
        agentsMd: undefined,
        readme: 'README B'
      }
    ]
    const out = formatRepoContext(entries)
    expect(out).toContain('约定 A')
    expect(out).toContain('README B')
    expect(out).toMatch(/---\n\n/)
  })

  it('单个仓库全空时该段被省略', () => {
    const entries: RepoContextEntry[] = [
      { repositoryName: 'empty', localPath: '/e', wikiDocs: [], agentsMd: undefined, readme: undefined },
      { repositoryName: 'full', localPath: '/f', wikiDocs: [], agentsMd: '有内容', readme: undefined }
    ]
    const out = formatRepoContext(entries)
    expect(out).not.toContain('empty')
    expect(out).toContain('full')
    expect(out).toContain('有内容')
  })

  it('wiki 文档超过 5 条时只保留前 5 条', () => {
    const entry: RepoContextEntry = {
      repositoryName: 'big',
      localPath: '/big',
      wikiDocs: Array.from({ length: 8 }, (_, i) => ({
        path: `doc${i}.md`,
        title: `Doc ${i}`,
        content: `content ${i}`
      })),
      agentsMd: undefined,
      readme: undefined
    }
    const out = formatRepoContext([entry])
    expect(out).toContain('doc0.md')
    expect(out).toContain('doc4.md')
    expect(out).not.toContain('doc5.md')
    expect(out).not.toContain('doc7.md')
  })

  it('wiki 文档超长时截断并标注「已截断」', () => {
    const longContent = 'a'.repeat(3000)
    const entry: RepoContextEntry = {
      repositoryName: 'r',
      localPath: '/r',
      wikiDocs: [{ path: 'big.md', title: '大文件', content: longContent }],
      agentsMd: undefined,
      readme: undefined
    }
    const out = formatRepoContext([entry])
    expect(out).toContain('已截断')
    expect(out).toContain('原文 3000 字')
  })

  it('agents.md / README.md 超长时截断并标注', () => {
    const longAgents = 'a'.repeat(2000)
    const longReadme = 'b'.repeat(2000)
    const entry: RepoContextEntry = {
      repositoryName: 'r',
      localPath: '/r',
      wikiDocs: [],
      agentsMd: longAgents,
      readme: longReadme
    }
    const out = formatRepoContext([entry])
    // 截断点 1500 字符：超出 500 个 a 不应原样出现
    expect(out).not.toContain('a'.repeat(2000))
    expect(out).toContain('已截断')
  })

  it('buildAgentGenerationPrompt 接收 formatRepoContext 输出后能正确注入仓库本地背景', () => {
    const entry: RepoContextEntry = {
      repositoryName: 'demo',
      localPath: '/demo',
      wikiDocs: [{ path: 'AGENTS.md', title: '约定', content: '使用 DDD 风格。' }],
      agentsMd: '所有 controller 走统一封装。',
      readme: undefined
    }
    const prompt = buildAgentGenerationPrompt({
      description: 'D',
      repositories: [{ id: '1', name: 'demo', localPath: '/demo' }],
      repoContext: formatRepoContext([entry])
    })
    expect(prompt).toContain('使用 DDD 风格')
    expect(prompt).toContain('所有 controller 走统一封装')
    expect(prompt).toContain('### 仓库：demo（/demo）')
  })
})

describe('formatAgentGenerationDetail（Trace 详情面板内容）', () => {
  const fullResult = {
    title: '前端 Adaptor 适配',
    description: '负责 Adaptor 层（NaiveUI 2 + Vue 3）的页面与组件开发。',
    systemPrompt: '你是一名 Adaptor 前端 Agent，...',
    engineeringGuidelines: '1. 优先复用已有封装 ...'
  }

  it('顶部保留用户输入上下文（描述 / 参考仓库）', () => {
    const out = formatAgentGenerationDetail({
      description: 'Adaptor开发前端',
      repositoryNames: 'adaptor-suit-front-new',
      result: fullResult
    })
    expect(out).toContain('[用户输入]')
    expect(out).toContain('描述：Adaptor开发前端')
    expect(out).toContain('参考仓库：adaptor-suit-front-new')
  })

  it('中部用分隔线隔开用户输入与 AI 生成结果', () => {
    const out = formatAgentGenerationDetail({
      description: 'X',
      repositoryNames: 'r',
      result: fullResult
    })
    expect(out).toContain('──────────')
    expect(out).toContain('[AI 生成结果]')
  })

  it('4 个生成字段的实际内容都拼到 detail 里（不只显示长度）', () => {
    const out = formatAgentGenerationDetail({
      description: 'X',
      repositoryNames: 'r',
      result: fullResult
    })
    expect(out).toContain('【名称】')
    expect(out).toContain('前端 Adaptor 适配')
    expect(out).toContain('【说明】')
    expect(out).toContain('负责 Adaptor 层（NaiveUI 2 + Vue 3）的页面与组件开发')
    expect(out).toContain('【系统提示词】')
    expect(out).toContain('你是一名 Adaptor 前端 Agent')
    expect(out).toContain('【工程约定】')
    expect(out).toContain('优先复用已有封装')
  })

  it('AI 缺字段时该 section 被省略，不打占位（避免误导为模型输出）', () => {
    const out = formatAgentGenerationDetail({
      description: 'X',
      repositoryNames: 'r',
      result: { title: 'T', description: '', systemPrompt: 'P', engineeringGuidelines: 'G' }
    })
    expect(out).toContain('【名称】')
    expect(out).toContain('T')
    expect(out).not.toContain('【说明】')
    expect(out).toContain('【系统提示词】')
    expect(out).toContain('P')
  })

  it('用户描述 / 参考仓库为空时给出中文占位', () => {
    const out = formatAgentGenerationDetail({
      description: '',
      repositoryNames: '',
      result: fullResult
    })
    expect(out).toContain('描述：（未提供）')
    expect(out).toContain('参考仓库：（未选择）')
  })

  it('所有 4 个生成字段都为空时，detail 里仍然有头部 + 分隔线，不至于空 panel', () => {
    const out = formatAgentGenerationDetail({
      description: 'X',
      repositoryNames: 'r',
      result: { title: '', description: '', systemPrompt: '', engineeringGuidelines: '' }
    })
    expect(out).toContain('[用户输入]')
    expect(out).toContain('[AI 生成结果]')
    expect(out).not.toContain('【名称】')
  })
})
