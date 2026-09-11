import { useEffect, useRef, useState } from 'react'
import {
  CheckIcon,
  ChevronDownIcon,
  GitMergeIcon,
  HandIcon,
  Loader2Icon,
  PlayIcon,
  SaveIcon,
  SlidersHorizontalIcon
} from 'lucide-react'
import type { AgentProfile, RepositoryProfile, Task, TaskRepository, TaskMrMode } from '@task-pipeline/core'
import { mergeRepositoryOptions, RepositoryPicker } from './RepositoryPicker'
import { api, type RepositoryCommands, type StartTaskOptions } from '@/api'
import { useFeedback } from '@/hooks/useGlobalFeedback'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
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
import { Field, FieldGroup } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { getLastSelectedModel } from '@/utils/last-model-cache'
// 与 packages/core/src/types.ts 的 AGENT_TASK_DISABLED 保持一致；
// 前端不得 import core 运行值（会拖入 better-sqlite3，导致 vite 预打包在浏览器环境崩溃）
const AGENT_TASK_DISABLED = '__disabled__'

/** 仓库命令的展示名，用于折叠态的命令摘要。 */
const COMMAND_LABELS = {
  setupCommand: '准备',
  lintCommand: 'Lint',
  testCommand: 'Test',
  buildCommand: 'Build'
} as const

/**
 * 任务编辑/启动 统一弹窗。
 *
 * 「一个弹窗，只区分提交行为」：
 *   - edit 模式：保存任务（新建/更新）+ 同步仓库 + 持久化仓库命令，关闭弹窗。
 *   - start 模式：先保存任务 + 同步仓库 + 持久化命令（让用户可以顺手改任务正文），再启动任务。
 *
 * 共享字段（两种模式都展示、都可编辑）：
 *   标题 / 描述 / 关键词 / 验收标准 / Review 通过后提交档 / 关联仓库（含每个仓库的命令配置，默认折叠）
 *
 * 高级设置（默认折叠）：
 *   执行 Agent（任务级：跟随仓库 / 指定 / 禁用）/ 逐仓库执行 Agent
 *
 * 固定链路下「直接开始 / 先生成计划」不再是可选分叉，启动方式卡片已删。
 *
 * 共享：宽度 720px、容器 max-h-[88vh] flex-col、正文 max-h-[58vh] overflow-y-auto；
 * 共享：DialogHeader / DialogFooter 排版；共享：仓库选择 + 取消按钮。
 */
export type TaskEditorDialogMode = 'edit' | 'start'

/**
 * 系统默认的 MR 提交档：仍读旧的 `autoCreateMergeRequests` 设置键。
 *
 * core 的 `resolveMrMode()` 回落链读的就是这个键，UI 只负责展示「不单独设置时会怎样」，
 * 不再另立一个新的设置项，避免同一个决策两个来源。
 */
function readSystemMrDefault(): Promise<TaskMrMode> {
  return api.getSetting('autoCreateMergeRequests').then((value) => (value === 'true' ? 'auto' : 'manual'))
}

/**
 * 「Review 通过后」提交档卡片：本任务唯一的主决策。
 *
 * 视觉上沿用原双卡语言（icon + 标题 + 描述，选中态 `border-primary` + `ring`），
 * 但语义不同：**初始两张卡都不选中**，`undefined` 表示「不写 `task.mrAutoSubmit`、跟随系统默认」——
 * 这样 core 回落链里「任务级未设置」这个状态在 UI 上可达，而不是一进来就被写成显式值。
 * 已显式选择后，helper 行给出「恢复跟随」把字段清回去。
 */
