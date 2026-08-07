import { useEffect, useState } from 'react'
import { Loader2Icon, SaveIcon, SparklesIcon } from 'lucide-react'
import type { AgentProfile, RepositoryProfile } from '@coding-agent/core'
import { ChatModelSelector } from '../../ChatPage/components/ChatModelSelector'
import { AgentAIGenerateDialog } from './AgentAIGenerateDialog'
import type { AgentGenerationResult, AgentTemplate, ChatModelGroup } from '@/api'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export type AgentDraft = Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
const empty: AgentDraft = { name: '', systemPrompt: '', repositoryIds: [], wikiIncludePaths: [], enabled: true }

/**
 * 判断草稿里是否已有用户手动输入的实质内容（用于 AI 生成时的覆盖确认）。
 * 四个字段（name / description / systemPrompt / engineeringGuidelines）任一有非空值即视为已有。
 * 全用 trim() 判，避免把纯空白误判为"已有"。
 */
function hasAnyUserInput(draft: AgentDraft): boolean {
  return Boolean(
    draft.name.trim() || draft.description?.trim() || draft.systemPrompt.trim() || draft.engineeringGuidelines?.trim()
  )
}

/** 根据模型 value 在 groups 中查找 driverId，映射为 preferredProvider。 */
function providerForModel(value: string | undefined, groups: ChatModelGroup[]): 'qoder' | 'openai' | undefined {
  if (!value) return undefined
  for (const group of groups) {
    if (group.models.some((m) => m.value === value)) {
      if (group.driverId === 'qoder') return 'qoder'
      if (group.driverId === 'openai') return 'openai'
      return undefined
    }
  }
  return undefined
}

