/**
 * 模型配置与选择策略：
 *  - OpenAI-Compatible profile 读写（新格式 modelProfiles + 旧格式 modelProfile 兼容）
 *  - API Key 解析（apiKeyEnv → scoped key → 通用 key）
 *  - 系统默认模型同步（Qoder 优先 → OpenAI 回落）
 *  - 模型 value 存在性校验
 *  - 轻量模型选择（关键词提取 / MR 描述等短输出场景）
 */
import type { TaskStore } from '@task-pipeline/core'
import type { LocalFileKeyStore } from '@task-pipeline/core'
import { isOpenAIModelValue, prefixOfVendor, stripModelPrefix } from './drivers/model-value.js'
import { detectVendor } from './drivers/model-providers.js'
import { LITE_MODEL_PATTERN } from './system-default-model.js'
import type { ChatDriverId } from './chat-types.js'

// ── 类型 ────────────────────────────────────────────────────────────────────

export type ModelProfile = {
  id?: string
  provider?: string
  /** ai-sdk 厂商类型（deepseek / openai / openai-compatible），缺省时按 baseUrl 自动识别。 */
  vendor?: string
  baseUrl?: string
  model?: string
  displayName?: string
  apiKeyEnv?: string
  isDefault?: boolean
}

// ── 依赖注入 ─────────────────────────────────────────────────────────────────

interface ModelProfileDeps {
  store: TaskStore
  keyStore: LocalFileKeyStore
  getQoderCachedStatus: () =>
    | {
        enabled: boolean
        connected: boolean
        models: Array<{
          value: string
          displayName?: string
          isDefault?: boolean
          priceFactor?: number
          isEnabled?: boolean
        }>
        usage?: { isQuotaExceeded?: boolean }
      }
    | undefined
  resolveLiteModelFromQoder: () => Promise<string>
}

let deps: ModelProfileDeps | null = null

export function initModelProfile(d: ModelProfileDeps): void {
  deps = d
}

function d(): ModelProfileDeps {
  if (!deps) throw new Error('model-profile not initialized')
  return deps
}

// ── Profile 读写 ─────────────────────────────────────────────────────────────

/**
 * 读取全部 OpenAI-Compatible 配置。
 * - 新格式 `modelProfiles`：JSON 数组 `[{ id, provider, vendor, baseUrl, model, displayName, isDefault }]`；
 * - 兼容旧格式 `modelProfile`：单个对象 → 视为单元素列表（惰性迁移，首次保存 modelProfiles 后旧值废弃）。
 */
export function readOpenAIProfiles(): ModelProfile[] {
  const raw = d().store.getSetting('modelProfiles')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is ModelProfile =>
            Boolean(item) && typeof item === 'object' && typeof (item as ModelProfile).baseUrl === 'string'
        )
      }
    } catch {
      /* 忽略脏数据，走旧格式兼容 */
    }
  }
  const legacy = d().store.getSetting('modelProfile')
  if (legacy) {
    try {
      const profile = JSON.parse(legacy) as ModelProfile
      if (profile.baseUrl && profile.model) return [{ ...profile, isDefault: true }]
    } catch {
      /* 忽略历史脏数据 */
    }
  }
  return []
}

/** 系统级调用使用的默认 OpenAI 配置：显式 isDefault 优先，否则取第一个。 */
export function defaultOpenAIProfile(): ModelProfile | undefined {
  const profiles = readOpenAIProfiles()
  if (profiles.length === 0) return undefined
  return profiles.find((profile) => profile.isDefault) ?? profiles[0]
}

/**
 * 取某个 profile 的 API Key（apiKeyEnv 优先，其次 keyStore）。
 * 读取顺序：`modelApiKey:<id>` → （默认或历史无 id 配置）`modelApiKey` 兼容回退。
 * 这样切换默认 profile 时无需迁移 key —— key 始终跟 profile id 走。
 */
export function openAIApiKeyFor(profile: ModelProfile): string | undefined {
  if (profile.apiKeyEnv && process.env[profile.apiKeyEnv]) return process.env[profile.apiKeyEnv]
  if (profile.id) {
    const scoped = protectedValue(`modelApiKey:${profile.id}`)
    if (scoped) return scoped
  }
  if (profile.isDefault || !profile.id) return protectedValue('modelApiKey')
  return undefined
}