function MrModeCards({
  value,
  systemDefault,
  onChange
}: {
  value: TaskMrMode | undefined
  systemDefault: TaskMrMode
  onChange(next: TaskMrMode | undefined): void
}) {
  const options: Array<{ value: TaskMrMode; label: string; description: string; Icon: typeof PlayIcon }> = [
    { value: 'auto', label: '自动提交 MR', description: 'Review 通过后直接创建 Merge Request。', Icon: GitMergeIcon },
    { value: 'manual', label: '停住，我手动提', description: '停在待提交，由人确认后自己提。', Icon: HandIcon }
  ]
  return (
    <Field
      label={
        <span className="flex items-center gap-2">
          <span>Review 通过后</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
            系统默认
            <span
              className={cn('font-medium', systemDefault === 'auto' ? 'text-emerald-500' : 'text-muted-foreground/80')}
            >
              {systemDefault === 'auto' ? '自动提交' : '手动提交'}
            </span>
          </span>
        </span>
      }
    >
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Review 通过后的 MR 提交方式">
          {options.map((option) => {
            const active = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange(option.value)}
                className={cn(
                  'rounded-md border p-3 text-left transition-all focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
                  active
                    ? 'border-primary/60 bg-primary/[0.06] ring-1 ring-primary/30'
                    : 'border-border/60 hover:border-foreground/30 hover:bg-foreground/[0.02]'
                )}
              >
                <div className="flex items-center gap-1.5">
                  <option.Icon size={12} className={cn(active ? 'text-primary' : 'text-muted-foreground')} />
                  <span className={cn('text-xs font-medium', active ? 'text-foreground' : 'text-foreground/80')}>
                    {option.label}
                  </span>
                  {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />}
                </div>
                <p className="mt-1 text-[10.5px] leading-snug text-muted-foreground">{option.description}</p>
              </button>
            )
          })}
        </div>
        <p className="flex flex-wrap items-center gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <span>
            {value === undefined
              ? `未为本任务单独设置，跟随系统默认（${systemDefault === 'auto' ? '自动提交 MR' : '手动提交'}）。`
              : '已为本任务单独设置，优先于系统默认。'}
          </span>
          {value !== undefined && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-[11px] font-normal"
              onClick={() => onChange(undefined)}
            >
              恢复跟随
            </Button>
          )}
        </p>
      </div>
    </Field>
  )
}

/**
 * 任务级 Agent 覆盖的三态控件（与 AutomationOverrideField 同视觉语言）：
 *
 * -「跟随仓库」= `undefined`：按仓库白名单解析（默认），保存时不写 task 字段。
 * -「指定」= 具体 Agent id：强制使用该 Agent，不受仓库绑定限制。
 * -「禁用」= `AGENT_TASK_DISABLED`：本任务不注入 Agent 上下文，模型跟随系统设置。
 */
