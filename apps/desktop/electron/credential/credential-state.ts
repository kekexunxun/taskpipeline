/**
 * 凭据全局状态管理：主进程单一数据源，进入系统时逐项探测各配置 Token 是否已过期/失效。
 * 变化时广播快照给渲染进程，前端顶栏指示灯常驻展示。
 */
import type { BrowserWindow } from 'electron'
import type { McpProfile, TaskStore } from '@task-pipeline/core'
import type { AtlassianRestConfig } from '@task-pipeline/integrations'
import { McpClient, parseGitLabRemote } from '@task-pipeline/integrations'

// ── 类型 ────────────────────────────────────────────────────────────────────

export type CredentialKey = 'qoder' | 'gitlab' | 'jira' | 'confluence'

/** 凭据全局状态条目：主进程维护的唯一数据源，变化时广播快照给渲染进程。 */
export type CredentialState = {
  key: CredentialKey
  label: string
  /** unknown=未探测；checking=探测中；ok=连通可用；failed=Token 失效/连接失败；skipped=未配置。 */
  status: 'unknown' | 'checking' | 'ok' | 'failed' | 'skipped'
  message?: string
  checkedAt?: number
}

// ── 依赖注入（main.ts 初始化时传入） ─────────────────────────────────────────

interface CredentialStateDeps {
  getWindow: () => BrowserWindow | undefined
  store: TaskStore
  protectedValue: (key: string) => string | undefined
  getQoderStatusForHealth: () => Promise<{
    enabled: boolean
    connected: boolean
    error?: string
    models: unknown[]
  }>
  atlassianRestConfig: (kind: 'jira' | 'confluence') => AtlassianRestConfig | undefined
  testAtlassianRest: (
    kind: 'jira' | 'confluence',
    config: AtlassianRestConfig
  ) => Promise<{ ok: boolean; message: string }>
  mcpProfileResolver: (id: string) => McpProfile | undefined
}

let deps: CredentialStateDeps | null = null

export function initCredentialState(d: CredentialStateDeps): void {
  deps = d
}

function d(): CredentialStateDeps {
  if (!deps) throw new Error('credential-state not initialized')
  return deps
}

// ── 状态管理 ─────────────────────────────────────────────────────────────────

const CREDENTIAL_LABELS: Record<CredentialKey, string> = {
  qoder: 'Qoder Token',
  gitlab: 'GitLab Token',
  jira: 'Jira Token',
  confluence: 'Confluence Token'
}

const credentialStates = new Map<CredentialKey, CredentialState>(
  (Object.keys(CREDENTIAL_LABELS) as CredentialKey[]).map((key) => [
    key,
    { key, label: CREDENTIAL_LABELS[key], status: 'unknown' as const }
  ])
)

/** 凭据状态快照（固定顺序：qoder / gitlab / jira / confluence）。 */
export function credentialStateSnapshot(): CredentialState[] {
  return (Object.keys(CREDENTIAL_LABELS) as CredentialKey[]).map((key) => ({ ...credentialStates.get(key)! }))
}

/** 合并更新一项凭据状态，并向渲染进程广播最新完整快照。 */
export function updateCredential(
  key: CredentialKey,
  patch: Partial<Pick<CredentialState, 'status' | 'message' | 'checkedAt'>>
): void {
  const current = credentialStates.get(key)
  if (!current) return
  credentialStates.set(key, { ...current, ...patch })
  d().getWindow()?.webContents.send('credentials:state-changed', credentialStateSnapshot())
}

