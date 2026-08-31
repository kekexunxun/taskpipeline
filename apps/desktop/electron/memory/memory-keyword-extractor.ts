const FALLBACK_MAX = 10

/**
 * 从原始 query 里尽量"挤"出 trigram 可命中的 token。
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
