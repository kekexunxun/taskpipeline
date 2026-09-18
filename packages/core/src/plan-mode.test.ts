import { describe, expect, it } from 'vitest'
import {
  PLANNER_AGENT_NAME,
  PLANNER_DISALLOWED_TOOLS,
  markPlanRequest,
  planDelegationInstruction,
  planModeInstruction,
  planSuggestionGuidance
} from './plan-mode.js'

/**
 * 计划模式的提示分层：planner 角色指令只属于子代理，主链路只拿「委派规则」与「复杂度自检」。
 * 两条链路（Qoder 子代理 / ai-sdk 嵌套子回合）共用这份口径，避免文案漂移。
 */
describe('plan-mode 提示分层', () => {
  it('planner 角色指令以子代理身份开场，并规定 Markdown 计划结构', () => {
    const instruction = planModeInstruction()
    expect(instruction).toContain(`你是 ${PLANNER_AGENT_NAME} 子代理`)
    expect(instruction).toContain('## 实施步骤')
    // 改动由主会话接手，不是「系统」黑话
    expect(instruction).toContain('由主会话接手执行')
  })

  it('委派规则常驻主链路：认标记、叫子代理、不改主线权限', () => {
    const delegation = planDelegationInstruction()
    expect(delegation).toContain('【规划委派】')
    expect(delegation).toContain(PLANNER_AGENT_NAME)
    expect(delegation).toContain('Agent 工具')
    // 关键不变量：明确告诉模型这只是委派，不是限权
    expect(delegation).toContain('不代表你失去任何工具权限')
    // 委派规则本身不得内嵌 planner 角色全文（那是子代理的 prompt）
    expect(delegation).not.toContain('## 实施步骤')
  })

  it('普通模式建议语与委派规则可共存，且互相不串味', () => {
    const guidance = planSuggestionGuidance()
    expect(guidance).toContain('【任务复杂度自检】')
    expect(guidance).not.toContain('## 实施步骤')
  })

  it('markPlanRequest 只在原文前加一行标记，不改动正文', () => {
    const marked = markPlanRequest('帮我重构登录模块')
    expect(marked.split('\n')[0]).toBe('[计划模式]')
    expect(marked.slice('[计划模式]\n'.length)).toBe('帮我重构登录模块')
  })

  it('planner 的硬边界是写类工具（Edit / Write / NotebookEdit）', () => {
    expect(PLANNER_DISALLOWED_TOOLS).toEqual(['Edit', 'Write', 'NotebookEdit'])
  })

  it('Coding 路径（带 ctx）仍复用同一份 planner 指令', () => {
    const instruction = planModeInstruction({ title: '接入 GitLab', description: '支持自建实例' })
    expect(instruction).toContain('任务：接入 GitLab')
    expect(instruction).toContain('支持自建实例')
  })
})
