import { useState } from 'react'
import {
  CheckSquareIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  GitPullRequestArrowIcon,
  Maximize2Icon,
  Minimize2Icon,
  TagIcon,
  XIcon
} from 'lucide-react'
import type { Task, TaskRepository } from '@task-pipeline/core'
import { EditorLauncher } from './EditorLauncher'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * 完整任务详情头。
 *
 * 整块做成"卡片"结构：顶部标题区（来源 + 标题 + 关闭等操作），
 * 下方是描述 / 验收标准 / 关键词 / commit 等内容块。描述与验收标准
 * 使用统一的轻量卡片样式（border-border/40 + bg-muted/20）并支持
 * 独立滚动 + 折叠展开。打开文件夹下拉与 merge-back 共同放在顶部
 * 工具条，工具条按钮全部为 icon-sm 风格。
 */
const DESCRIPTION_COLLAPSE_THRESHOLD = 220
const CRITERIA_COLLAPSE_THRESHOLD = 5

function SourceBadge({ source, taskKey, sourceUrl }: { source: Task['source']; taskKey?: string; sourceUrl?: string }) {
  const label = source === 'jira' ? 'Jira' : '本地'
  if (source === 'jira' && sourceUrl) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border/70 bg-foreground/3 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground transition-colors hover:border-ring hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none"
            onClick={() => {
              api.openExternal(sourceUrl).catch(() => {
                /* 失败由调用方处理 */
              })
            }}
          >
            {label} · {taskKey ?? ''}
            <ExternalLinkIcon size={9} />
          </button>
        </TooltipTrigger>
        <TooltipContent>在 Jira 打开 {taskKey ?? ''}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <span className="inline-flex items-center rounded border border-border/70 bg-foreground/3 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
      {label} · {taskKey ?? 'LOCAL'}
    </span>
  )
}

