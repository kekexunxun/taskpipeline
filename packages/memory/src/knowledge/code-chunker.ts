/**
 * 代码分片器：按 class / function / method 块切分源代码。
 *
 * 规则：
 * - 识别常见语言的函数/类定义（TypeScript、Python、Java、Go、Rust）
 * - 每个函数/类块作为一个 chunk
 * - 记录行号和涉及的符号名
 * - 非代码区域（注释块、import 区域）合并到相邻 chunk
 */

export interface CodeChunk {
  content: string
  startLine: number
  endLine: number
  symbolNames: string[]
}

/** 函数/类定义的正则模式（覆盖主流语言） */
const FUNCTION_PATTERNS: RegExp[] = [
  // TypeScript/JavaScript: function, const/let arrow, class method, export
  /^(export\s+)?(async\s+)?function\s+(\w+)/,
  /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?(\([^)]*\)|[^=])\s*=>/,
  /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?function/,
  /^\s+(async\s+)?(\w+)\s*\([^)]*\)\s*(\{|:)/,
  /^(export\s+)?class\s+(\w+)/,
  /^(export\s+)?interface\s+(\w+)/,
  /^(export\s+)?type\s+(\w+)/,
  // Python: def, class, async def
  /^(async\s+)?def\s+(\w+)/,
  /^\s*class\s+(\w+)/,
  // Java/Kotlin: method, class
  /^\s*(public|private|protected|static|\s)*\s+\w+\s+(\w+)\s*\(/,
  // Go: func
  /^func\s+(\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/,
  // Rust: fn, impl, struct, enum
  /^(pub\s+)?(async\s+)?fn\s+(\w+)/,
  /^(pub\s+)?impl\s+(<[^>]+>\s+)?(\w+)/,
  /^(pub\s+)?struct\s+(\w+)/,
  /^(pub\s+)?enum\s+(\w+)/
]

/** 提取行中的符号名 */
function extractSymbolName(line: string): string | null {
  for (const pattern of FUNCTION_PATTERNS) {
    const match = line.match(pattern)
    if (match) {
      // 取最后一个捕获组（通常是名称）
      for (let i = match.length - 1; i >= 1; i--) {
        const group = match[i]
        if (group && /^\w+$/.test(group)) return group
      }
    }
  }
  return null
}

/** 判断行是否是一个新的函数/类定义 */
function isDefinition(line: string): boolean {
  return FUNCTION_PATTERNS.some((p) => p.test(line))
}

/**
 * 按函数/类块切分代码。
 *
 * 策略：
 * 1. 扫描每行，识别函数/类定义行
 * 2. 定义行开始一个新 chunk
 * 3. 下一个定义行之前（或文件末尾）为当前 chunk 的范围
 * 4. 文件开头的非定义区域（imports、module docstring）合并到第一个 chunk
 */
export function splitCode(content: string): CodeChunk[] {
  const lines = content.split('\n')
  const defLines: number[] = []

  // 第一遍：找所有定义行
  for (let i = 0; i < lines.length; i++) {
    if (isDefinition(lines[i]!)) {
      defLines.push(i)
    }
  }

  if (defLines.length === 0) {
    // 没有定义行，整个文件作为一个 chunk
    return [
      {
        content: content.trim(),
        startLine: 0,
        endLine: lines.length - 1,
        symbolNames: []
      }
    ]
  }

  const chunks: CodeChunk[] = []

  // 文件开头到第一个定义行之前 → 前导区（合并到第一个 chunk）
  const firstDef = defLines[0]!
  let preambleLines: string[] = []
  if (firstDef > 0) {
    preambleLines = lines.slice(0, firstDef)
  }

  // 按定义行切分
  for (let i = 0; i < defLines.length; i++) {
    const start = defLines[i]!
    const end = i + 1 < defLines.length ? defLines[i + 1]! - 1 : lines.length - 1
    const chunkLines = lines.slice(start, end + 1)
    const content = chunkLines.join('\n').trim()

    if (!content) continue

    // 提取符号名
    const symbols: string[] = []
    for (const line of chunkLines) {
      const sym = extractSymbolName(line)
      if (sym && !symbols.includes(sym)) symbols.push(sym)
    }

    // 第一个 chunk 包含前导区
    const fullContent =
      i === 0 && preambleLines.length > 0 ? [...preambleLines, ...chunkLines].join('\n').trim() : content

    const fullStart = i === 0 && preambleLines.length > 0 ? 0 : start

    chunks.push({
      content: fullContent,
      startLine: fullStart,
      endLine: end,
      symbolNames: symbols
    })
  }

  return chunks
}