function TaskAgentOverrideField({
  agents,
  value,
  onChange
}: {
  agents: AgentProfile[]
  value: string | undefined
  onChange(next: string | undefined): void
}) {
  const choice = value === undefined ? 'follow' : value === AGENT_TASK_DISABLED ? 'disabled' : 'custom'
  // 任务级指定：只允许选用户自建/自定义 Agent；系统 builtin Agent 由仓库白名单自动解析，不开放覆盖。
  const selectableAgents = agents.filter((agent) => !agent.builtin)
  const selected = selectableAgents.find((agent) => agent.id === value)
  return (
    <Field label={<span className="text-xs font-medium">执行 Agent</span>}>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex h-7 items-center gap-0.5 rounded-md border bg-card/40 p-0.5 text-[11px]">
            <Button
              type="button"
              variant={choice === 'follow' ? 'default' : 'ghost'}
              size="sm"
              className="h-6 px-2"
              onClick={() => onChange(undefined)}
              aria-pressed={choice === 'follow'}
            >
              跟随仓库
            </Button>
            <Button
              type="button"
              variant={choice === 'custom' ? 'default' : 'ghost'}
              size="sm"
              className="h-6 px-2"
              disabled={selectableAgents.length === 0}
              onClick={() => onChange(selectableAgents[0]?.id)}
              aria-pressed={choice === 'custom'}
            >
              指定
            </Button>
            <Button
              type="button"
              variant={choice === 'disabled' ? 'default' : 'ghost'}
              size="sm"
              className="h-6 px-2"
              onClick={() => onChange(AGENT_TASK_DISABLED)}
              aria-pressed={choice === 'disabled'}
            >
              禁用
            </Button>
          </div>
          {choice === 'custom' && (
            <Select value={value} onValueChange={(next) => onChange(next)}>
              <SelectTrigger className="h-7 w-44 text-xs" aria-label="指定执行 Agent">
                <SelectValue placeholder="选择 Agent" />
              </SelectTrigger>
              <SelectContent>
                {selectableAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id} className="text-xs">
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          任务执行时注入哪个 Agent 的指引并按其实例路由模型。
          {choice === 'custom' && selected && (
            <span className="ml-1 text-foreground/70">实际生效：{selected.name}（任务独立指定）</span>
          )}
          {choice === 'follow' && <span className="ml-1 text-foreground/70">实际生效：按仓库白名单解析</span>}
          {choice === 'disabled' && (
            <span className="ml-1 text-foreground/70">实际生效：禁用注入，模型跟随系统设置</span>
          )}
        </p>
      </div>
    </Field>
  )
}

/**
 * 任务正文：标题 / 描述 / 关键词 / 验收标准 的输入字段。
 *
 * 两种模式都使用此组件并允许编辑。start 模式下用户改完后会随"开始实现"一起持久化，
 * 不必先退出再去 edit 弹窗单独改一遍。
 */
function TaskBodyFields({
  title,
  description,
  keywords,
  acceptance,
  onTitleChange,
  onDescriptionChange,
  onKeywordsChange,
  onAcceptanceChange
}: {
  title: string
  description: string
  keywords: string
  acceptance: string
  onTitleChange(next: string): void
  onDescriptionChange(next: string): void
  onKeywordsChange(next: string): void
  onAcceptanceChange(next: string): void
}) {
  return (
    <FieldGroup className="grid-cols-1 gap-3">
      <Field label="标题">
        <Input
          // eslint-disable-next-line jsx-a11y/no-autofocus -- 弹窗内首输入焦点，提升操作效率
          autoFocus
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="请输入标题"
        />
      </Field>
      <Field label="描述">
        <Textarea
          value={description}
          rows={3}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder="请输入描述"
        />
      </Field>
      <Field label="关键词（逗号分隔）">
        <Input value={keywords} onChange={(event) => onKeywordsChange(event.target.value)} placeholder="请输入关键词" />
      </Field>
      <Field label="验收标准（每行一条）">
        <Textarea
          value={acceptance}
          rows={2}
          onChange={(event) => onAcceptanceChange(event.target.value)}
          placeholder="请输入验收标准"
        />
      </Field>
    </FieldGroup>
  )
}

/**
 * 逐仓库执行 Agent 覆盖（从仓库面板标题行移到高级设置）。
 *
 * 与任务级「执行 Agent」并存：仓库级优先，未设置的仓库回落到任务级 / 仓库绑定。
 * 不单独占主区一行：它属于「偶尔调一次」的配置，且需要随仓库数量增长。
 */
function RepoAgentOverrideField({
  repos,
  agents,
  values,
  onChange
}: {
  repos: RepositoryProfile[]
  agents: AgentProfile[]
  values: Record<string, string>
  onChange(repositoryId: string, agentId: string | undefined): void
}) {
  const selectableAgents = agents.filter((agent) => !agent.builtin)
  return (
    <Field label={<span className="text-xs font-medium">逐仓库执行 Agent</span>}>
      <div className="space-y-1.5">
        {repos.length === 0 && <p className="text-[11px] text-muted-foreground">未选择仓库。</p>}
        {repos.map((repo) => (
          <div key={repo.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">{repo.name}</span>
            <Select
              value={values[repo.id] || '__none__'}
              onValueChange={(next) => onChange(repo.id, next === '__none__' ? undefined : next)}
            >
              <SelectTrigger className="h-6 w-[170px] text-[11px]" aria-label={`${repo.name} 的执行 Agent`}>
                <SelectValue placeholder="默认 Agent" />
              </SelectTrigger>
              <SelectContent className="text-xs">
                <SelectItem value="__none__" className="text-xs">
                  默认 Agent（跟随仓库绑定）
                </SelectItem>
                {selectableAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id} className="text-xs">
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
    </Field>
  )
}

/**
 * 单个仓库的命令配置面板：默认折叠，标题行直接显示命令摘要。
 *
 * 之所以折叠：start 模式下用户通常不会在每次启动时都重写命令；展开后看到的
 * 4 个输入控件（setup / lint / test / build）占空间大。折叠态只占一行。
 */
function RepositoryCommandPanel({
  profile,
  isNewlyAttached,
  isOpen,
  onToggle,
  commands,
  onChange
}: {
  profile: RepositoryProfile
  isNewlyAttached: boolean
  isOpen: boolean
  onToggle(): void
  commands: RepositoryCommands | undefined
  onChange(key: keyof RepositoryCommands, value: string): void
}) {
  const configured = (['setupCommand', 'lintCommand', 'testCommand', 'buildCommand'] as const).filter((key) =>
    Boolean(commands?.[key]?.trim())
  )
  return (
    <section className="overflow-hidden rounded-md border bg-card/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-foreground/[0.02] focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-xs font-medium">{profile.name}</span>
          {isNewlyAttached && <span className="text-[10.5px] text-muted-foreground/80">· 新关联</span>}
          <span className="mx-1 h-3 w-px bg-border/60" />
          <span className="truncate text-[10.5px] text-muted-foreground">
            {configured.length === 0
              ? '未配置命令（回落仓库默认）'
              : `已配置 ${configured.map((key) => COMMAND_LABELS[key]).join(' / ')}`}
          </span>
        </div>
        <ChevronDownIcon size={11} className={cn('transition-transform duration-200', isOpen && 'rotate-180')} />
      </button>
      {isOpen && (
        <div className="border-t p-3">
          <FieldGroup className="grid-cols-2 gap-2">
            <Field className="col-span-2" label="准备命令">
              <Textarea
                value={commands?.setupCommand ?? ''}
                onChange={(event) => onChange('setupCommand', event.target.value)}
                placeholder="可选，例如 npm install"
              />
            </Field>
            <Field label="Lint">
              <Input
                value={commands?.lintCommand ?? ''}
                onChange={(event) => onChange('lintCommand', event.target.value)}
                placeholder="例如 npm run lint"
              />
            </Field>
            <Field label="Test">
              <Input
                value={commands?.testCommand ?? ''}
                onChange={(event) => onChange('testCommand', event.target.value)}
                placeholder="例如 npm test"
              />
            </Field>
            <Field className="col-span-2" label="Build">
              <Input
                value={commands?.buildCommand ?? ''}
                onChange={(event) => onChange('buildCommand', event.target.value)}
                placeholder="例如 npm run build"
              />
            </Field>
          </FieldGroup>
        </div>
      )}
    </section>
  )
}

export function TaskEditorDialog({
  mode,
  task,
  taskId,
  reimplement = false,
  open,
  onOpenChange,
  onSaved,
  onStarting,
  onStarted
}: {
  mode: TaskEditorDialogMode
  task?: Task
  taskId?: string
  reimplement?: boolean
  open: boolean
  onOpenChange(open: boolean): void
  onSaved(task: Task): void | Promise<void>
  onStarting?(taskId: string): void
  onStarted?(): Promise<void>
}) {
  // === 任务正文（两种模式都可编辑） ===
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [keywords, setKeywords] = useState('')
  const [acceptance, setAcceptance] = useState('')

  // === 共享：仓库选择 ===
  const [repositories, setRepositories] = useState<RepositoryProfile[]>([])
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const initialIdsRef = useRef<Set<string>>(new Set())
  const { showError, showSuccess } = useFeedback()

  // === 共享：主决策「Review 通过后」 + 高级设置（折叠面板） ===
  /** `undefined` = 不写 `task.mrAutoSubmit`，跟随系统默认（回落链见 core 的 `resolveMrMode`）。 */
  const [mrAutoSubmit, setMrAutoSubmit] = useState<TaskMrMode | undefined>(undefined)
  /** 只用于展示「不单独设置时会怎样」，不参与提交。 */
  const [systemMrDefault, setSystemMrDefault] = useState<TaskMrMode>('manual')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  // === 任务级 Agent 覆盖：undefined=跟随仓库 | AGENT_TASK_DISABLED=禁用 | 其它=指定 Agent id ===
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [agentProfileId, setAgentProfileId] = useState<string | undefined>(undefined)
  // 逐仓库 Agent 覆盖
  const [repoAgentIds, setRepoAgentIds] = useState<Record<string, string>>({})

  // === start 专用：仓库命令（默认折叠） / reimplement 标记 ===
  const [taskRepositories, setTaskRepositories] = useState<TaskRepository[]>([])
  const [commands, setCommands] = useState<Record<string, RepositoryCommands>>({})
  const [commandPanelsOpen, setCommandPanelsOpen] = useState<Record<string, boolean>>({})
  const [startSaving, setStartSaving] = useState(false)
  const [confirmingAll, setConfirmingAll] = useState(false)
  const reimplementedRef = useRef(false)

  // 依赖 key 用来在 open / mode / task.id 变化时统一重置状态
  const sessionKey = `${mode}|${open ? '1' : '0'}|${task?.id ?? ''}|${taskId ?? ''}`

  // 构造提交用的 task input：edit 和 start 共用一份 payload。
  const buildTaskInput = () => ({
    title: title.trim(),
    description: description.trim(),
    keywords: keywords
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    acceptanceCriteria: acceptance
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
    // 唯一的主决策：未显式选择不写入（后端 patch 会清掉字段，回到跟随系统默认）。
    mrAutoSubmit,
    // 任务级 Agent：undefined=跟随仓库（不写入）；AGENT_TASK_DISABLED / id 为显式覆盖。
    agentProfileId,
    // 逐仓库 Agent 覆盖
    repoAgentIds: Object.keys(repoAgentIds).length > 0 ? repoAgentIds : undefined,
    // 新建任务时继承 Chat 页面上次选择的模型，保证前后端一致
    ...(!task && getLastSelectedModel() ? { qoderModel: getLastSelectedModel() } : {})
  })

  // 同步仓库关联：edit / start 共用。
  const syncRepositories = async (targetTaskId: string, useAllRepositories: boolean) => {
    if (useAllRepositories) {
      for (const id of initialIdsRef.current) await api.detachRepository(targetTaskId, id)
      return
    }
    const desired = new Set(selectedRepoIds)
    const current = new Set(initialIdsRef.current)
    const toAttach = [...desired].filter((id) => !current.has(id))
    const toDetach = [...current].filter((id) => !desired.has(id))
    for (const repoId of toAttach) {
      await api.attachRepository(targetTaskId, repoId)
    }
    for (const repoId of toDetach) {
      await api.detachRepository(targetTaskId, repoId)
    }
  }

  useEffect(() => {
    if (!open) return
    if (mode === 'edit') {
      setTitle(task?.title ?? '')
      setDescription(task?.description ?? '')
      setKeywords(task?.keywords.join(', ') ?? '')
      setAcceptance(task?.acceptanceCriteria.join('\n') ?? '')
      setAdvancedOpen(false)
      setAgentProfileId(task?.agentProfileId ?? undefined)
      setMrAutoSubmit(task?.mrAutoSubmit)
    } else {
      // start 模式：标题等数据由下面的 fetch effect 填充；这里只清 start 专用状态。
      reimplementedRef.current = false
      setConfirmingAll(false)
      setCommandPanelsOpen({})
    }
  }, [sessionKey, mode, open, task?.title, task?.description, task?.keywords, task?.acceptanceCriteria, task])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)

    const repoPromise = api.listRepositories().catch((reason) => {
      showError(reason instanceof Error ? reason.message : String(reason))
      return [] as RepositoryProfile[]
    })

    // 两种模式都根据 taskId / task.id 拉详情——start 模式要靠它填充正文与初始化仓库。
    const detailTaskId = mode === 'edit' ? task?.id : taskId
    const detailPromise = detailTaskId
      ? api.getTask(detailTaskId).catch((reason) => {
          showError(reason instanceof Error ? reason.message : String(reason))
          return undefined
        })
      : Promise.resolve(undefined)

    // 读一次系统默认的 MR 提交档，只为在卡片上标出「不单独设置时会怎样」。
    const mrDefaultPromise = readSystemMrDefault()

    const agentsPromise = api.listAgents().catch((reason) => {
      showError(reason instanceof Error ? reason.message : String(reason))
      return [] as AgentProfile[]
    })

    Promise.all([repoPromise, detailPromise, mrDefaultPromise, agentsPromise])
      .then(([repos, detail, mrDefault, agentList]) => {
        if (cancelled) return
        setAgents(agentList)
        const attached = detail?.repositories ?? []
        const merged = mergeRepositoryOptions(repos, attached)
        setRepositories(merged)
        const ids = attached.map((item) => item.repositoryId)
        initialIdsRef.current = new Set(ids)
        setSelectedRepoIds(new Set(ids))
        // 用详情填充正文 + 提交档 + 仓库命令（start 模式起始默认值）
        if (detail?.task) {
          setTitle(detail.task.title)
          setDescription(detail.task.description)
          setKeywords(detail.task.keywords.join(', '))
          setAcceptance(detail.task.acceptanceCriteria.join('\n'))
          setAgentProfileId(detail.task.agentProfileId)
          setRepoAgentIds(detail.task.repoAgentIds ?? {})
          setMrAutoSubmit(detail.task.mrAutoSubmit)
        } else if (task) {
          setAgentProfileId(task.agentProfileId)
          setRepoAgentIds(task.repoAgentIds ?? {})
          setMrAutoSubmit(task.mrAutoSubmit)
        }
        setSystemMrDefault(mrDefault)
        setTaskRepositories(attached)
        const byProfile = new Map(attached.map((repo) => [repo.repositoryId, repo]))
        setCommands(
          Object.fromEntries(
            merged.map((profile) => {
              const repo = byProfile.get(profile.id)
              return [
                profile.id,
                {
                  setupCommand: repo?.setupCommand ?? profile.setupCommand,
                  lintCommand: repo?.lintCommand ?? profile.lintCommand,
                  testCommand: repo?.testCommand ?? profile.testCommand,
                  buildCommand: repo?.buildCommand ?? profile.buildCommand
                }
              ]
            })
          )
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, mode, task?.id, taskId, showError])

  // === edit 提交：保存任务 + 同步仓库 + 持久化命令 + 关闭 ===
  const save = async () => {
    setSaving(true)
    try {
      const saved = task ? await api.updateTask(task.id, buildTaskInput()) : await api.createTask(buildTaskInput())
      await syncRepositories(saved.id, false)
      // 持久化每个已选仓库的命令配置（setup / lint / test / build）。
      // 新关联的仓库在 syncRepositories 中已 attach，这里按 (taskId, repositoryId) 更新即可。
      for (const repoId of selectedRepoIds) {
        const cmds = commands[repoId]
        if (cmds) await api.updateTaskRepositoryCommands(saved.id, repoId, cmds)
      }
      await onSaved(saved)
      showSuccess(task ? '任务已更新' : '任务已创建')
      onOpenChange(false)
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  // === start 提交：先保存任务（让用户改的正文 / 自动化覆盖一起持久化），再启动 ===
  const startTask = async (useAllRepositories = false) => {
    if (!taskId) return
    if (selectedRepoIds.size === 0 && !useAllRepositories) {
      setConfirmingAll(true)
      return
    }
    setStartSaving(true)
    onStarting?.(taskId)
    onOpenChange(false)
    try {
      // 1) 任务正文 + 提交档 与 仓库关联 一起持久化（启动入参不再携带任务字段）。
      await api.updateTask(taskId, buildTaskInput())
      await syncRepositories(taskId, useAllRepositories)
      // 2) 启动。
      const repositoryCommands = Object.fromEntries([...selectedRepoIds].map((id) => [id, commands[id] ?? {}]))
      if (reimplement && !reimplementedRef.current) {
        await api.reimplementTask(taskId)
        reimplementedRef.current = true
      }
      const startOptions: StartTaskOptions = {
        repositoryCommands,
        repoAgentIds: Object.keys(repoAgentIds).length > 0 ? repoAgentIds : undefined,
        ...(useAllRepositories ? { useAllRepositories: true } : {})
      }
      await api.startTask(taskId, startOptions)
      await onStarted?.()
    } catch (reason) {
      await onStarted?.()
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStartSaving(false)
    }
  }

  const creating = mode === 'edit' && !task
  const selectedRepoProfiles = repositories.filter((repo) => selectedRepoIds.has(repo.id))

  // 启动按钮文案：固定链路下恒先生成计划，不再有「直接开始 / 先生成计划」两样写法。
  const startButtonLabel = startSaving ? '启动中' : selectedRepoIds.size === 0 ? '使用全部 system 仓库启动' : '启动任务'

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[88vh] w-[min(720px,calc(100vw-32px))] flex-col gap-3 overflow-hidden p-5">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {mode === 'edit' ? (creating ? '新建任务' : '编辑任务') : reimplement ? '重新实现' : '开始任务'}
            </DialogTitle>
            <DialogDescription>
              {mode === 'edit'
                ? creating
                  ? '创建本地任务，并选择要关联的仓库。'
                  : '调整标题、描述、关键词、验收标准与仓库关联。'
                : reimplement
                  ? '将基于现有任务重新实现。可直接修改任务正文，确认后启动会一并保存。'
                  : '可直接修改任务正文与 Review 通过后的提交档，确认后启动会一并保存任务。'}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="thin-scrollbar max-h-[58vh] grid-cols-1 gap-3 overflow-y-auto px-1 py-1 pr-2">
            <TaskBodyFields
              title={title}
              description={description}
              keywords={keywords}
              acceptance={acceptance}
              onTitleChange={setTitle}
              onDescriptionChange={setDescription}
              onKeywordsChange={setKeywords}
              onAcceptanceChange={setAcceptance}
            />

            <MrModeCards value={mrAutoSubmit} systemDefault={systemMrDefault} onChange={setMrAutoSubmit} />

            <Field
              label={
                <span className="flex items-center justify-between gap-2">
                  <span>关联仓库</span>
                  <small className="text-xs font-normal text-muted-foreground">
                    已选 {selectedRepoIds.size} / {repositories.length}
                  </small>
                </span>
              }
            >
              <RepositoryPicker
                repositories={repositories}
                selectedIds={selectedRepoIds}
                loading={loading}
                onToggle={(id, checked) =>
                  setSelectedRepoIds((prev) => {
                    const next = new Set(prev)
                    if (checked) next.add(id)
                    else next.delete(id)
                    return next
                  })
                }
              />
            </Field>

            {selectedRepoProfiles.map((profile) => {
              const taskRepo = taskRepositories.find((repo) => repo.repositoryId === profile.id)
              return (
                <RepositoryCommandPanel
                  key={profile.id}
                  profile={profile}
                  isNewlyAttached={!taskRepo}
                  isOpen={Boolean(commandPanelsOpen[profile.id])}
                  onToggle={() => setCommandPanelsOpen((prev) => ({ ...prev, [profile.id]: !prev[profile.id] }))}
                  commands={commands[profile.id]}
                  onChange={(key, value) =>
                    setCommands((current) => ({ ...current, [profile.id]: { ...current[profile.id], [key]: value } }))
                  }
                />
              )
            })}

            <fieldset className="overflow-hidden rounded-md border bg-card/40">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                aria-expanded={advancedOpen}
                aria-controls="task-advanced-section"
                onClick={() => setAdvancedOpen((value) => !value)}
              >
                <span className="inline-flex items-center gap-1.5 text-xs">
                  <SlidersHorizontalIcon size={11} className="text-foreground/70" />
                  高级设置 · 执行 Agent
                </span>
                <ChevronDownIcon
                  size={11}
                  className={cn('transition-transform duration-200', advancedOpen && 'rotate-180')}
                />
              </button>
              {advancedOpen && (
                <div id="task-advanced-section" className="space-y-3 border-t p-3">
                  <p className="text-[11px] text-muted-foreground">
                    执行 Agent 属于任务怎么跑的配置；Review、测试用例、提交都是必经阶段，已经没有开关了。
                  </p>
                  <TaskAgentOverrideField agents={agents} value={agentProfileId} onChange={setAgentProfileId} />
                  <RepoAgentOverrideField
                    repos={selectedRepoProfiles}
                    agents={agents}
                    values={repoAgentIds}
                    onChange={(repositoryId, agentId) =>
                      setRepoAgentIds((prev) => ({ ...prev, [repositoryId]: agentId ?? '' }))
                    }
                  />
                </div>
              )}
            </fieldset>
          </FieldGroup>

          <DialogFooter className="shrink-0">
            <DialogClose asChild>
              <Button variant="secondary" size="sm" disabled={saving || startSaving}>
                取消
              </Button>
            </DialogClose>
            {mode === 'edit' ? (
              <Button size="sm" disabled={!title.trim() || saving || loading} onClick={() => void save()}>
                {saving ? <Loader2Icon className="animate-spin-slow" size={12} /> : <SaveIcon size={12} />}
                {creating ? '创建' : '保存'}
              </Button>
            ) : (
              <Button size="sm" disabled={startSaving || loading || !taskId} onClick={() => void startTask(false)}>
                {startSaving ? <Loader2Icon className="animate-spin-slow" size={12} /> : <PlayIcon size={12} />}
                {startButtonLabel}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {mode === 'start' && (
        <AlertDialog open={confirmingAll} onOpenChange={setConfirmingAll}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>使用系统配置的全部仓库？</AlertDialogTitle>
              <AlertDialogDescription>
                未选择任何仓库，任务启动时会自动 attach 系统配置的全部 {repositories.length} 个仓库。
                <br />
                后续可随时在任务详情调整关联。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>返回选择</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmingAll(false)
                  void startTask(true)
                }}
              >
                <CheckIcon size={11} />
                确认启动
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  )
}