/** 运行时失败回写便捷入口（如提交 MR 时 GitLab 返回认证错误），无需等下一轮探测。 */
export function markCredentialFailed(key: CredentialKey, message: string): void {
  updateCredential(key, { status: 'failed', message, checkedAt: Date.now() })
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** Promise 超时包装：MCP 探测（uvx 冷启动）可能长时间挂起，需要兜底超时。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

// ── 单项探测 ─────────────────────────────────────────────────────────────────

/** GitLab Token 校验：优先用设置里配置的自建实例地址，其次从仓库 remoteUrl 推实例，最后回落 gitlab.com；调 /api/v4/user 验权。 */
async function checkGitLabCredential(token: string): Promise<Pick<CredentialState, 'status' | 'message'>> {
  const configured = d().store.getSetting('gitlabUrl')?.trim()
  const remote = d()
    .store.listRepositoryProfiles()
    .map((profile) => (profile.remoteUrl ? parseGitLabRemote(profile.remoteUrl) : undefined))
    .find((parsed) => Boolean(parsed?.baseUrl))
  const baseUrl = (configured || remote?.baseUrl || 'https://gitlab.com').replace(/\/$/, '')
  try {
    const response = await fetch(`${baseUrl}/api/v4/user`, {
      headers: { 'PRIVATE-TOKEN': token },
      signal: AbortSignal.timeout(10_000)
    })
    if (response.ok) return { status: 'ok' }
    if (response.status === 401) return { status: 'failed', message: 'Token 无效或已过期（401），请在设置中重新配置' }
    if (response.status === 403) return { status: 'failed', message: 'Token 已被禁用或权限不足（403）' }
    return { status: 'failed', message: `校验失败：HTTP ${response.status}` }
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 通用 MCP 连接测试：按 id 解析出 profile（统一 mcp.json + 凭据注入），
 * 经 McpClient.listTools() 验证连通并返回工具列表。内置/自定义服务共用。
 */
export async function testMcpConnectionById(
  id: string
): Promise<{ ok: boolean; tools: Array<{ name: string; description?: string }>; message: string }> {
  const profile = d().mcpProfileResolver(id)
  if (!profile) return { ok: false, tools: [], message: '未找到该服务，或未启用 / 凭据缺失' }
  const client = new McpClient(profile)
  try {
    // npx/uvx 冷启动可能需下载包，超时放宽到 30s（与 McpClient 内部 request 超时一致）。
    const tools = await withTimeout(client.listTools(), 30_000, 'MCP 连接超时（30s）')
    const infos = tools
      .map((tool) => {
        const t = tool as { name?: unknown; description?: unknown }
        const name = String(t?.name ?? '').trim()
        if (!name) return null
        const description = typeof t?.description === 'string' ? t.description.trim() || undefined : undefined
        return { name, description }
      })
      .filter((x): x is Exclude<typeof x, null> => x !== null)
    return {
      ok: true,
      tools: infos as Array<{ name: string; description?: string }>,
      message: `已连接，发现 ${tools.length} 个工具`
    }
  } catch (error) {
    return { ok: false, tools: [], message: error instanceof Error ? error.message : String(error) }
  } finally {
    client.close()
  }
}

// ── 汇总健康检查 ─────────────────────────────────────────────────────────────

/**
 * 汇总探测四类凭据：Qoder Token / GitLab Token / Jira / Confluence。
 * - 各项结果（含未配置的 skipped）统一写入全局凭据状态并广播快照，
 *   前端顶栏指示灯常驻展示，不再弹窗后消失。
 * - 各项互不阻塞，任一失败不影响其他项结果。
 */
export async function checkCredentialHealth(): Promise<CredentialState[]> {
  const checks: Array<Promise<void>> = []
  /** 登记一项检查：先置为 checking，完成后把结果写入全局状态并广播。 */
  const start = (key: CredentialKey, probe: Promise<Pick<CredentialState, 'status' | 'message'>>): void => {
    updateCredential(key, { status: 'checking', message: undefined })
    checks.push(
      probe
        .then((result) => updateCredential(key, { ...result, checkedAt: Date.now() }))
        .catch((error) =>
          updateCredential(key, {
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
            checkedAt: Date.now()
          })
        )
    )
  }
  /** 未配置项：静默计为 skipped，同样写入全局状态（供顶栏灰态展示）。 */
  const skip = (key: CredentialKey): void => {
    checks.push(Promise.resolve(updateCredential(key, { status: 'skipped', message: '未配置', checkedAt: Date.now() })))
  }

  // Qoder：复用状态探测，connected 即 Token 有效；探测本身也会回写全局状态。
  if (!d().protectedValue('qoderToken')) {
    skip('qoder')
  } else {
    start(
      'qoder',
      d()
        .getQoderStatusForHealth()
        .then((status): Pick<CredentialState, 'status' | 'message'> => {
          if (!status.enabled) return { status: 'skipped', message: '未配置' }
          return status.connected ? { status: 'ok' } : { status: 'failed', message: status.error ?? '连接失败' }
        })
    )
  }

  // GitLab：URL 与 Token 齐全时走 GitLab MCP 握手（/api/v4/mcp）；仅 Token 时回落 REST 验权。
  const gitlabToken = d().protectedValue('gitlabToken')
  if (!gitlabToken) {
    skip('gitlab')
  } else if (d().store.getSetting('gitlabUrl')?.trim()) {
    start(
      'gitlab',
      testMcpConnectionById('gitlab').then(
        (result): Pick<CredentialState, 'status' | 'message'> =>
          result.ok ? { status: 'ok' } : { status: 'failed', message: result.message }
      )
    )
  } else {
    start('gitlab', checkGitLabCredential(gitlabToken))
  }

  // Jira / Confluence：走 REST API 直接验权（/myself 等），秒级返回，不拉 MCP / uvx。
  for (const kind of ['jira', 'confluence'] as const) {
    const rest = d().atlassianRestConfig(kind)
    if (!rest) {
      skip(kind)
      continue
    }
    start(
      kind,
      withTimeout(d().testAtlassianRest(kind, rest), 15_000, '连接测试超时（15s）').then(
        (result): Pick<CredentialState, 'status' | 'message'> =>
          result.ok ? { status: 'ok' } : { status: 'failed', message: result.message }
      )
    )
  }

  await Promise.all(checks)
  return credentialStateSnapshot()
}