// ── 内部工具 ─────────────────────────────────────────────────────────────────

function protectedValue(key: string): string | undefined {
  return d().keyStore.resolve(d().store.getSetting(key), key)
}

// ── 模型值解析 ───────────────────────────────────────────────────────────────

/** 去掉 model value 上的 `<厂商前缀>:`（deepseek: / openai: / openai-compatible:），让 /chat/completions 能识别真实模型名。 */
export function stripOpenAIModelPrefix(model: string | undefined): string | undefined {
  if (!model) return undefined
  return isOpenAIModelValue(model) ? stripModelPrefix(model) : model
}

/**
 * OpenAI 兼容模型当前的 value 形态：`<厂商前缀>:<model>`（前缀 = profile.vendor）。
 * 关键词提取 / 记忆整理等轻量 LLM 调用统一用它。
 * 多个配置时取默认 profile（isDefault 优先，否则第一个）。
 * 未配置时返回兼容占位 `openai:default`（driver 内部映射到 profile.model）。
 */
export function resolveOpenAIModelValue(): string {
  const profile = defaultOpenAIProfile()
  if (profile?.model) return `${prefixOfVendor(profile.vendor ?? detectVendor(profile.baseUrl))}:${profile.model}`
  return 'openai:default'
}

/**
 * 系统默认模型（同步版，基于 Qoder 状态探测缓存）：
 *  - Qoder 已连接且有模型 → 取 isDefault 模型（否则第一个），value 形如 `qoder:<model>`；
 *  - 否则 OpenAI profiles 非空 → 取默认 profile，value 形如 `<厂商前缀>:<model>`；
 *  - 都没有 → undefined。
 */
export function syncSystemDefaultModel(): { provider: string; model: string } | undefined {
  const status = d().getQoderCachedStatus()
  if (status && status.enabled && status.connected && status.models.length > 0) {
    const enabled = status.models.filter((m) => m.isEnabled !== false)
    const pick =
      enabled.find((m) => m.isDefault) ??
      enabled.find((m) => m.priceFactor === 0 || LITE_MODEL_PATTERN.test(`${m.value} ${m.displayName ?? ''}`)) ??
      enabled[0]
    if (pick?.value) return { provider: 'qoder', model: `qoder:${pick.value}` }
  }
  const profile = defaultOpenAIProfile()
  if (profile?.model) {
    const vendor = profile.vendor ?? detectVendor(profile.baseUrl)
    return {
      provider: vendor,
      model: `${prefixOfVendor(vendor)}:${profile.model}`
    }
  }
  return undefined
}

/**
 * 模型 value 存在性校验（对话/任务/Agent 存储值的失效判定）。
 * - OpenAI 兼容组：按当前 profiles 匹配；无任何 profile 时视为失效；
 *   `openai:default` 历史占位恒有效（只要存在 profile）；
 * - Qoder 模型：按最近一次状态探测的模型列表匹配；缓存未建立时不校验。
 */
export function isModelValueAvailable(model: string): boolean {
  if (isOpenAIModelValue(model)) {
    const profiles = readOpenAIProfiles().filter((p) => p.baseUrl && p.model)
    if (profiles.length === 0) return false
    if (model === 'openai:default') return true
    return profiles.some((p) => {
      const prefixed = `${prefixOfVendor(p.vendor ?? detectVendor(p.baseUrl))}:${p.model}`
      return prefixed === model || (p.id ? `${prefixed}@${p.id}` === model : false)
    })
  }
  const status = d().getQoderCachedStatus()
  if (!status) return true
  if (!status.enabled || !status.connected) return false
  const raw = model.startsWith('qoder:') ? model.slice('qoder:'.length) : model
  return status.models.some((m) => m.value === raw)
}

/**
 * 轻量任务的模型选择策略（关键词提取 / MR 描述生成等短输出场景共用）：
 * - Qoder: 从 getQoderStatus() 拉模型列表，直接找名字含 lite 的免费模型；
 * - OpenAI: 跟随用户配置的 modelProfile。
 */
export async function resolveLiteModel(driverId: ChatDriverId): Promise<string> {
  if (driverId === 'qoder') {
    return d().resolveLiteModelFromQoder()
  }
  return resolveOpenAIModelValue()
}
