/**
 * Markdown 分片器：按 heading 层级切分文档。
 *
 * 规则：
 * - 每个 heading（# / ## / ###）开始一个新段落
 * - heading 路径记录层级关系（"## 架构 > ### 数据层"）
 * - 单个段落超过 maxTokens 时按段落边界截断
 * - 空 heading 跳过
 */

export interface MarkdownChunk {
  content: string
  headingPath: string | null
  startLine: number
  endLine: number
}

/** 粗略估算 token 数（中文 ~1.5 字/token，英文 ~4 字符/token） */
export function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const nonCjk = text.length - cjkChars
  return Math.ceil(cjkChars / 1.5 + nonCjk / 4)
}

/**
 * 按 heading 切分 Markdown 文档。
 *
 * 返回段落数组，每个段落带 headingPath（如 "## 架构 > ### 数据层"）。
 */
export function splitMarkdown(content: string): MarkdownChunk[] {
  const lines = content.split('\n')
  const chunks: MarkdownChunk[] = []
  let currentLines: string[] = []
  let currentHeading: string | null = null
  const headingStack: Array<{ level: number; text: string }> = []
  let chunkStartLine = 0

  const flush = (endLine: number) => {
    const text = currentLines.join('\n').trim()
    if (text) {
      chunks.push({
        content: text,
        headingPath: currentHeading,
        startLine: chunkStartLine,
        endLine
      })
    }
    currentLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)

    if (headingMatch) {
      // 先 flush 之前的段落
      if (currentLines.length > 0) {
        flush(i - 1)
      }

      const level = headingMatch[1]!.length
      const text = headingMatch[2]!.trim()

      // 更新 heading stack
      // 弹出所有 level >= 当前 level 的
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop()
      }
      headingStack.push({ level, text })

      currentHeading = headingStack.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join(' > ')
      chunkStartLine = i
      currentLines = [line]
    } else {
      if (currentLines.length === 0) chunkStartLine = i
      currentLines.push(line)
    }
  }

  // flush 最后一段
  if (currentLines.length > 0) {
    flush(lines.length - 1)
  }

  return chunks
}
