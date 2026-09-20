/**
 * 检索关键词分析（零 LLM）：把自然语言 query 拆成 trigram 分词器可命中的 token。
 *
 * - Latin 段：按非字母数字切，保留长度 ≥2 的 token（含 `_` `.` `-` 内部字符，兼容文件名/错误码）。
 * - CJK 段：保留整段（≥2 字）；≥3 字时再切 3 字 n-gram 提升召回
 *   （FTS5 trigram tokenizer 下，短语 MATCH 等价于子串包含，n-gram 回退提升无空格问句召回）。
 */

const MAX_TOKENS = 16

const CJK_STRETCH = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g

export function analyzeKeywords(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (raw: string) => {
    const kw = raw.trim()
    if (!kw || seen.has(kw)) return
    seen.add(kw)
    out.push(kw)
  }

  for (const token of text.split(/[^A-Za-z0-9_.-]+/)) {
    if (token.length >= 2) push(token)
  }

  const cjkStretches = text.match(CJK_STRETCH) ?? []
  for (const stretch of cjkStretches) {
    if (stretch.length >= 2) push(stretch)
    if (stretch.length >= 3) {
      for (let i = 0; i + 3 <= stretch.length; i += 1) push(stretch.slice(i, i + 3))
    }
  }

  return out.slice(0, MAX_TOKENS)
}