export function AgentDialog({
  open,
  onOpenChange,
  initial,
  repositories,
  templates,
  onSaved,
  onError,
  builtin
}: {
  open: boolean
  onOpenChange(open: boolean): void
  initial?: AgentProfile
  repositories: RepositoryProfile[]
  templates: AgentTemplate[]
  onSaved(agent: AgentProfile): void
  onError?(reason: unknown): void
  builtin?: boolean
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial ?? empty)
  const [saving, setSaving] = useState(false)
  const [aiGenerateOpen, setAiGenerateOpen] = useState(false)
  /** 生成结果回传：原内容为空时直接覆盖；非空时弹 AlertDialog 让用户决定。 */
  const [pendingGenerated, setPendingGenerated] = useState<AgentGenerationResult | undefined>(undefined)
  /**
   * 当前选中的「基于模板」下拉项。
   * 之前下拉是 `value="__none__"` 硬编码，Radix 始终认为选的是 `__none__` 项，
   * 导致选完模板后下拉框仍显示「不使用模板」。这里改为受控 state 跟踪。
   */
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (open) {
      setDraft(initial ?? empty)
      setSelectedTemplateId(undefined)
    }
  }, [initial, open])
  const update = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const applyTemplate = (template: AgentTemplate) =>
    setDraft((current) => ({
      ...current,
      name: current.name || template.name,
      systemPrompt: template.systemPrompt,
      engineeringGuidelines: template.engineeringGuidelines
    }))
  const toggleRepository = (repositoryId: string, checked: boolean) =>
    setDraft((current) => ({
      ...current,
      repositoryIds: checked
        ? [...current.repositoryIds, repositoryId]
        : current.repositoryIds.filter((id) => id !== repositoryId)
    }))
  // 模型选择器数据
  const [modelGroups, setModelGroups] = useState<ChatModelGroup[]>([])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .listChatModels()
      .then((groups) => {
        if (!cancelled) setModelGroups(groups)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open])
  const save = async () => {
    setSaving(true)
    try {
      // 选了模型才视为有偏好，否则跟随系统设置
      const hasModelPreference = Boolean(draft.preferredModel?.trim())
      const provider = hasModelPreference ? providerForModel(draft.preferredModel, modelGroups) : undefined
      const agent: AgentProfile = {
        id: draft.id ?? crypto.randomUUID(),
        name: draft.name.trim(),
        description: draft.description?.trim() || undefined,
        systemPrompt: draft.systemPrompt,
        engineeringGuidelines: draft.engineeringGuidelines?.trim() || undefined,
        preferredProvider: provider,
        preferredModel: hasModelPreference ? draft.preferredModel!.trim() : undefined,
        repositoryIds: draft.repositoryIds,
        wikiIncludePaths: draft.wikiIncludePaths?.length ? draft.wikiIncludePaths : undefined,
        enabled: draft.enabled,
        // 保留 builtin 标记：编辑系统角色时必须回写，否则下次 list() 反序列化后
        // builtin 会变成 undefined，丢失「内置」语义（任务级下拉就过滤不掉了）。
        builtin: builtin ? true : initial?.builtin,
        createdAt: initial?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      await api.saveAgent(agent)
      onSaved(agent)
      onOpenChange(false)
    } catch (reason) {
      onError?.(reason)
    } finally {
      setSaving(false)
    }
  }
  /**
   * AI 生成结果回调：
   *  - 任何字段（名称 / 说明 / systemPrompt / engineeringGuidelines）已有用户输入
   *    → 弹 AlertDialog 让用户确认覆盖；用户取消则保持原内容。
   *  - 全部为空 → 直接应用。
   *  空值用 trim() 判，避免空白被当作"已有内容"误导用户。
   */
  const handleGenerated = (result: AgentGenerationResult) => {
    const hasExisting = hasAnyUserInput(draft)
    if (hasExisting) {
      setPendingGenerated(result)
    } else {
      applyGenerated(result)
    }
  }
  /**
   * 把生成结果合到草稿上：
   *  - 名称 / 说明：仅在用户原值为空时填入，避免覆盖用户手输内容；
   *  - systemPrompt / engineeringGuidelines：直接覆盖（这是 AI 生成的主输出，
   *    且上面 AlertDialog 已经征询过用户意见）。
   */
  const applyGenerated = (result: AgentGenerationResult) => {
    setDraft((current) => ({
      ...current,
      name: current.name.trim() ? current.name : result.title || current.name,
      description: current.description?.trim() ? current.description : result.description || current.description,
      systemPrompt: result.systemPrompt,
      engineeringGuidelines: result.engineeringGuidelines
    }))
    setPendingGenerated(undefined)
  }
  // 模型偏好：取一次放进局部变量，类型收窄到 string，下方判断/JSX 都用它。
  const preferredModel = draft.preferredModel?.trim() || undefined
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="grid max-h-[min(560px,calc(100vh-64px))] w-[min(640px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
          <DialogHeader className="space-y-1 border-b px-5 pt-3.5 pb-3">
            <DialogTitle>{builtin ? '编辑系统角色' : draft.id ? '编辑 Agent' : '新增 Agent'}</DialogTitle>
            <DialogDescription>
              {builtin
                ? '系统内置角色 Agent 的名称、描述为固定值，仅可编辑系统提示词与模型偏好。'
                : 'Agent 携带领域系统提示词与模型偏好，通过仓库白名单绑定；任务执行时自动为关联仓库注入对应指引。'}
            </DialogDescription>
          </DialogHeader>
          <div className="thin-scrollbar min-h-0 overflow-y-auto px-5 py-4">
            {!draft.id && !builtin && templates.length > 0 && (
              <Field label="基于模板新建">
                <Select
                  value={selectedTemplateId ?? '__none__'}
                  onValueChange={(value) => {
                    if (value === '__none__') {
                      // 显式选择「不使用模板」：仅清除下拉选中状态，不动已填充的内容（用户手改后属于自己）。
                      setSelectedTemplateId(undefined)
                      return
                    }
                    const template = templates.find((item) => item.id === value)
                    if (template) {
                      setSelectedTemplateId(template.id)
                      applyTemplate(template)
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择模板（可选）" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__" className="text-xs">
                      不使用模板
                    </SelectItem>
                    {templates.map((template) => (
                      <SelectItem key={template.id} value={template.id} className="text-xs">
                        {template.name} — {template.description}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <FieldGroup className="mt-2 grid-cols-2 gap-3">
              <Field label="名称">
                <Input
                  value={draft.name}
                  onChange={(event) => update('name', event.target.value)}
                  placeholder="例如 Java 服务端"
                  disabled={builtin}
                />
              </Field>
              <Field label="描述">
                <Input
                  value={draft.description ?? ''}
                  onChange={(event) => update('description', event.target.value)}
                  placeholder="一句话说明适用场景"
                  disabled={builtin}
                />
              </Field>
              <Field className="col-span-2" label="系统提示词">
                <Textarea
                  rows={6}
                  value={draft.systemPrompt}
                  onChange={(event) => update('systemPrompt', event.target.value)}
                  placeholder={'领域知识、编码约定、需要严格遵守的规则……\n留空表示使用通用能力，不注入额外指引'}
                />
              </Field>
              <Field className="col-span-2" label="工程约定">
                <Textarea
                  rows={3}
                  value={draft.engineeringGuidelines ?? ''}
                  onChange={(event) => update('engineeringGuidelines', event.target.value)}
                  placeholder="实现前需要遵循的工程流程、复用约定（可选）"
                />
              </Field>
              <Field label="首选模型">
                <div className="flex items-center gap-1.5">
                  <ChatModelSelector
                    groups={modelGroups}
                    value={draft.preferredModel}
                    onChange={(value) => {
                      update('preferredModel', value ?? undefined)
                    }}
                  />
                  {preferredModel && (
                    <span className="text-[11px] text-muted-foreground">
                      {providerForModel(preferredModel, modelGroups) === 'qoder'
                        ? 'Qoder'
                        : providerForModel(preferredModel, modelGroups) === 'openai'
                          ? 'OpenAI'
                          : ''}
                    </span>
                  )}
                </div>
                {!preferredModel && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    AI 生成需要先选定一个模型；不选模型时跟随系统全局模型设置。
                  </p>
                )}
              </Field>
              {!builtin && (
                <>
                  <div className="col-span-2">
                    <p className="mb-1.5 text-xs font-medium text-foreground">适用仓库（白名单，可多选）</p>
                    {repositories.length ? (
                      <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded-md border bg-card/40 p-2">
                        {repositories.map((repository) => (
                          <label
                            key={repository.id}
                            className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/60"
                          >
                            <Checkbox
                              checked={draft.repositoryIds.includes(repository.id)}
                              onCheckedChange={(checked) => toggleRepository(repository.id, checked === true)}
                            />
                            <span className="truncate">{repository.name}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <p className="rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                        还没有配置仓库，可稍后在仓库页添加
                      </p>
                    )}
                  </div>
                  <div className="col-span-2 flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">启用</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        关闭后该 Agent 不参与仓库解析，相关仓库回退使用通用能力。
                      </span>
                    </span>
                    <Switch
                      checked={draft.enabled}
                      onCheckedChange={(checked) => update('enabled', checked)}
                      aria-label={draft.name.trim() ? `启用 Agent ${draft.name.trim()}` : '启用 Agent'}
                    />
                  </div>
                  <p className="col-span-2 text-[11px] leading-5 text-muted-foreground">
                    不配置模型时跟随系统全局模型设置；选择模型后自动识别对应提供者（Qoder / OpenAI 兼容）。
                  </p>
                </>
              )}
            </FieldGroup>
          </div>
          <DialogFooter className="border-t px-5 py-2.5">
            {/* AI 生成：未选模型时禁用，避免空请求；打开二级弹窗调模型填充系统提示词与工程约定。 */}
            <Button
              variant="outline"
              size="sm"
              className="mr-auto gap-1"
              disabled={!preferredModel || saving}
              onClick={() => setAiGenerateOpen(true)}
              title={preferredModel ? '用选定模型生成系统提示词与工程约定' : '请先选择一个模型'}
            >
              <SparklesIcon size={12} />
              AI 生成
            </Button>
            <DialogClose asChild>
              <Button variant="secondary" size="sm">
                取消
              </Button>
            </DialogClose>
            <Button size="sm" disabled={saving || !draft.name.trim()} onClick={() => void save()}>
              {saving ? <Loader2Icon className="animate-spin-slow" size={11} /> : <SaveIcon size={11} />}
              {saving ? '保存中' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* AI 生成二级弹窗：未选模型时入口已在 AgentDialog 禁用，此处再做一次校验防御。
          仓库选择与 host 完全共享：受控透传 draft.repositoryIds，在二级弹窗调整后同步回 host。 */}
      {preferredModel && (
        <AgentAIGenerateDialog
          open={aiGenerateOpen}
          onOpenChange={setAiGenerateOpen}
          model={preferredModel}
          repositories={repositories}
          selectedRepositoryIds={draft.repositoryIds}
          onSelectedRepositoryIdsChange={(ids) => update('repositoryIds', ids)}
          onGenerated={handleGenerated}
          onError={onError}
        />
      )}
      <AlertDialog
        open={Boolean(pendingGenerated)}
        onOpenChange={(next) => {
          if (!next) setPendingGenerated(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>覆盖现有内容？</AlertDialogTitle>
            <AlertDialogDescription>
              AI 已生成新的「名称 / 说明 / 系统提示词 / 工程约定」。继续将覆盖这些字段中
              已有用户输入的部分（未填写的字段会被自动补齐）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingGenerated(undefined)}>保留原内容</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingGenerated && applyGenerated(pendingGenerated)}>
              覆盖
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
