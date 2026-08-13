import { useEffect, useState } from 'react'
import { AlertCircleIcon, Loader2Icon, SparklesIcon } from 'lucide-react'
import type { RepositoryProfile } from '@task-pipeline/core'
import type { AgentGenerationInput, AgentGenerationResult } from '@/api'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

/**
 * AI 生成 Agent 内容弹窗。
 *
 * 由 AgentDialog 中"AI 生成"按钮唤起，承载：
 *  1. 用户自然语言描述（必填，便于模型对齐领域与风格）；
 *  2. 仓库多选：作为受控子组件透传 host 的 `selectedRepositoryIds`，
 *     改变后调用 `onSelectedRepositoryIdsChange` 同步回 host——保持二者仓库白名单始终一致。
 *  3. 调模型生成 systemPrompt + engineeringGuidelines。
 *
 * 设计要点：
 *  - 仓库状态在 host（AgentDialog.draft.repositoryIds）中，secondary 只负责显示 / 修改，
 *    不再使用本地副本，避免两份数据不一致 / 打开后丢选择的问题。
 *  - 加载态下 hideClose + onOpenChange 拦截关闭，避免误触导致请求被丢掉；
 *  - 错误信息用 AlertCircleIcon 局部展示在底部，不打断用户继续编辑。
 */
export function AgentAIGenerateDialog({
  open,
  onOpenChange,
  model,
  repositories,
  selectedRepositoryIds,
  onSelectedRepositoryIdsChange,
  onGenerated,
  onError
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** 已选模型（与 ChatModelSelector 的 value 一致；未选时按钮在 AgentDialog 已禁用）。 */
  model: string
  repositories: RepositoryProfile[]
  /** 受控：当前仓库选择（以 host 的 draft.repositoryIds 为准）。 */
  selectedRepositoryIds: string[]
  /** 受控：用户在本弹窗调整后同步回 host。 */
  onSelectedRepositoryIdsChange(ids: string[]): void
  onGenerated(result: AgentGenerationResult): void
  onError?(reason: unknown): void
}) {
  // 仅描述、生成态、错误是本弹窗局部状态：仓库选择走 host。
  const [description, setDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  // 重新打开时只重置本弹窗的局部状态（描述 / 错误），仓库选择由 host 提供，无需重置。
  useEffect(() => {
    if (!open) return
    setDescription('')
    setError(undefined)
  }, [open])
  const toggleRepository = (repositoryId: string, checked: boolean) =>
    onSelectedRepositoryIdsChange(
      checked
        ? Array.from(new Set([...selectedRepositoryIds, repositoryId]))
        : selectedRepositoryIds.filter((id) => id !== repositoryId)
    )
  // 加载态锁定关闭：避免用户在请求中误点关闭导致结果丢失。
  const handleOpenChange = (next: boolean) => {
    if (generating && !next) return
    onOpenChange(next)
  }
  const generate = async () => {
    if (!model) {
      setError('暂无可用的模型，请在设置中配置 Qoder 或 OpenAI 后再生成')
      return
    }
    if (!description.trim()) {
      setError('请填写对该 Agent 的说明（领域 / 关注点 / 风格等）')
      return
    }
    setError(undefined)
    setGenerating(true)
    try {
      const input: AgentGenerationInput = {
        model,
        description: description.trim(),
        repositories: selectedRepositoryIds
          .map((id: string) => repositories.find((repository) => repository.id === id))
          .filter((repository: RepositoryProfile | undefined): repository is RepositoryProfile => Boolean(repository))
          .map((repository: RepositoryProfile) => ({
            id: repository.id,
            name: repository.name,
            localPath: repository.localPath,
            ...(repository.defaultBranch ? { defaultBranch: repository.defaultBranch } : {})
          }))
      }
      const result = await api.generateAgentContent(input)
      onGenerated(result)
      onOpenChange(false)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      onError?.(reason)
    } finally {
      setGenerating(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        hideClose={generating}
        onPointerDownOutside={(event) => {
          if (generating) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (generating) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (generating) event.preventDefault()
        }}
        className="grid max-h-[min(520px,calc(100vh-64px))] w-[min(560px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0"
      >
        <DialogHeader className="space-y-1 border-b px-5 pt-3.5 pb-3">
          <DialogTitle className="flex items-center gap-1.5">
            <SparklesIcon size={13} className="text-primary" />
            AI 生成 Agent 内容
          </DialogTitle>
          <DialogDescription>
            用所选模型（未选时由系统自动选择）基于说明 + 勾选仓库的本地背景 （repowiki / agents.md /
            README.md）生成名称、说明、系统提示词与工程约定；生成期间不可关闭。
          </DialogDescription>
        </DialogHeader>
        <div className="thin-scrollbar min-h-0 space-y-3 overflow-y-auto px-5 py-4">
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">
              说明 <span className="text-destructive">*</span>
            </p>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={'例如：负责 Java Spring Boot 服务的实现与测试生成，偏好 MyBatis Plus + Lombok 风格。'}
              rows={4}
              disabled={generating}
              className="text-xs!"
            />
            <p className="text-[11px] leading-5 text-muted-foreground">
              描述这个 Agent 关注什么领域、擅长什么任务、有什么风格偏好，模型会据此生成系统提示词。
            </p>
          </div>
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-medium text-foreground">关注的仓库（可多选）</p>
              <span className="text-[10px] text-muted-foreground">
                {selectedRepositoryIds.length} / {repositories.length} 已选
              </span>
            </div>
            {repositories.length > 0 ? (
              <div className="grid max-h-44 grid-cols-2 gap-1 overflow-y-auto rounded-md border bg-card/40 p-2">
                {repositories.map((repository) => (
                  <label
                    key={repository.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/60"
                  >
                    <Checkbox
                      checked={selectedRepositoryIds.includes(repository.id)}
                      onCheckedChange={(checked) => toggleRepository(repository.id, checked === true)}
                      disabled={generating}
                    />
                    <span className="truncate" title={repository.localPath}>
                      {repository.name}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                暂无可选仓库（可留空，将按通用领域生成）
              </p>
            )}
            <p className="text-[11px] leading-5 text-muted-foreground">
              与宿主弹窗「适用仓库」同步：这里勾选 / 取消会同时更新 Agent 仓库白名单。模型会读取勾选仓库的 repowiki
              文档、agents.md 与 README.md 作为领域上下文；留空时按通用领域生成。
            </p>
          </div>
          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
              <AlertCircleIcon size={12} className="mt-0.5 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}
        </div>
        <DialogFooter className="border-t px-5 py-2.5">
          <DialogClose asChild>
            <Button variant="secondary" size="sm" disabled={generating}>
              取消
            </Button>
          </DialogClose>
          <Button size="sm" disabled={generating || !description.trim()} onClick={() => void generate()}>
            {generating ? <Loader2Icon className="animate-spin-slow" size={11} /> : <SparklesIcon size={11} />}
            {generating ? '生成中…' : '开始生成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
