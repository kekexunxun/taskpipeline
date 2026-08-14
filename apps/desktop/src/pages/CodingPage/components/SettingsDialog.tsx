import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  BotIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  InfoIcon
} from 'lucide-react'
import type { AgentProfile, Memory, MemoryScope, RepositoryProfile } from '@task-pipeline/core'
import { RepositoryDialog, TestButton, type RepoDraft } from './RepositoryDialog'
import { AgentDialog } from './AgentDialog'
import { MemoryDialog } from './MemoryDialog'
import { OpenAIProfileDialog, type OpenAIProfile } from './OpenAIProfileDialog'
import { McpSettingsTab } from './McpSettingsTab'
import { SkillSettingsTab } from './SkillSettingsTab'
import { ModelBadges } from '@/components/ModelBadges'
import { detectVendor, MODEL_VENDORS, type ModelVendor } from '@/utils/model-vendors'
import { api, type CapabilityKey, type MemorySearchResult, type SystemDefaultModel } from '@/api'
import { useFeedback } from '@/hooks/useGlobalFeedback'
import { useAgents } from '@/hooks/useAgents'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldGroup } from '@/components/ui/field'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AgentTemplate, QoderStatus } from '@/api'

type Settings = {
  defaultModel: string
  qoderToken: string
  gitlabUrl: string
  gitlabToken: string
  jiraUrl: string
  jiraToken: string
  confluenceUrl: string
  confluenceToken: string
  autoCreateMergeRequests: string
  openCodeReviewEnabled: string
  createTestCasesEnabled: string
  /** Phase 4：review 阻断后是否自动按意见修订并重审（默认关闭，需人工确认开启）。 */
  reviewAutoFix: string
  /** Phase 4：自动修订最大轮数。 */
  reviewAutoFixMaxRounds: string
  /** 交付确认：commit/push/MR 前是否弹窗确认（默认关闭=自动提交，常规可行）。 */
  deliveryConfirm: string
  // modelApiKey 不再在通用设置中展示，由 OpenAI-Compatible 弹窗维护
  modelApiKey?: string
}
type OpenAIDraft = {
  id: string
  vendor?: ModelVendor
  baseUrl: string
  model: string
  displayName: string
  apiKeyConfigured: boolean
  isDefault: boolean
  /** 用户显式声明的参数能力；缺省 = driver 按 vendor 自动推断。 */
  capabilities?: CapabilityKey[]
}
/** 按厂商分块（顺序 = MODEL_VENDORS 注册表；缺失/未知 vendor 归入「其它兼容端点」）。 */
function groupProfilesByVendor(
  profiles: OpenAIDraft[]
): Array<{ vendor: ModelVendor; label: string; items: OpenAIDraft[] }> {
  const order = MODEL_VENDORS.map((v) => v.id)
  const buckets = new Map<ModelVendor, OpenAIDraft[]>()
  for (const profile of profiles) {
    const vendor = profile.vendor && order.includes(profile.vendor) ? profile.vendor : 'openai-compatible'
    if (!buckets.has(vendor)) buckets.set(vendor, [])
    buckets.get(vendor)!.push(profile)
  }
  return order
    .filter((vendor) => (buckets.get(vendor)?.length ?? 0) > 0)
    .map((vendor) => ({
      vendor,
      label: MODEL_VENDORS.find((v) => v.id === vendor)?.name ?? vendor,
      items: buckets.get(vendor)!
    }))
}
const defaults: Settings = {
  defaultModel: 'claude-sonnet-4.5',
  qoderToken: '',
  gitlabUrl: '',
  gitlabToken: '',
  jiraUrl: '',
  jiraToken: '',
  confluenceUrl: '',
  confluenceToken: '',
  autoCreateMergeRequests: 'false',
  openCodeReviewEnabled: 'false',
  createTestCasesEnabled: 'false',
  reviewAutoFix: 'false',
  reviewAutoFixMaxRounds: '2',
  deliveryConfirm: 'false'
}
const ordinaryKeys = [
  'defaultModel',
  'gitlabUrl',
  'jiraUrl',
  'confluenceUrl',
  'autoCreateMergeRequests',
  'openCodeReviewEnabled',
  'createTestCasesEnabled',
  'reviewAutoFix',
  'reviewAutoFixMaxRounds',
  'deliveryConfirm'
] as const
const secretKeys = ['qoderToken', 'gitlabToken', 'jiraToken', 'confluenceToken', 'modelApiKey'] as const
const MANAGED_MEMORY_SCOPES: MemoryScope[] = ['user', 'repo']
/** 系统内置角色 Agent 的固定 id，用于 Tab 分类。 */
const ROLE_AGENT_IDS = ['builtin-reviewer', 'builtin-test-writer', 'builtin-mr-writer']

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5 border-b pb-4 last:border-b-0 last:pb-0">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && <p className="text-xs leading-5 text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function SettingField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Field className="gap-1" label={label}>
      {children}
    </Field>
  )
}

/**
 * 仓库卡片：按需求只展示名称 + 分支两个核心字段，操作按钮靠右悬浮。
 */
function RepositoryCard({
  repository,
  agent,
  onEdit,
  onDelete
}: {
  repository: RepositoryProfile
  agent?: AgentProfile
  onEdit(): void
  onDelete(): void
}) {
  return (
    <article
      className="group flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2.5"
      title={repository.localPath}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <GitBranchIcon size={12} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h4 className="truncate text-xs font-semibold text-foreground">{repository.name}</h4>
            {agent && (
              <Badge variant="muted" className="shrink-0 text-[9px]" title={`绑定 Agent：${agent.name}`}>
                {agent.name}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 inline-flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            <GitBranchIcon size={9} />
            {repository.defaultBranch || 'main'}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button variant="ghost" size="icon-sm" aria-label={`编辑仓库 ${repository.name}`} onClick={onEdit}>
          <PencilIcon size={11} />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`删除仓库 ${repository.name}`} onClick={onDelete}>
          <Trash2Icon size={11} />
        </Button>
      </div>
    </article>
  )
}

/**
 * 记忆卡片：标题可点击展开内容，操作按钮靠右悬浮。
 * 展开后按 范围 / 关键词 / 内容 三段式结构化展示。
 */
function MemoryCard({
  memory,
  // repository,
  expanded,
  onToggle,
  onEdit,
  onDelete
}: {
  memory: Memory
  repository?: RepositoryProfile
  expanded: boolean
  onToggle(): void
  onEdit(): void
  onDelete(): void
}) {
  // const scopeValue = memory.scope === 'user' ? '用户级' : repository?.localPath || repository?.name || '—'
  return (
    <article className="group rounded-md border bg-card">
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRightIcon
            size={12}
            className={cn('shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {memory.pinned && (
                <Badge variant="muted" className="text-[9px]">
                  置顶
                </Badge>
              )}
              <h4 className="truncate text-xs font-semibold text-foreground">{memory.title}</h4>
            </div>
          </div>
        </button>
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button variant="ghost" size="icon-sm" aria-label={`编辑记忆 ${memory.title}`} onClick={onEdit}>
            <PencilIcon size={11} />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`删除记忆 ${memory.title}`} onClick={onDelete}>
            <Trash2Icon size={11} />
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="space-y-1.5 border-t px-3 pt-2 pb-2.5">
          {memory.tags.length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[10px] leading-4 text-muted-foreground/70">关键词</p>
              <p className="text-[11px] leading-5 text-muted-foreground">{memory.tags.join(', ')}</p>
            </div>
          )}
          <div className="space-y-0.5">
            <p className="text-[10px] leading-4 text-muted-foreground/70">内容</p>
            <p className="text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">{memory.content}</p>
          </div>
        </div>
      )}
    </article>
  )
}

