/**
 * 数据脱敏（关键）—— 入库前统一递归过滤敏感字段。
 *
 * 在 Bus/Processor 层对 span 的 input / output / meta / error 全字段执行，
 * 静态 HTML 或展示层无法做到的"落盘前过滤"在这里完成。
 *
 * 策略：
 * 1. key 名匹配（大小写不敏感）：password / api_key / token / secret / authorization 等 → 整个值替换；
 * 2. 值模式匹配：Bearer <token>、JWT、sk- 前缀 key、超长 base64/hex 疑似密钥 → 替换；
 * 3. 递归遍历对象 / 数组，全树脱敏。
 */

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|api[_-]?key|apikey|secret|token|authorization|auth|credential|private[_-]?key|access[_-]?key|bearer|cookie|session[_-]?id|set[_-]?cookie)/i

/** 值模式：常见密钥格式（Bearer / sk- / JWT / 超长 base64 或 hex）。 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

/** 替换占位（保留长度提示便于排查）。 */
function redactMarker(original: unknown): string {
  if (typeof original === 'string' && original.length > 0) return `[REDACTED:${original.length} chars]`
  return '[REDACTED]'
}

/**
 * 递归脱敏任意 JSON 值（对象 / 数组 / 字符串 / 标量）。
 * - 命中敏感 key 名的字段整体替换；
 * - 字符串值命中敏感格式时替换。
 */
export function redactSecretsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE_PATTERNS.some((re) => re.test(value))) return redactMarker(value)
    return value
  }
  if (Array.isArray(value)) {
    const changed = value.map((item) => redactSecretsDeep(item))
    return changed.every((item, i) => Object.is(item, value[i])) ? value : changed
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    let dirty = false
    for (const [key, val] of Object.entries(record)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = redactMarker(val)
        dirty = true
      } else {
        const next = redactSecretsDeep(val)
        out[key] = next
        if (!Object.is(next, val)) dirty = true
      }
    }
    return dirty ? out : value
  }
  return value
}

/**
 * span 级脱敏入口：对 input / output / meta / error 全字段执行，
 * 并同步更新 name（工具名/模型名一般安全，但防御式处理）。
 */
export function redactSpan(value: { input?: unknown; output?: unknown; meta?: unknown; error?: unknown }): {
  input?: unknown
  output?: unknown
  meta?: unknown
  error?: unknown
} {
  const out: { input?: unknown; output?: unknown; meta?: unknown; error?: unknown } = {}
  if (value.input !== undefined) out.input = redactSecretsDeep(value.input)
  if (value.output !== undefined) out.output = redactSecretsDeep(value.output)
  if (value.meta !== undefined) out.meta = redactSecretsDeep(value.meta)
  if (value.error !== undefined) out.error = redactSecretsDeep(value.error)
  return out
}