export function DetailHeader({
  task,
  repositories,
  focused,
  onFocusedChange,
  onClose,
  onOpenVSCode,
  onOpenQoder,
  onRevealWorkspace,
  onMergeBackToBase
}: {
  task: Task
  repositories: TaskRepository[]
  focused: boolean
  onFocusedChange(value: boolean): void
  onClose(): void
  onOpenVSCode(): void
  onOpenQoder(): void
  onRevealWorkspace(): void
  onMergeBackToBase(): void
}) {
  const hasRepositories = repositories.length > 0
  const canMergeBack = hasRepositories && repositories.some((repo) => Boolean(repo.worktreePath && repo.featureBranch))
  // 「合并到 base」按钮的显隐完全由 worktree/feature 分支状态决定。
  const mergeBackTooltip = !hasRepositories
    ? '任务未关联代码仓库'
    : !canMergeBack
      ? '需先完成准备工作生成 worktree 与 feature 分支'
      : '合并 feature 分支到本地 base 分支（不会推送远端）'

  const description = task.description?.trim() ?? ''
  const showSummaryAsDescription = !description && Boolean(task.summary?.trim())
  const fullText = showSummaryAsDescription ? task.summary!.trim() : description
  const isLong = fullText.length > DESCRIPTION_COLLAPSE_THRESHOLD
  const [descExpanded, setDescExpanded] = useState(false)

  const criteria = task.acceptanceCriteria.filter((item) => item.trim())
  const tooManyCriteria = criteria.length > CRITERIA_COLLAPSE_THRESHOLD
  const [criteriaExpanded, setCriteriaExpanded] = useState(false)
  const visibleCriteria =
    tooManyCriteria && !criteriaExpanded ? criteria.slice(0, CRITERIA_COLLAPSE_THRESHOLD) : criteria

  return (
    <div className="relative shrink-0 overflow-hidden border-b bg-linear-to-b from-card/70 via-card/40 to-card/30">
      {/* 顶部工具条：来源 + 启动模式 + 操作按钮 */}
      <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <SourceBadge source={task.source} taskKey={task.taskKey} sourceUrl={task.sourceUrl} />
          {task.startMode === 'direct' && (
            <span className="rounded border border-border/70 bg-foreground/3 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              直接执行
            </span>
          )}
          {task.startMode === 'plan' && (
            <span className="rounded border border-border/70 bg-foreground/3 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              计划模式
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {hasRepositories && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="合并到 base 分支"
                  disabled={!canMergeBack}
                  onClick={onMergeBackToBase}
                >
                  <GitPullRequestArrowIcon size={11} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{mergeBackTooltip}</TooltipContent>
            </Tooltip>
          )}
          {hasRepositories && (
            <EditorLauncher
              repositories={repositories}
              onLaunchVSCode={onOpenVSCode}
              onLaunchQoder={onOpenQoder}
              onRevealWorkspace={onRevealWorkspace}
            />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={focused ? '退出专注模式' : '展开任务详情'}
                className="max-[1199px]:hidden"
                onClick={() => onFocusedChange(!focused)}
              >
                {focused ? <Minimize2Icon size={11} /> : <Maximize2Icon size={11} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{focused ? '退出专注模式' : '展开任务详情'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="关闭详情" onClick={onClose}>
                <XIcon size={11} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>关闭详情</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {/* 标题区 */}
      <div className="px-3.5 pt-2.5 pb-2">
        <h2 className="text-[14px] leading-snug font-semibold tracking-tight">{task.title}</h2>
      </div>
      {/* 描述块 */}
      {fullText && (
        <div className="px-3.5 py-2">
          <div className="group/desc relative overflow-hidden rounded-md border border-border/40 bg-muted/20">
            <div
              data-description-block
              className={cn(
                'thin-scrollbar px-3 py-2 text-xs leading-[1.7] wrap-break-word whitespace-pre-wrap text-foreground/80',
                isLong && !descExpanded && 'mask-fade-bottom-soft max-h-22 overflow-hidden',
                isLong && descExpanded && 'max-h-72 overflow-y-auto'
              )}
            >
              {fullText}
            </div>
            {isLong && (
              <div className="flex justify-end border-t border-border/30 px-2 py-0.5">
                <button
                  type="button"
                  className="inline-flex h-5 items-center gap-0.5 rounded px-1 text-[10px] text-muted-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => setDescExpanded((value) => !value)}
                  aria-label={descExpanded ? '收起描述' : '展开完整描述'}
                  aria-expanded={descExpanded}
                >
                  <ChevronDownIcon
                    size={10}
                    className={cn('transition-transform duration-200', descExpanded && 'rotate-180')}
                  />
                  {descExpanded ? '收起' : '展开'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {/* 验收标准 */}
      {criteria.length > 0 && (
        <div className="px-3.5 pt-1.5">
          <div className="group/cri relative overflow-hidden rounded-md border border-border/40 bg-muted/20">
            <div className="flex items-center justify-between border-b border-border/30 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <CheckSquareIcon size={11} className="text-foreground/50" />
                验收标准
                <span className="rounded-full bg-foreground/5 px-1.5 py-px text-[10px] font-normal text-muted-foreground/70 tabular-nums">
                  {criteria.length}
                </span>
              </span>
              {tooManyCriteria && (
                <button
                  type="button"
                  className="inline-flex h-5 items-center gap-0.5 rounded px-1 text-[10px] text-muted-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => setCriteriaExpanded((value) => !value)}
                  aria-label={
                    criteriaExpanded ? '收起验收标准' : `展开剩余 ${criteria.length - CRITERIA_COLLAPSE_THRESHOLD} 条`
                  }
                  aria-expanded={criteriaExpanded}
                >
                  <ChevronDownIcon
                    size={10}
                    className={cn('transition-transform duration-200', criteriaExpanded && 'rotate-180')}
                  />
                  {criteriaExpanded ? '收起' : `展开 ${criteria.length - CRITERIA_COLLAPSE_THRESHOLD}`}
                </button>
              )}
            </div>
            <ul
              data-criteria-list
              className={cn(
                'thin-scrollbar space-y-0.5 px-3 py-2 text-xs leading-[1.7] text-foreground/80',
                tooManyCriteria && !criteriaExpanded && 'mask-fade-bottom-soft max-h-32 overflow-hidden',
                tooManyCriteria && criteriaExpanded && 'max-h-60 overflow-y-auto'
              )}
            >
              {visibleCriteria.map((item, index) => (
                <li key={`${index}-${item}`} className="flex items-start gap-2">
                  <span className="mt-1.75 inline-block h-1 w-1 shrink-0 rounded-full bg-foreground/35" />
                  <span className="wrap-break-word whitespace-pre-wrap">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {/* 关键词 + commit 行 */}
      {(task.keywords.length > 0 || task.commitMessage?.trim()) && (
        <div className="space-y-1.5 px-3.5 pt-1.5">
          {task.keywords.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <TagIcon size={10} className="text-muted-foreground/80" />
              {task.keywords.map((keyword) => (
                <span
                  key={keyword}
                  className="rounded border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {keyword}
                </span>
              ))}
            </div>
          )}
          {task.commitMessage?.trim() && (
            <div className="rounded border border-dashed border-border/70 bg-muted/15 px-2 py-1.5 text-[11px] leading-5 text-muted-foreground">
              <span className="mr-1 font-medium text-foreground/80">最近 commit：</span>
              <span className="wrap-break-word whitespace-pre-wrap">{task.commitMessage.trim()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
