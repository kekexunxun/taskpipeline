/**
 * 确定性 Proposition 提取器：从代码和文档中提取原子事实，无需 LLM。
 *
 * 提取模式：
 * - docstring → fact
 * - raise 语句 → constraint
 * - security 注释 → security_rule
 * - Markdown bullet → fact / decision
 * - assert 语句 → constraint
 * - TODO/FIXME → incident
 */
import type { PropositionType, SourcePattern } from '../types.js'

export interface ExtractedProposition {
  content: string
  propositionType: PropositionType
  sourcePattern: SourcePattern
}

/**
 * 从代码内容中提取原子事实。
 *
 * 扫描每一行，按模式匹配提取 proposition。
 */
export function extractPropositionsFromCode(content: string): ExtractedProposition[] {
  const lines = content.split('\n')
  const propositions: ExtractedProposition[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()

    // 1. Security 注释: # SECURITY: ..., // SECURITY: ..., /* SECURITY: ... */
    const securityMatch = trimmed.match(/^(?:#|\/\/|\/\*|\*)\s*SECURITY:\s*(.+?)(?:\s*\*\/)?$/)
    if (securityMatch) {
      propositions.push({
        content: `Security rule: ${securityMatch[1]!.trim()}`,
        propositionType: 'security_rule',
        sourcePattern: 'security_comment'
      })
      continue
    }

    // 2. Raise 语句: raise ValueError("..."), throw new Error("...")
    const raiseMatch = trimmed.match(/^(?:raise|throw)\s+(?:new\s+)?(\w+)(?:\(|\s*\(?)(.*?)(?:\)|$)/)
    if (raiseMatch) {
      const errorType = raiseMatch[1]!
      const message = raiseMatch[2]?.trim().replace(/['"`]/g, '')
      const desc = message ? `${errorType}: ${message}` : `${errorType} is raised`
      propositions.push({
        content: `Constraint: ${desc}`,
        propositionType: 'constraint',
        sourcePattern: 'raise_statement'
      })
      continue
    }

    // 3. Assert 语句: assert condition, assert condition, "message"
    const assertMatch = trimmed.match(/^assert\s+(.+?)(?:,|$)/)
    if (assertMatch) {
      const condition = assertMatch[1]!.trim().replace(/['"`]/g, '')
      propositions.push({
        content: `Constraint: ${condition} must hold`,
        propositionType: 'constraint',
        sourcePattern: 'assert_statement'
      })
      continue
    }

    // 4. TODO/FIXME/HACK/XXX 注释
    const todoMatch = trimmed.match(/^(?:#|\/\/|\/\*|\*)\s*(TODO|FIXME|HACK|XXX):\s*(.+?)(?:\s*\*\/)?$/)
    if (todoMatch) {
      const label = todoMatch[1]!
      const desc = todoMatch[2]!.trim()
      propositions.push({
        content: `${label}: ${desc}`,
        propositionType: 'risk',
        sourcePattern: 'todo_fixme'
      })
      continue
    }

    // 5. Docstring（单行 docstring: """...""" 或 '''...'''）
    const docstringMatch = trimmed.match(/^(?:"""|'''|\/\/\/)\s*(.+?)\s*(?:"""|'''|\*\/)$/)
    if (docstringMatch && docstringMatch[1]!.length > 10) {
      const desc = docstringMatch[1]!.trim()
      // 跳过纯装饰性 docstring
      if (!/^(Args|Returns|Raises|Parameters|Yields|Note|Example)/i.test(desc)) {
        propositions.push({
          content: desc,
          propositionType: 'fact',
          sourcePattern: 'docstring'
        })
      }
      continue
    }
  }

  return propositions
}

/**
 * 从 Markdown 内容中提取原子事实。
 *
 * 提取模式：
 * - 列表项（- / * / 1.）→ fact 或 decision
 * - 粗体标记的约定（**MUST** / **NEVER** / **ALWAYS**）→ constraint
 */
export function extractPropositionsFromMarkdown(content: string): ExtractedProposition[] {
  const lines = content.split('\n')
  const propositions: ExtractedProposition[] = []

  for (const line of lines) {
    const trimmed = line.trim()

    // 1. 列表项
    const bulletMatch = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)$/)
    if (bulletMatch) {
      const text = bulletMatch[1]!.trim()
      if (text.length < 5) continue // 跳过太短的项

      // 判断类型
      if (/^(decision|decided|chosen|selected|opted)/i.test(text)) {
        propositions.push({
          content: text,
          propositionType: 'decision',
          sourcePattern: 'markdown_bullet'
        })
      } else if (/\b(MUST|NEVER|ALWAYS|SHOULD NOT|SHOULD|DO NOT|DON'T|AVOID|FORBIDDEN|REQUIRED)\b/i.test(text)) {
        propositions.push({
          content: text,
          propositionType: 'constraint',
          sourcePattern: 'markdown_bullet'
        })
      } else {
        propositions.push({
          content: text,
          propositionType: 'fact',
          sourcePattern: 'markdown_bullet'
        })
      }
      continue
    }

    // 2. 粗体约束: **MUST** ..., **NEVER** ...
    const boldConstraint = trimmed.match(/^\*\*(MUST|NEVER|ALWAYS|IMPORTANT|WARNING|CRITICAL)\*\*[:\s]+(.+)$/i)
    if (boldConstraint) {
      propositions.push({
        content: `${boldConstraint[1]!}: ${boldConstraint[2]!.trim()}`,
        propositionType: 'constraint',
        sourcePattern: 'markdown_bullet'
      })
    }
  }

  return propositions
}

/**
 * 根据 sourceType 选择合适的提取器。
 */
export function extractPropositions(
  content: string,
  sourceType: 'markdown' | 'code' | 'adr' | 'test_report' | 'log' | 'diff'
): ExtractedProposition[] {
  switch (sourceType) {
    case 'markdown':
    case 'adr':
      return extractPropositionsFromMarkdown(content)
    case 'code':
      return extractPropositionsFromCode(content)
    case 'test_report':
    case 'log':
    case 'diff':
      // 这些类型暂不提取 proposition（后续可扩展）
      return []
    default:
      return []
  }
}