/**
 * 检索测试（仅开发环境）。
 *
 * - vite 在 dev 模式下会注入 `import.meta.env.DEV = true`，生产构建中该常量被
 *   静态替换为 `false`，esbuild 会把外层 `return null` 视作死代码并把
 *   `MemorySearchProbeInner` 一起从 bundle 中消除，因此不会影响生产包体或运行行为。
 * - 直接复用 `api.searchMemory`：与任务执行时 `consolidateTaskMemory` /
 *   `collectTaskMemoryContext` 调用的同一接口，确保调测结果与生产一致。
 * - 用 wrapper 包一层是为了让 dev 门控单独占据一个函数，从而避免
 *   `if (return) ... hooks` 触发 react-hooks/rules-of-hooks 错误。
 */
function MemorySearchProbe({ repositories }: { repositories: RepositoryProfile[] }) {
  if (!import.meta.env.DEV) return null
  return <MemorySearchProbeInner repositories={repositories} />
}

function MemorySearchProbeInner({ repositories }: { repositories: RepositoryProfile[] }) {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(10)
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(repositories.map((repository) => [repository.id, true]))
  )
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MemorySearchResult | undefined>()
  const [error, setError] = useState<string | undefined>()

  const selectedRepositoryIds = useMemo(
    () => repositories.filter((repository) => selected[repository.id]).map((repository) => repository.id),
    [repositories, selected]
  )

  const run = async () => {
    const trimmed = query.trim()
    if (!trimmed) {
      setError('请输入查询关键词')
      return
    }
    setError(undefined)
    setBusy(true)
    try {
      const response = await api.searchMemory(trimmed, {
        repositoryIds: selectedRepositoryIds,
        limit,
        // 告诉主进程这是 dev 探针调用，让其落 trace_events（"other" 分类）。
        // 生产聊天 / 任务流不设该字段，自然不会产生额外 trace。
        traceSource: 'dev-probe'
      })
      setResult(response)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setResult(undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="检索测试（仅开发环境）"
      description="复现任务执行前的检索调用，方便排查 FTS 命中与仓库文档索引问题；生产构建不显示。"
    >
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="查询词" className="min-w-[260px] flex-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例如：优惠券并发幂等"
              className="h-8 text-xs"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void run()
              }}
            />
          </Field>
          <Field label="Limit">
            <Input
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(event) => {
                const next = Number(event.target.value) || 10
                setLimit(Math.max(1, Math.min(50, next)))
              }}
              className="h-8 w-16 text-xs"
            />
          </Field>
          <Button size="sm" disabled={busy} onClick={() => void run()}>
            {busy ? <Loader2Icon className="animate-spin-slow" size={11} /> : <SearchIcon size={11} />}
            {busy ? '检索中' : '执行检索'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-card/40 px-3 py-2 text-[11px]">
          <span className="text-muted-foreground">仓库范围</span>
          {repositories.length ? (
            repositories.map((repository) => (
              <label key={repository.id} className="inline-flex cursor-pointer items-center gap-1 text-foreground">
                <input
                  type="checkbox"
                  className="size-3 accent-primary"
                  checked={Boolean(selected[repository.id])}
                  onChange={(event) =>
                    setSelected((current) => ({ ...current, [repository.id]: event.target.checked }))
                  }
                />
                <span className="truncate">{repository.name}</span>
              </label>
            ))
          ) : (
            <span className="text-muted-foreground">尚未配置仓库</span>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {result && (
          <div className="space-y-3">
            <div className="rounded-md border bg-card/40 px-3 py-2">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>LLM 提取的关键词（实际走 FTS5 查的是这些）</span>
                <span className="font-mono">{result.keywords.length} 个</span>
              </div>
              {result.keywords.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {result.keywords.map((keyword) => (
                    <span
                      key={keyword}
                      className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary"
                    >
                      {keyword}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  （空。LLM 提取失败且 fallback 也没拿到任何关键词。）
                </p>
              )}
            </div>
            <ProbeResultGroup
              title="记忆命中"
              empty="未命中任何记忆（用户级 / 对话级 / 仓库级）"
              items={result.memories}
              renderItem={(item) => ({
                key: item.id,
                headline: item.title,
                meta: `${item.scope}${item.repositoryId ? ' · 仓库级' : ''} · score ${item.score}`,
                body: item.content,
                tags: item.tags
              })}
            />
            <ProbeResultGroup
              title="repowiki 命中"
              empty="未命中任何仓库文档"
              items={result.wikiDocs}
              renderItem={(item) => ({
                key: item.id,
                headline: item.title || item.path,
                meta: `${item.path} · score ${item.score}`,
                body: item.content,
                tags: []
              })}
            />
            <p className="text-[11px] text-muted-foreground">
              共 {result.memories.length} 条记忆、{result.wikiDocs.length} 篇文档（仓库范围{' '}
              {selectedRepositoryIds.length}）
            </p>
          </div>
        )}
      </div>
    </Section>
  )
}

type ProbeRenderedItem = {
  key: string
  headline: string
  meta: string
  body: string
  tags: string[]
}

function ProbeResultGroup<T extends { id: string; score: number }>({
  title,
  empty,
  items,
  renderItem
}: {
  title: string
  empty: string
  items: T[]
  renderItem: (item: T) => ProbeRenderedItem
}) {
  if (!items.length) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground">{empty}</div>
    )
  }
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold text-foreground">{title}</h4>
      {items.map((item) => {
        const view = renderItem(item)
        return (
          <article key={view.key} className="rounded-md border bg-card/40 px-3 py-2 text-xs leading-relaxed">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground">{view.headline}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{view.meta}</span>
            </div>
            <p className="mt-1 break-words whitespace-pre-wrap text-muted-foreground">
              {view.body.slice(0, 320)}
              {view.body.length > 320 ? '…' : ''}
            </p>
            {view.tags.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {view.tags.map((tag) => (
                  <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}

/**
 * Qoder 模型卡片：复用 ModelBadges 保持与 ChatModelSelector 展示一致。
 */
function QoderModelCard({ model, isDefault }: { model: QoderStatus['models'][number]; isDefault: boolean }) {
  return (
    <article className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h4 className="truncate text-xs font-semibold text-foreground">{model.displayName}</h4>
          {isDefault && (
            <Badge variant="muted" className="text-[9px]">
              默认
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={model.description}>
          {model.description || '—'}
        </p>
      </div>
      <ModelBadges model={model} className="shrink-0" />
    </article>
  )
}

/**
 * Agent 卡片：展示名称 / 描述 / 绑定仓库数与模型偏好，操作按钮靠右悬浮。
 */
function AgentCard({
  agent,
  boundRepositories,
  onEdit,
  onDelete,
  onToggleEnabled,
  hideDelete
}: {
  agent: AgentProfile
  boundRepositories: number
  onEdit(): void
  onDelete(): void
  onToggleEnabled(enabled: boolean): void
  hideDelete?: boolean
}) {
  return (
    <article className="group rounded-md border bg-card">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <BotIcon size={13} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="truncate text-xs font-semibold text-foreground">{agent.name}</h4>
            {agent.builtin && (
              <Badge variant="muted" className="text-[9px]">
                内置
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={agent.description}>
            {agent.description || '—'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Switch
            checked={agent.enabled}
            disabled={agent.builtin}
            onCheckedChange={(checked) => onToggleEnabled(checked)}
            aria-label={`启用 Agent ${agent.name}`}
          />
          <Button variant="ghost" size="icon-sm" aria-label={`编辑 Agent ${agent.name}`} onClick={onEdit}>
            <PencilIcon size={11} />
          </Button>
          {!hideDelete && (
            <Button variant="ghost" size="icon-sm" aria-label={`删除 Agent ${agent.name}`} onClick={onDelete}>
              <Trash2Icon size={11} />
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>绑定 {boundRepositories} 个仓库</span>
        {agent.preferredProvider && agent.preferredModel && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span>
              {agent.preferredProvider === 'qoder' ? 'Qoder' : 'OpenAI'} · {agent.preferredModel}
            </span>
          </>
        )}
      </div>
    </article>
  )
}

export function SettingsDialog({
  open,
  onOpenChange,
  qoder,
  onQoderRefresh,
  onSaved,
  initialTab
}: {
  open: boolean
  onOpenChange(open: boolean): void
  qoder?: QoderStatus
  onQoderRefresh?(): void
  /** 保存成功后回调（如触发凭据重新检查）。 */
  onSaved?(): void
  /** 打开时默认定位到的 Tab（如凭据失效提醒跳转）；不传默认「通用」。 */
  initialTab?: string
}) {
  const { showError, showSuccess } = useFeedback()
  const [settings, setSettings] = useState<Settings>(defaults)
  const [repositories, setRepositories] = useState<RepositoryProfile[]>([])
  const [loading, setLoading] = useState(false)
  /** 正在保存的 Token 键（按钮 loading 态）。 */
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [repositoryDialog, setRepositoryDialog] = useState<{
    open: boolean
    initial?: RepoDraft
  }>({ open: false })
  const [deleteRepository, setDeleteRepository] = useState<RepositoryProfile | undefined>(undefined)
  const [memories, setMemories] = useState<Memory[]>([])
  const [wikiCounts, setWikiCounts] = useState<Record<string, number>>({})
  const [memoryDialog, setMemoryDialog] = useState<{ open: boolean; initial?: Partial<Memory> & { id?: string } }>({
    open: false
  })
  const [deleteMemory, setDeleteMemory] = useState<Memory | undefined>(undefined)
  const [rebuildingWiki, setRebuildingWiki] = useState<string | undefined>(undefined)
  const [activeMemoryTab, setActiveMemoryTab] = useState<string>('user')
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | undefined>(undefined)
  const { agents, refresh: refreshAgents } = useAgents()
  const [agentTab, setAgentTab] = useState<'system' | 'custom'>('system')
  const [agentTemplates, setAgentTemplates] = useState<AgentTemplate[]>([])
  const [agentDialog, setAgentDialog] = useState<{ open: boolean; initial?: AgentProfile }>({ open: false })
  const [deleteAgent, setDeleteAgent] = useState<AgentProfile | undefined>(undefined)
  const [openAIProfiles, setOpenAIProfiles] = useState<OpenAIDraft[]>([])
  /** 系统级默认模型（Qoder 优先）：「默认」徽章展示它，而非 settings.defaultModel 字面比较。 */
  const [systemDefault, setSystemDefault] = useState<SystemDefaultModel | undefined>()
  const [openAIDialog, setOpenAIDialog] = useState<{ open: boolean; mode: 'create' | 'edit'; editing?: OpenAIDraft }>({
    open: false,
    mode: 'create'
  })

  const load = async () => {
    setLoading(true)
    try {
      const entries = await Promise.all(
        [...ordinaryKeys, ...secretKeys].map(async (key) => [key, await api.getSetting(key)] as const)
      )
      const next = { ...defaults }
      for (const [key, value] of entries) if (value !== undefined) next[key] = value
      setSettings(next)
      const repositoryList = await api.listRepositories()
      setRepositories(repositoryList)
      setMemories(await api.listMemories({ scopes: MANAGED_MEMORY_SCOPES }))
      await refreshAgents()
      setAgentTemplates(await api.listAgentTemplates())
      const counts: Record<string, number> = {}
      for (const repository of repositoryList)
        counts[repository.id] = (await api.listRepoWikiDocs(repository.id)).length
      setWikiCounts(counts)
      const profilesRaw = await api.getSetting('modelProfiles')
      if (profilesRaw) {
        try {
          const parsed = JSON.parse(profilesRaw) as unknown
          if (Array.isArray(parsed)) {
            const list = parsed
              .filter(
                (
                  item
                ): item is {
                  baseUrl: string
                  model: string
                  vendor?: string
                  displayName?: string
                  isDefault?: boolean
                } =>
                  Boolean(item) &&
                  typeof item === 'object' &&
                  typeof (item as { baseUrl?: unknown }).baseUrl === 'string'
              )
              .map((item, index) => ({
                id: (item as { id?: string }).id ?? `legacy-${index}`,
                vendor: item.vendor ? (item.vendor as ModelVendor) : detectVendor(item.baseUrl),
                baseUrl: item.baseUrl,
                model: item.model,
                displayName: item.displayName ?? '',
                apiKeyConfigured: false,
                // 历史数据缺 id 的配置视为默认（与主进程读取约定一致：无 id/默认 → 回退 modelApiKey）
                isDefault: item.isDefault ?? !(item as { id?: string }).id,
                // 用户显式声明的参数能力（缺省 = driver 按 vendor 自动推断）
                capabilities: (item as { capabilities?: CapabilityKey[] }).capabilities
              }))
            // 每个 profile 的 API Key 是否已配置：优先 `modelApiKey:<id>`，默认配置回退历史 `modelApiKey`
            const keyStates = await Promise.all(
              list.map(async (profile) => {
                const scoped = await api.getSetting(`modelApiKey:${profile.id}`)
                return Boolean(scoped) || (profile.isDefault ? Boolean(await api.getSetting('modelApiKey')) : false)
              })
            )
            setOpenAIProfiles(
              list.map((profile, index) => ({ ...profile, apiKeyConfigured: keyStates[index] ?? false }))
            )
          }
        } catch {
          // 忽略历史脏数据
        }
      } else {
        // 兼容旧格式 modelProfile（单个对象 → 单条默认配置）
        const profile = await api.getSetting('modelProfile')
        if (profile) {
          try {
            const parsed = JSON.parse(profile) as { baseUrl?: string; model?: string; displayName?: string }
            if (parsed.baseUrl && parsed.model) {
              const apiKeyConfigured = Boolean(await api.getSetting('modelApiKey'))
              setOpenAIProfiles([
                {
                  id: 'company-openai',
                  baseUrl: parsed.baseUrl,
                  model: parsed.model,
                  displayName: parsed.displayName ?? '',
                  apiKeyConfigured,
                  isDefault: true
                }
              ])
            } else {
              setOpenAIProfiles([])
            }
          } catch {
            setOpenAIProfiles([])
          }
        } else {
          setOpenAIProfiles([])
        }
      }
      // 系统级默认模型（Qoder 优先）：「默认」徽章数据源；失败不影响设置页主体。
      void api
        .getDefaultModel()
        .then(setSystemDefault)
        .catch(() => undefined)
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    if (open) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }))
  /** 实时保存单条普通设置（URL / 开关等）：失败提示，不阻塞交互。 */
  const persistSetting = async (key: string, value: string) => {
    try {
      await api.setSetting(key, value)
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  type TokenKey = 'qoderToken' | 'gitlabToken' | 'jiraToken' | 'confluenceToken'
  /**
   * 保存单个 Token（仅当有实际输入且非「已配置」占位时落盘）。
   * 保存成功后触发全局凭据重检，让右上角状态立即刷新；Qoder 额外刷新状态探测。
   */
  const saveToken = async (key: TokenKey, opts?: { refreshQoder?: boolean }) => {
    const value = settings[key]
    if (!value || value === '__configured__') return
    setSavingKey(key)
    try {
      await api.setSetting(key, value, true)
      if (opts?.refreshQoder) onQoderRefresh?.()
      onSaved?.()
      showSuccess('设置已保存')
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSavingKey(null)
    }
  }
  /** 任务自动化开关：本地 state 与落盘同步更新（实时生效）。 */
  const toggleSettingLive = (
    key:
      | 'openCodeReviewEnabled'
      | 'createTestCasesEnabled'
      | 'autoCreateMergeRequests'
      | 'deliveryConfirm'
      | 'reviewAutoFix',
    checked: boolean
  ) => {
    const value = checked ? 'true' : 'false'
    update(key, value)
    void persistSetting(key, value)
  }
  /** 自动修订轮数：夹取合法范围后同步落盘。 */
  const updateRoundsLive = (raw: string) => {
    const value = String(Math.max(1, Math.min(10, Number(raw) || 2)))
    update('reviewAutoFixMaxRounds', value)
    void persistSetting('reviewAutoFixMaxRounds', value)
  }
  const saveOpenAIProfile = async (input: {
    id?: string
    vendor?: ModelVendor
    baseUrl: string
    model: string
    displayName?: string
    apiKey: string | undefined
    isDefault: boolean
    capabilities?: CapabilityKey[]
  }) => {
    try {
      const id = input.id ?? `openai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      // isDefault 互斥：新设为默认的配置成为唯一默认；编辑默认时取消默认 → 自动提升第一个其它配置（保证始终有默认）
      let next = openAIProfiles
        .filter((profile) => profile.id !== id)
        .map((profile) => ({ ...profile, isDefault: input.isDefault ? false : profile.isDefault }))
      const willBeDefault = input.isDefault || next.length === 0
      if (!willBeDefault && !next.some((profile) => profile.isDefault) && next.length > 0) {
        next = next.map((profile, index) => (index === 0 ? { ...profile, isDefault: true } : profile))
      }
      next.push({
        id,
        vendor: input.vendor,
        baseUrl: input.baseUrl,
        model: input.model,
        displayName: input.displayName ?? '',
        apiKeyConfigured: input.apiKey ? true : (openAIProfiles.find((p) => p.id === id)?.apiKeyConfigured ?? false),
        isDefault: willBeDefault,
        capabilities: input.capabilities
      })
      // key 始终按 profile 存 `modelApiKey:<id>`（默认/非默认一致，切换默认无需迁移）；历史 `modelApiKey` 仅作读取回退
      if (input.apiKey !== undefined) await api.setSetting(`modelApiKey:${id}`, input.apiKey, true)
      await api.setSetting(
        'modelProfiles',
        JSON.stringify(
          next.map(({ id: pid, vendor, baseUrl, model, displayName, isDefault, capabilities }) => ({
            id: pid,
            provider: 'company-openai',
            vendor,
            baseUrl,
            model,
            displayName,
            isDefault,
            capabilities
          }))
        )
      )
      setOpenAIProfiles(next)
      setOpenAIDialog({ open: false, mode: 'create' })
      window.dispatchEvent(new CustomEvent('app:models-changed'))
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const deleteOpenAIProfile = async (id: string) => {
    try {
      const target = openAIProfiles.find((profile) => profile.id === id)
      let next = openAIProfiles.filter((profile) => profile.id !== id)
      // 删除的是默认配置时，把第一个剩余配置提升为默认
      if (target?.isDefault && next.length > 0)
        next = next.map((profile, index) => (index === 0 ? { ...profile, isDefault: true } : profile))
      await api.setSetting(`modelApiKey:${id}`, '')
      if (target?.isDefault) await api.setSetting('modelApiKey', '')
      await api.setSetting(
        'modelProfiles',
        JSON.stringify(
          next.map(({ id: pid, vendor, baseUrl, model, displayName, isDefault, capabilities }) => ({
            id: pid,
            provider: 'company-openai',
            vendor,
            baseUrl,
            model,
            displayName,
            isDefault,
            capabilities
          }))
        )
      )
      setOpenAIProfiles(next)
      setOpenAIDialog({ open: false, mode: 'create' })
      window.dispatchEvent(new CustomEvent('app:models-changed'))
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const refreshRepositories = async () => {
    try {
      setRepositories(await api.listRepositories())
      window.dispatchEvent(new CustomEvent('app:repositories-changed'))
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const addRepository = async () => {
    try {
      const folder = await api.chooseRepositoryFolder()
      if (folder) setRepositoryDialog({ open: true, initial: folder })
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const boundAgentCount = deleteRepository
    ? agents.filter((agent) => agent.repositoryIds.includes(deleteRepository.id)).length
    : 0
  const removeRepository = async () => {
    if (!deleteRepository) return
    try {
      await api.deleteRepository(deleteRepository.id)
      setDeleteRepository(undefined)
      await refreshRepositories()
      // 删除仓库会同步解绑 Agent 白名单，刷新列表
      await refreshAgents()
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const refreshMemories = async () => {
    try {
      setMemories(await api.listMemories({ scopes: MANAGED_MEMORY_SCOPES }))
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const removeMemory = async () => {
    if (!deleteMemory) return
    try {
      await api.deleteMemory(deleteMemory.id)
      setDeleteMemory(undefined)
      await refreshMemories()
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const toggleAgentEnabled = async (agent: AgentProfile, enabled: boolean) => {
    try {
      await api.saveAgent({ ...agent, enabled, updatedAt: new Date().toISOString() })
      await refreshAgents()
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const removeAgent = async () => {
    if (!deleteAgent) return
    try {
      await api.deleteAgent(deleteAgent.id)
      setDeleteAgent(undefined)
      await refreshAgents()
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const exportAgents = async () => {
    try {
      const filePath = await api.exportAgents()
      if (filePath) showSuccess(`已导出 Agent 配置：${filePath}`)
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const importAgents = async () => {
    try {
      const next = await api.importAgents()
      if (next) {
        await refreshAgents()
        showSuccess(`已导入 ${next.length} 个 Agent`)
      }
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  /** 白名单解析（与主进程 AgentService 一致）：命中多个取最近修改。 */
  const agentForRepository = (repositoryId: string) =>
    agents
      .filter((agent) => agent.enabled && agent.repositoryIds.includes(repositoryId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const rebuildRepoWiki = async (repositoryId: string) => {
    setRebuildingWiki(repositoryId)
    try {
      const result = await api.indexRepoWiki(repositoryId)
      const docs = await api.listRepoWikiDocs(repositoryId)
      setWikiCounts((current) => ({ ...current, [repositoryId]: docs.length }))
      showSuccess(`索引完成：新增 ${result.indexed}，移除 ${result.removed}`)
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRebuildingWiki(undefined)
    }
  }
  const userMemories = memories.filter((memory) => memory.scope === 'user')
  const openAIInitial: OpenAIProfile | undefined = openAIDialog.editing
    ? {
        id: openAIDialog.editing.id,
        baseUrl: openAIDialog.editing.baseUrl,
        model: openAIDialog.editing.model,
        displayName: openAIDialog.editing.displayName || undefined,
        apiKeyConfigured: openAIDialog.editing.apiKeyConfigured,
        isDefault: openAIDialog.editing.isDefault,
        capabilities: openAIDialog.editing.capabilities
      }
    : undefined

  return (
    <TooltipProvider>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          onPointerDownOutside={(event) => event.preventDefault()}
          className="grid h-[min(760px,calc(100vh-32px))] !w-[min(1120px,calc(100vw-32px))] !max-w-[1120px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0"
        >
          <DialogHeader className="space-y-1 border-b px-6 pt-3.5 pb-3">
            <DialogTitle className="text-sm">系统设置</DialogTitle>
            <DialogDescription>管理服务连接、凭据、仓库和聊天模型。</DialogDescription>
          </DialogHeader>
          {loading ? (
            <div className="grid place-items-center text-xs text-muted-foreground">
              <Loader2Icon className="animate-spin-slow" size={14} />
            </div>
          ) : (
            <Tabs
              defaultValue={initialTab ?? 'general'}
              orientation="vertical"
              className="grid min-h-0 grid-cols-[148px_minmax(0,1fr)]"
            >
              <TabsList className="flex h-full flex-col items-stretch justify-start gap-0.5 rounded-none border-r bg-card/40 p-2">
                <TabsTrigger className="h-7 justify-start px-2 text-xs!" value="general">
                  通用
                </TabsTrigger>
                <TabsTrigger className="h-7 justify-start px-2 text-xs!" value="gitlab">
                  Gitlab
                </TabsTrigger>
                <TabsTrigger className="h-7 justify-start px-2 text-xs!" value="atlassian">
                  Atlassian
                </TabsTrigger>
                <TabsTrigger className="h-7 justify-start px-2 text-xs!" value="repositories">
                  仓库
                </TabsTrigger>
                <TabsTrigger className="h-7 justify-start px-2 text-xs!" value="agents">
                  Agent
                </TabsTrigger>
                <TabsTrigger className="h-7 justify-start px-2 text-xs!" value="memory">
                  记忆
                </TabsTrigger>
                <TabsTrigger className="h-7 justify-start px-2 text-xs!" value="model">
                  模型
                </TabsTrigger>
                <TabsTrigger className="h-7 justify-start px-2 text-xs!" value="mcp">
                  MCP
                </TabsTrigger>
                <TabsTrigger className="h-7 justify-start px-2 text-xs!" value="skill">
                  Skill
                </TabsTrigger>
              </TabsList>
              <div className="thin-scrollbar min-h-0 space-y-5 overflow-y-auto p-6">
                <TabsContent value="general" className="space-y-5">
                  <Section title="Qoder" description="使用 Qoder Agent SDK 执行任务和生成对话。">
                    <FieldGroup className="gap-2.5">
                      <SettingField label="Qoder Token">
                        <SecretInput
                          aria-label="Qoder Token"
                          value={settings.qoderToken}
                          onChange={(event) => update('qoderToken', event.target.value)}
                          placeholder="Qoder Token"
                        />
                      </SettingField>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="w-fit"
                        disabled={savingKey !== null}
                        onClick={() => void saveToken('qoderToken', { refreshQoder: true })}
                      >
                        {savingKey === 'qoderToken' ? (
                          <Loader2Icon className="animate-spin-slow" size={11} />
                        ) : (
                          <KeyRoundIcon size={11} />
                        )}
                        {savingKey === 'qoderToken' ? '保存中' : '保存'}
                      </Button>
                    </FieldGroup>
                  </Section>
                  <Section title="任务自动化" description="控制实现完成后的 Review / 测试用例生成 / MR 提交流程。">
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">开启 CodeReview</span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            实现和校验完成后自动执行代码评审。
                          </span>
                        </span>
                        <Switch
                          checked={settings.openCodeReviewEnabled === 'true'}
                          onCheckedChange={(checked) => toggleSettingLive('openCodeReviewEnabled', checked)}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">生成测试用例</span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            实现完成后、Review 之前自动生成最小测试集；不修改业务逻辑。
                          </span>
                        </span>
                        <Switch
                          checked={settings.createTestCasesEnabled === 'true'}
                          onCheckedChange={(checked) => toggleSettingLive('createTestCasesEnabled', checked)}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">自动提交 MR</span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            Review 通过后自动提交 Merge Request。
                          </span>
                        </span>
                        <Switch
                          checked={settings.autoCreateMergeRequests === 'true'}
                          onCheckedChange={(checked) => toggleSettingLive('autoCreateMergeRequests', checked)}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">提交前人工确认</span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            开启后 commit / push / 建 MR 前逐步骤弹窗确认；关闭时自动提交。
                          </span>
                        </span>
                        <Switch
                          checked={settings.deliveryConfirm === 'true'}
                          onCheckedChange={(checked) => toggleSettingLive('deliveryConfirm', checked)}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">Review 自动修订</span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            Review 阻断时按意见自动修改并重审（可设轮数上限）；关闭时停在阻断状态由人工处理。
                          </span>
                        </span>
                        <Switch
                          checked={settings.reviewAutoFix === 'true'}
                          onCheckedChange={(checked) => toggleSettingLive('reviewAutoFix', checked)}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">自动修订轮数上限</span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            达到上限后停止自动修订，等待人工处理剩余意见。
                          </span>
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          aria-label="自动修订轮数上限"
                          className="h-8 w-16 rounded-md border bg-background px-2 text-xs"
                          value={Number(settings.reviewAutoFixMaxRounds) || 2}
                          onChange={(event) => updateRoundsLive(event.target.value)}
                        />
                      </div>
                    </div>
                  </Section>
                </TabsContent>
                <TabsContent value="gitlab" className="space-y-5">
                  <Section title="GitLab" description="用于代码仓库和 Merge Request 集成。">
                    <FieldGroup className="gap-2.5">
                      <SettingField label="GitLab URL">
                        <Input
                          value={settings.gitlabUrl}
                          onChange={(event) => update('gitlabUrl', event.target.value)}
                          onBlur={(event) => void persistSetting('gitlabUrl', event.target.value)}
                          placeholder="自建实例地址，如 https://gitlab.company.com"
                        />
                      </SettingField>
                      <SettingField label="GitLab Token">
                        <SecretInput
                          aria-label="GitLab Token"
                          value={settings.gitlabToken}
                          onChange={(event) => update('gitlabToken', event.target.value)}
                          placeholder="GitLab Token"
                        />
                      </SettingField>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="w-fit"
                        disabled={savingKey !== null}
                        onClick={() => void saveToken('gitlabToken')}
                      >
                        {savingKey === 'gitlabToken' ? (
                          <Loader2Icon className="animate-spin-slow" size={11} />
                        ) : (
                          <KeyRoundIcon size={11} />
                        )}
                        {savingKey === 'gitlabToken' ? '保存中' : '保存'}
                      </Button>
                    </FieldGroup>
                  </Section>
                  <Section
                    title="GitLab MCP"
                    description="通过 MCP 协议让 AI 访问 GitLab 数据。MCP 服务复用上方 URL 与 Token，使用 npx @zereight/mcp-gitlab 建立连接。"
                  >
                    <FieldGroup className="gap-2.5">
                      <TestButton kind="gitlab" label="测试 GitLab MCP 连接" />
                    </FieldGroup>
                  </Section>
                </TabsContent>
                <TabsContent value="atlassian" className="space-y-5">
                  <Section title="Jira">
                    <FieldGroup className="gap-2.5">
                      <SettingField label="Jira Host">
                        <Input
                          value={settings.jiraUrl}
                          onChange={(event) => update('jiraUrl', event.target.value)}
                          onBlur={(event) => void persistSetting('jiraUrl', event.target.value)}
                          placeholder="请输入Jira Host"
                        />
                      </SettingField>
                      <SettingField label="Jira Token">
                        <SecretInput
                          aria-label="Jira Token"
                          value={settings.jiraToken}
                          onChange={(event) => update('jiraToken', event.target.value)}
                          placeholder="请输入Jira Token"
                        />
                      </SettingField>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          className="w-fit"
                          disabled={savingKey !== null}
                          onClick={() => void saveToken('jiraToken')}
                        >
                          {savingKey === 'jiraToken' ? (
                            <Loader2Icon className="animate-spin-slow" size={11} />
                          ) : (
                            <KeyRoundIcon size={11} />
                          )}
                          {savingKey === 'jiraToken' ? '保存中' : '保存'}
                        </Button>
                        <TestButton kind="jira" label="测试 Jira 连接" />
                      </div>
                    </FieldGroup>
                  </Section>
                  <Section title="Confluence">
                    <FieldGroup className="gap-2.5">
                      <SettingField label="Confluence Host">
                        <Input
                          value={settings.confluenceUrl}
                          onChange={(event) => update('confluenceUrl', event.target.value)}
                          onBlur={(event) => void persistSetting('confluenceUrl', event.target.value)}
                          placeholder="请输入Confluence Host"
                        />
                      </SettingField>
                      <SettingField label="Confluence Token">
                        <SecretInput
                          aria-label="Confluence Token"
                          value={settings.confluenceToken}
                          onChange={(event) => update('confluenceToken', event.target.value)}
                          placeholder="请输入Confluence Token"
                        />
                      </SettingField>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          className="w-fit"
                          disabled={savingKey !== null}
                          onClick={() => void saveToken('confluenceToken')}
                        >
                          {savingKey === 'confluenceToken' ? (
                            <Loader2Icon className="animate-spin-slow" size={11} />
                          ) : (
                            <KeyRoundIcon size={11} />
                          )}
                          {savingKey === 'confluenceToken' ? '保存中' : '保存'}
                        </Button>
                        <TestButton kind="confluence" label="测试 Confluence 连接" />
                      </div>
                    </FieldGroup>
                  </Section>
                </TabsContent>
                <TabsContent value="repositories" className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2.5">
                    <div>
                      <h3 className="text-xs font-semibold">仓库</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        所有配置的仓库都会出现在这里，新增时从本地 Git 文件夹读取信息。
                      </p>
                    </div>
                    <Button size="sm" onClick={() => void addRepository()}>
                      <PlusIcon size={11} />
                      新增仓库
                    </Button>
                  </div>
                  {repositories.length ? (
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {repositories.map((repository) => (
                        <RepositoryCard
                          key={repository.id}
                          repository={repository}
                          agent={agentForRepository(repository.id)}
                          onEdit={() => setRepositoryDialog({ open: true, initial: repository })}
                          onDelete={() => setDeleteRepository(repository)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                      还没有配置仓库
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="agents" className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2.5">
                    <div>
                      <h3 className="text-xs font-semibold">Agent</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        为仓库分配领域专精 Agent：任务执行时自动注入其指引并按首选模型路由。
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button size="sm" variant="outline" onClick={exportAgents} title="导出全部 Agent 为 JSON 文件">
                        <DownloadIcon size={11} />
                        导出
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={importAgents}
                        title="从 JSON 文件导入 Agent（已存在则覆盖）"
                      >
                        <UploadIcon size={11} />
                        导入
                      </Button>
                      <Button size="sm" onClick={() => setAgentDialog({ open: true })}>
                        <PlusIcon size={11} />
                        新增 Agent
                      </Button>
                    </div>
                  </div>
                  <Tabs value={agentTab} onValueChange={(value) => setAgentTab(value as 'system' | 'custom')}>
                    <TabsList className="h-7 justify-start gap-0.5 rounded-md border bg-card/40 p-0.5">
                      <TabsTrigger value="system" className="h-6 px-2.5 text-xs!">
                        系统角色
                      </TabsTrigger>
                      <TabsTrigger value="custom" className="h-6 px-2.5 text-xs!">
                        自定义 Agent
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="system" className="mt-2.5 space-y-1.5">
                      {(() => {
                        const roleAgents = agents.filter((a) => ROLE_AGENT_IDS.includes(a.id))
                        return roleAgents.length ? (
                          <div className="grid gap-1.5">
                            {roleAgents.map((agent) => (
                              <AgentCard
                                key={agent.id}
                                agent={agent}
                                boundRepositories={0}
                                onEdit={() => setAgentDialog({ open: true, initial: agent })}
                                onDelete={() => setDeleteAgent(agent)}
                                onToggleEnabled={(enabled) => void toggleAgentEnabled(agent, enabled)}
                                hideDelete
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                            暂无系统角色
                          </div>
                        )
                      })()}
                    </TabsContent>
                    <TabsContent value="custom" className="mt-2.5 space-y-1.5">
                      {(() => {
                        const customAgents = agents.filter((a) => !ROLE_AGENT_IDS.includes(a.id))
                        return customAgents.length ? (
                          <div className="grid gap-1.5">
                            {customAgents.map((agent) => (
                              <AgentCard
                                key={agent.id}
                                agent={agent}
                                boundRepositories={
                                  agent.repositoryIds.filter((id) => repositories.some((repo) => repo.id === id)).length
                                }
                                onEdit={() => setAgentDialog({ open: true, initial: agent })}
                                onDelete={() => setDeleteAgent(agent)}
                                onToggleEnabled={(enabled) => void toggleAgentEnabled(agent, enabled)}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                            还没有配置自定义 Agent，未绑定 Agent 的仓库将使用通用能力执行
                          </div>
                        )
                      })()}
                    </TabsContent>
                  </Tabs>
                </TabsContent>
                <TabsContent value="memory" className="space-y-5">
                  <Section
                    title="记忆管理"
                    description="用户级与仓库级长期记忆会注入到对话与任务执行上下文，可在此新增、修正或删除。"
                  >
                    <div className="flex items-start justify-between gap-2.5">
                      <div>
                        <h3 className="text-xs font-semibold">记忆</h3>
                        <p className="mt-0.5 text-xs text-muted-foreground">共 {memories.length} 条</p>
                      </div>
                      {/* <Button size="sm" onClick={openMemoryCreate}>
                        <PlusIcon size={11} />
                        新增记忆
                      </Button> */}
                    </div>
                    <Tabs value={activeMemoryTab} onValueChange={setActiveMemoryTab}>
                      <TabsList className="h-7 justify-start gap-0.5 rounded-md border bg-card/40 p-0.5">
                        <TabsTrigger value="user" className="h-6 px-2.5 text-xs!">
                          用户
                        </TabsTrigger>
                        {repositories.map((repository) => (
                          <TabsTrigger
                            key={repository.id}
                            value={repository.id}
                            className="h-6 max-w-36 px-2.5 text-xs!"
                          >
                            <span className="truncate">{repository.name}</span>
                          </TabsTrigger>
                        ))}
                      </TabsList>
                      <TabsContent value="user" className="mt-2.5 space-y-1.5">
                        {userMemories.length ? (
                          userMemories.map((memory) => (
                            <MemoryCard
                              key={memory.id}
                              memory={memory}
                              expanded={expandedMemoryId === memory.id}
                              onToggle={() =>
                                setExpandedMemoryId((current) => (current === memory.id ? undefined : memory.id))
                              }
                              onEdit={() => setMemoryDialog({ open: true, initial: memory })}
                              onDelete={() => setDeleteMemory(memory)}
                            />
                          ))
                        ) : (
                          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                            还没有用户级记忆
                          </div>
                        )}
                      </TabsContent>
                      {repositories.map((repository) => {
                        const repoMemories = memories.filter(
                          (memory) => memory.scope === 'repo' && memory.repositoryId === repository.id
                        )
                        return (
                          <TabsContent key={repository.id} value={repository.id} className="mt-2.5 space-y-1.5">
                            <div className="flex items-center justify-between rounded-md border bg-card/40 px-3 py-2">
                              <p className="text-[11px] text-muted-foreground">
                                repowiki 索引 {wikiCounts[repository.id] ?? 0} 篇
                              </p>
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={rebuildingWiki === repository.id}
                                onClick={() => void rebuildRepoWiki(repository.id)}
                              >
                                {rebuildingWiki === repository.id ? (
                                  <Loader2Icon className="animate-spin-slow" size={11} />
                                ) : (
                                  <RefreshCwIcon size={11} />
                                )}
                                {rebuildingWiki === repository.id ? '索引中' : '重建索引'}
                              </Button>
                            </div>
                            {repoMemories.length ? (
                              repoMemories.map((memory) => (
                                <MemoryCard
                                  key={memory.id}
                                  memory={memory}
                                  repository={repository}
                                  expanded={expandedMemoryId === memory.id}
                                  onToggle={() =>
                                    setExpandedMemoryId((current) => (current === memory.id ? undefined : memory.id))
                                  }
                                  onEdit={() => setMemoryDialog({ open: true, initial: memory })}
                                  onDelete={() => setDeleteMemory(memory)}
                                />
                              ))
                            ) : (
                              <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                                该仓库还没有记忆
                              </div>
                            )}
                          </TabsContent>
                        )
                      })}
                    </Tabs>
                  </Section>
                  <MemorySearchProbe repositories={repositories} />
                </TabsContent>
                <TabsContent value="model" className="space-y-5">
                  <Section title="Qoder 模型" description="可用模型由 Qoder 连接状态提供，徽章与对话面板保持一致。">
                    <FieldGroup className="gap-2.5">
                      {qoder?.usage?.isQuotaExceeded && (
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-4 text-amber-500">
                          Qoder 额度不足，当前仅 lite 免费模型可用
                        </div>
                      )}
                      {qoder?.models.length ? (
                        <div className="grid gap-1.5">
                          {qoder.models.map((item) => (
                            <QoderModelCard
                              key={item.value}
                              model={item}
                              isDefault={
                                systemDefault?.driverId === 'qoder' && systemDefault.model === `qoder:${item.value}`
                              }
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                          未发现 Qoder 模型
                        </div>
                      )}
                    </FieldGroup>
                  </Section>
                  <Section
                    title="自定义模型"
                    description="连接兼容 OpenAI API 格式的模型服务，可配置多个并指定组内默认 profile（Qoder 不可用时系统默认跟随它）。"
                  >
                    <FieldGroup className="gap-2.5">
                      <Button
                        size="sm"
                        variant={openAIProfiles.length > 0 ? 'secondary' : 'default'}
                        onClick={() => setOpenAIDialog({ open: true, mode: 'create' })}
                        className="w-fit"
                      >
                        <PlusIcon size={11} />
                        新增自定义模型
                      </Button>
                      {openAIProfiles.length === 0 ? (
                        <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                          尚未配置自定义模型，点击上方新增。
                        </div>
                      ) : (
                        groupProfilesByVendor(openAIProfiles).map((block) => (
                          <div key={block.vendor} className="space-y-1.5">
                            <div className="flex items-center gap-1 px-0.5">
                              <span className="text-[11px] font-semibold text-foreground/80">{block.label}</span>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help">
                                    <InfoIcon size={11} className="text-muted-foreground" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" align="start" className="max-w-72 whitespace-pre-line">
                                  {block.items.map((p) => `${p.displayName || p.model}: ${p.baseUrl}`).join('\n')}
                                </TooltipContent>
                              </Tooltip>
                            </div>
                            {block.items.map((profile) => (
                              <div
                                key={profile.id}
                                className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5"
                              >
                                <div className="flex min-w-0 items-center gap-2.5">
                                  <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                                    <ExternalLinkIcon size={14} />
                                  </div>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <h4 className="truncate text-xs font-semibold text-foreground">
                                        {profile.displayName || profile.model}
                                      </h4>
                                      <Badge variant="muted" className="text-[9px]">
                                        已配置
                                      </Badge>
                                      {profile.isDefault && <Badge className="text-[9px]">默认</Badge>}
                                    </div>
                                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                                      {profile.model}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setOpenAIDialog({ open: true, mode: 'edit', editing: profile })}
                                  >
                                    <PencilIcon size={11} />
                                    编辑
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-muted-foreground hover:text-destructive"
                                    onClick={() => void deleteOpenAIProfile(profile.id)}
                                  >
                                    <Trash2Icon size={11} />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ))
                      )}
                    </FieldGroup>
                  </Section>
                </TabsContent>
                <TabsContent value="mcp" className="space-y-5">
                  <McpSettingsTab />
                </TabsContent>
                <TabsContent value="skill" className="space-y-5">
                  <SkillSettingsTab />
                </TabsContent>
              </div>
            </Tabs>
          )}
          <DialogFooter className="border-t px-6 py-2.5">
            <DialogClose asChild>
              <Button variant="secondary" size="sm">
                关闭
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RepositoryDialog
        open={repositoryDialog.open}
        initial={repositoryDialog.initial}
        onOpenChange={(next) => setRepositoryDialog((current) => ({ ...current, open: next }))}
        onError={(reason) => showError(reason instanceof Error ? reason.message : String(reason))}
        onSaved={async () => {
          setRepositoryDialog({ open: false })
          await refreshRepositories()
        }}
      />
      <AgentDialog
        open={agentDialog.open}
        initial={agentDialog.initial}
        repositories={repositories}
        templates={agentTemplates}
        agents={agents}
        builtin={agentDialog.initial ? ROLE_AGENT_IDS.includes(agentDialog.initial.id) : false}
        onOpenChange={(next) => setAgentDialog((current) => ({ ...current, open: next }))}
        onError={(reason) => showError(reason instanceof Error ? reason.message : String(reason))}
        onSaved={async () => {
          setAgentDialog({ open: false })
          await refreshAgents()
        }}
      />
      <OpenAIProfileDialog
        open={openAIDialog.open}
        mode={openAIDialog.mode}
        initial={openAIInitial}
        onOpenChange={(next) => setOpenAIDialog((current) => ({ ...current, open: next }))}
        onSaved={(profile) => void saveOpenAIProfile(profile)}
        onDeleted={() => {
          if (openAIDialog.editing) void deleteOpenAIProfile(openAIDialog.editing.id)
        }}
        onError={(reason) => showError(reason instanceof Error ? reason.message : String(reason))}
      />
      <MemoryDialog
        open={memoryDialog.open}
        initial={memoryDialog.initial}
        repositories={repositories}
        onOpenChange={(next) => setMemoryDialog((current) => ({ ...current, open: next }))}
        onError={(reason) => showError(reason instanceof Error ? reason.message : String(reason))}
        onSaved={async () => {
          setMemoryDialog({ open: false })
          await refreshMemories()
        }}
      />
      <AlertDialog
        open={Boolean(deleteMemory)}
        onOpenChange={(next) => {
          if (!next) setDeleteMemory(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除记忆？</AlertDialogTitle>
            <AlertDialogDescription>将永久删除「{deleteMemory?.title}」，删除后无法恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeMemory()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(deleteAgent)}
        onOpenChange={(next) => {
          if (!next) setDeleteAgent(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 Agent？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleteAgent?.name}」。已绑定该 Agent 的仓库将回退使用通用能力执行。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeAgent()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(deleteRepository)}
        onOpenChange={(next) => {
          if (!next) setDeleteRepository(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除仓库配置？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleteRepository?.name}」的配置，不会删除本地文件夹。
              {boundAgentCount > 0 ? `已绑定该仓库的 ${boundAgentCount} 个 Agent 将同步解绑。` : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeRepository()}>删除配置</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
