import { describe, expect, it } from 'vitest'
import { parsePlanDecision, sdkResultText } from './plan-content'

describe('sdkResultText', () => {
  it('preserves structured SDK results as JSON instead of object coercion', () => {
    expect(sdkResultText({ outcome: 'changes_required', plan: '1. update width' })).toBe(
      '{"outcome":"changes_required","plan":"1. update width"}'
    )
  })
})

describe('parsePlanDecision', () => {
  it('renders structured plan fields as readable markdown', () => {
    expect(
      parsePlanDecision([
        JSON.stringify({
          outcome: 'changes_required',
          plan: { steps: ['调整宽度', '补充测试'], verification: '检查详情布局' }
        })
      ])
    ).toEqual({
      outcome: 'changes_required',
      content: '## steps\n\n1. 调整宽度\n2. 补充测试\n\n## verification\n\n检查详情布局'
    })
  })

  it('parses JSON split across streaming delta fragments (碎片粒度)', () => {
    // 多轮会话重构后 responseTexts 是 delta 碎片粒度:JSON 横跨多条碎片,
    // 逐条找 JSON 会漏判 → 必须拼接后再解析。
    const fragments = [
      '{"outcome":"changes_required"',
      ',"plan":"## 目标\\n\\n1. 支持多轮',
      '\\n2. 修复解析","summary":"done"}',
      ' 补充说明'
    ]
    expect(parsePlanDecision(fragments)).toEqual({
      outcome: 'changes_required',
      content: '## 目标\n\n1. 支持多轮\n2. 修复解析'
    })
  })

  it('parses JSON wrapped in prose and code fences with trailing commas (容错)', () => {
    // 模型常见输出:开场白 + ```json 围栏 + 带尾逗号的 JSON —— 解析应成功而非回退到原文。
    const full =
      'Based on my thorough analysis, I understand the push functionality.\n\n' +
      '```json\n' +
      '{"outcome": "changes_required","plan": "## 目标\\n\\n1. 推送修复\\n2. 校验参数","summary": "done",}' +
      '\n```'
    expect(parsePlanDecision([full])).toEqual({
      outcome: 'changes_required',
      content: '## 目标\n\n1. 推送修复\n2. 校验参数'
    })
  })

  it('extracts plan body from raw text when JSON is unparseable (宽松兜底)', () => {
    // JSON 有无法修复的瑕疵(如未转义引号):展示 `"plan"` 字段正文,而不是整段原文。
    const full =
      '我分析如下: {"outcome":"changes_required","plan":"## 推送功能\\n\\n- 修复 platform 参数",' + ' 其它说明'
    const decision = parsePlanDecision([full])
    expect(decision.outcome).toBe('changes_required')
    expect(decision.content).toContain('推送功能')
    expect(decision.content).not.toContain('我分析如下')
    expect(decision.content).not.toContain('其它说明')
  })

  it('falls back to the full assembled text when no JSON is present', () => {
    const fragments = ['当前代码已满足任务要求', '，无需修改任何文件']
    const decision = parsePlanDecision(fragments)
    expect(decision.outcome).toBe('already_satisfied')
    expect(decision.content).toContain('已满足任务要求')
    expect(decision.content).toContain('无需修改任何文件')
  })

  it('does not truncate at the first raw quote when the plan value contains raw quotes/newlines (非法 JSON 容错)', () => {
    // 模型瑕疵：plan 字符串值内含裸换行与未转义双引号 → JSON.parse 必败；
    // 兜底不得在第一个裸引号处截断（真实缺陷：计划截断在「并将」）。
    const full =
      'Analysis complete.\n{"outcome":"changes_required","plan":"## 实施计划\n\n新增支付方式，并将"银行流水号"显示改为"参考号"。\n\n验证：跑构建"}'
    const decision = parsePlanDecision([full])
    expect(decision.outcome).toBe('changes_required')
    expect(decision.content).toContain('银行流水号')
    expect(decision.content).toContain('验证：跑构建')
    expect(decision.content).not.toContain('"plan"')
  })

  it('extracts to the end of text when the plan value is truncated without closing', () => {
    // 输出被 max tokens 截断：无闭合引号/括号，兜底应提取到文本末尾。
    const full = '{"outcome":"changes_required","plan":"## 实施计划\n\n1. 步骤一\n2. 步骤二'
    const decision = parsePlanDecision([full])
    expect(decision.content).toContain('步骤二')
  })
})
