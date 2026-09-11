import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIcon,
  FileDiffIcon,
  FileTextIcon,
  MessageSquareTextIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  SquareTerminalIcon
} from 'lucide-react'
import type { TaskCard, TaskDraftFieldKey, TaskRepository } from '@task-pipeline/core'
import type { DriverPart, TaskDetail, ChangedFile } from '../../../api'
import { ChatMcpSelector, type McpServiceId } from '../../ChatPage/components/ChatMcpSelector'
import { ChatSkillSelector } from '../../ChatPage/components/ChatSkillSelector'
import { useChatModels } from '../../../hooks/useChatModels'
import { inReviewStates } from '../../../utils/status'
import { DetailHeader } from './DetailHeader'
import { UsageSection } from './UsageSection'
import { ChangedFilesSection } from './ChangedFilesSection'
import { MergeRequestsSection } from './MergeRequestsSection'
import { ApprovalsSection } from './ApprovalsSection'
import { DetailActions } from './DetailActions'
import { TaskConversationView } from './TaskConversationView'
import { TaskIntakePanel } from './TaskIntakePanel'
import { draftGaps, DRAFT_GAP_LABELS, intakeMessages, latestDraftSuggestion, type DraftGapKey } from './draftIntake'
import { TaskComposer } from './Composer'
import { PlanSection } from './PlanSection'
import { EditPlanDialog } from './EditPlanDialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToolApprovalCard, AskUserQuestionCard, type ChatApprovalRequest } from '@/components/ToolApprovalCard'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'

const detailTabClass =
  'relative h-full gap-1.5 rounded-none border-0 px-3 text-xs! after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:after:bg-foreground'

/**
 * 缺项提示条点出来的开场白：说的就是屏幕上已经列出来的那几项，
 * 不让用户再打一遍字。发出去后就是一条普通的用户消息，后续怎么追问由用户定。
 */
const intakeOpeningLine = (gaps: DraftGapKey[]): string =>
  `这个任务还缺：${gaps.map((gap) => DRAFT_GAP_LABELS[gap]).join('；')}。请先看下代码现状，给出你的建议。`

type Props = {
  card?: TaskCard
  detail?: TaskDetail
  /** 合并后的 DriverPart[]（历史 events + 流式 live parts），直接喂给 PartRenderer。 */
  parts: DriverPart[]
  /** 当前任务待确认的 HITL 请求（内联卡片，渲染在 activity 执行流底部）。 */
  approvals?: ChatApprovalRequest[]
  onRespondApproval?(id: string, response: { confirmed: boolean } | { value: string | string[] }): void
  prompt: string
  running: boolean
  sending: boolean
  starting: boolean
  merging: boolean
  focused: boolean
  /** 任务详情 Composer 选中的 MCP 服务列表（会话内有效，不持久化）。 */
  mcpService: McpServiceId[]
  onMcpServiceChange(services: McpServiceId[]): void
  /** 任务详情 Composer 选中的 Skill 名列表（会话内有效，不持久化）。 */
  skills: string[]
  onSkillsChange(skills: string[]): void
  onFocusedChange(value: boolean): void
  onClose(): void
  onOpenVSCode(): void
  onOpenQoder(): void
  onRevealWorkspace(): void
  onMergeBackToBase(): void
  onChangeModel(value: string | undefined): void
  onStart(): void
  onAbort(): void
  onPause(): void
  onResumePaused(): void
  onReview(): void
  onResetReview(): void
  onResetDelivery(): void
  onRetryValidation(): void
  onApprovePlan(): void
  onCancelTask(): void
  onRevisePlan(feedback: string): void
  onPlanEdited(): void
  onSubmitMR(): void
  onManualComplete(): void
  onReimplement(): void
  onResume(): void
  onPrompt(value: string): void
  onSend(): void
  /** `draft` 的澄清发送口：走 `sendTaskIntake`，与 `onSend` 的分别只在主进程那边（§2.4 第 4 条）。 */
  onSendIntake(message: string): void
  /** 采纳（带勾选的字段名）/ 丢弃一条建议。 */
  onResolveSuggestion(eventId: string, action: 'apply' | 'discard', keys?: TaskDraftFieldKey[]): void
  onOpenUrl(url: string): void
}

export function DetailPanel({
  card,
  detail,
  parts,
  approvals,
  onRespondApproval,
  prompt,
  running,
  sending,
  starting,
  merging,
  focused,
  mcpService,
  onMcpServiceChange,
  skills,
  onSkillsChange,
  onFocusedChange,
  onClose,
  onOpenVSCode,
  onOpenQoder,
  onRevealWorkspace,
  onMergeBackToBase,
  onChangeModel,
  onStart,
  onAbort,
  onPause,
  onResumePaused,
  onReview,
  onResetReview,
  onResetDelivery,
  onRetryValidation,
  onApprovePlan,
  onCancelTask,
  onRevisePlan,
  onPlanEdited,
  onSubmitMR,
  onManualComplete,
  onReimplement,
  onResume,
  onPrompt,
  onSend,
  onSendIntake,
  onResolveSuggestion,
  onOpenUrl
}: Props) {
  const task = detail?.task
  // const repositories = detail?.repositories ?? card?.repositories ?? []
  const [activeTab, setActiveTab] = useState('activity')
  const [planFeedback, setPlanFeedback] = useState('')
  const [planEditOpen, setPlanEditOpen] = useState(false)
  const { modelGroups: allModelGroups } = useChatModels()
  // 选择器解析出的模型与 task 不一致时（task 无模型 / 模型失效），自动回写一次到后端。
  // 用 ref 防止重复触发：同一个 task 只自动持久化一次，后续用户手动变更走 onChangeModel。
  const resolvedPersistedRef = useRef<string | undefined>(undefined)
  const handleResolveModel = useCallback(
    (resolved: string) => {
      if (!task?.id || resolvedPersistedRef.current === task.id) return
      resolvedPersistedRef.current = task.id
      onChangeModel(resolved)
    },
    [task?.id, onChangeModel]
  )
  // 切换任务时重置，使新任务也能触发一次自动持久化
  useEffect(() => {
    resolvedPersistedRef.current = undefined
  }, [task?.id])
  const groups = useMemo(() => {
    const byRepo = new Map<string, { repositoryId: string; repositoryName: string; files: ChangedFile[] }>()
    for (const file of detail?.changedFiles ?? []) {
      const key = file.repositoryId
      const current = byRepo.get(key) ?? { repositoryId: key, repositoryName: file.repositoryName, files: [] }
      current.files.push(file)
      byRepo.set(key, current)
    }
    return [...byRepo.values()]
  }, [detail?.changedFiles])
  const taskId = task?.id
  const taskState = task?.state
  const taskPlanRevision = task?.planRevision
  const hasPlan = Boolean(
    task?.planContent || (taskState && ['planning', 'awaiting_plan_approval'].includes(taskState))
  )
  // PlanSection 数据源:只取历史 events（计划反馈不会出现在 live 流中）。
  const planEvents = detail?.events ?? []
  // 澄清记录只存在于 `events` 表（上面那份 `events` 是从 trace span 合成的，`draft` 还没跑过任何阶段）。
  const draftEvents = task?.state === 'draft' ? detail?.draftEvents : undefined
  const intakeRecords = useMemo(() => intakeMessages(draftEvents ?? []), [draftEvents])
  const pendingSuggestion = useMemo(() => latestDraftSuggestion(draftEvents ?? []), [draftEvents])
  const intakeGaps = useMemo(
    () =>
      task && task.state === 'draft' ? draftGaps(task, (detail?.repositories ?? card?.repositories ?? []).length) : [],
    [task, detail?.repositories, card?.repositories]
  )
  useEffect(() => {
    setActiveTab(hasPlan ? 'plan' : 'activity')
  }, [taskId, hasPlan])
  useEffect(() => {
    if (taskState === 'awaiting_plan_approval') setActiveTab('plan')
  }, [taskState, taskPlanRevision])
  useEffect(() => {
    setPlanFeedback('')
  }, [taskId, taskPlanRevision])
  if (!task || !card) return null
  const totalFiles = detail?.changedFiles.length ?? 0
  const mergeRequestCount = detail?.repositories.filter((repo) => repo.mergeRequestUrl).length ?? 0
  const isDraft = task.state === 'draft'
  const canChat =
    isDraft ||
    ['implementing', 'awaiting_input'].includes(task.state) ||
    inReviewStates.has(task.state) ||
    ['failed', 'validation_failed'].includes(task.state) ||
    running
  const showChangedFiles =
    totalFiles > 0 ||
    inReviewStates.has(task.state) ||
    ['awaiting_input', 'completed', 'failed', 'validation_failed', 'cancelled'].includes(task.state)
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l bg-card/50 max-[1199px]:border-l-0">
      <DetailHeader
        task={task}
        repositories={(detail?.repositories ?? []) as TaskRepository[]}
        focused={focused}
        onFocusedChange={onFocusedChange}
        onClose={onClose}
        onOpenVSCode={onOpenVSCode}
        onOpenQoder={onOpenQoder}
        onRevealWorkspace={onRevealWorkspace}
        onMergeBackToBase={onMergeBackToBase}
      />
      <DetailActions
        card={card}
        running={running}
        starting={starting}
        canSubmit={card.repositories.length > 0}
        merging={merging}
        onStart={onStart}
        onAbort={onAbort}
        onPause={onPause}
        onResumePaused={onResumePaused}
        onReview={onReview}
        onResetReview={onResetReview}
        onResetDelivery={onResetDelivery}
        onRetryValidation={onRetryValidation}
        onSubmitMR={onSubmitMR}
        onManualComplete={onManualComplete}
        onReimplement={onReimplement}
        onResume={onResume}
      />
      <UsageSection
        task={task}
        card={card}
        model={task?.qoderModel}
        onChangeModel={onChangeModel}
        onResolveModel={handleResolveModel}
        modelGroups={allModelGroups}
        running={running || starting}
      />
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="h-9 w-full shrink-0 justify-start gap-0 rounded-none bg-transparent px-3 py-0">
          {hasPlan && (
            <TabsTrigger value="plan" data-detail-tab className={detailTabClass}>
              <FileTextIcon size={12} />
              计划
            </TabsTrigger>
          )}
          <TabsTrigger value="activity" data-detail-tab className={detailTabClass}>
            <ActivityIcon size={12} />
            执行
          </TabsTrigger>
          <TabsTrigger value="files" data-detail-tab className={detailTabClass}>
            <FileDiffIcon size={12} />
            文件
            {totalFiles > 0 && (
              <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px]">
                {totalFiles}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="delivery" data-detail-tab className={detailTabClass}>
            <SquareTerminalIcon size={12} />
            交付
            {mergeRequestCount > 0 && (
              <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px]">
                {mergeRequestCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        {hasPlan && (
          <TabsContent value="plan" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
            <PlanSection task={task} compact={!focused} events={planEvents} />
          </TabsContent>
        )}
        <TabsContent value="activity" className="thin-scrollbar mt-0 min-h-0 flex-1 overflow-y-auto">
          {isDraft ? (
            <TaskIntakePanel
              messages={intakeRecords}
              suggestion={pendingSuggestion}
              busy={sending}
              onApply={(eventId, keys) => onResolveSuggestion(eventId, 'apply', keys)}
              onDiscard={(eventId) => onResolveSuggestion(eventId, 'discard')}
            />
          ) : (
            <TaskConversationView parts={parts} live={running} />
          )}
        </TabsContent>
        <TabsContent value="files" className="thin-scrollbar mt-0 min-h-0 flex-1 overflow-y-auto">
          {showChangedFiles ? (
            <ChangedFilesSection groups={groups} total={totalFiles} />
          ) : (
            <div className="grid min-h-48 place-items-center text-xs text-muted-foreground">
              任务产生文件变化后将在这里显示
            </div>
          )}
        </TabsContent>
        <TabsContent value="delivery" className="thin-scrollbar mt-0 min-h-0 flex-1 overflow-y-auto">
          <ApprovalsSection approvals={detail?.approvals ?? []} />
          {mergeRequestCount > 0 ? (
            <MergeRequestsSection repos={detail?.repositories ?? []} onOpen={onOpenUrl} />
          ) : (
            <div className="grid min-h-48 place-items-center text-xs text-muted-foreground">
              提交 Merge Request 后将在这里显示
            </div>
          )}
        </TabsContent>
      </Tabs>
      {/* 工具调用 HITL 内联确认卡片：渲染在面板底部、所有 Tab 可见（任务运行中触发，归属当前任务）。
      固定不随消息滚动，避免停在 plan/files 等 Tab 时确认不可见导致任务挂起。 */}
      {approvals?.length ? (
        <div className="shrink-0 space-y-2 border-t bg-background/95 px-3 py-2.5">
          {approvals.map((approval) =>
            approval.method === 'ask-user' ? (
              <AskUserQuestionCard
                key={approval.id}
                approval={approval}
                onRespond={(value) => onRespondApproval?.(approval.id, { value })}
              />
            ) : (
              <ToolApprovalCard
                key={approval.id}
                approval={approval}
                onRespond={(confirmed) => onRespondApproval?.(approval.id, { confirmed })}
              />
            )
          )}
        </div>
      ) : null}
      {task.state === 'awaiting_plan_approval' && activeTab === 'plan' && (
        <div className="shrink-0 border-t bg-background/95 px-3 pt-1.5 pb-2">
          <div className="mx-auto w-full max-w-4xl">
            <TaskComposer
              value={planFeedback}
              onChange={setPlanFeedback}
              onSend={(value) => {
                const feedback = value.trim()
                if (!feedback || running) return
                setPlanFeedback('')
                onRevisePlan(feedback)
              }}
              disabled={running}
              placeholder="输入计划调整意见，Enter 重新生成，Shift+Enter 换行"
              leftSlot={
                <span className="inline-flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
                  <MessageSquareTextIcon size={11} />
                  计划反馈
                </span>
              }
              rightSlot={
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={running || !planFeedback.trim()}
                    onClick={() => {
                      const feedback = planFeedback.trim()
                      if (!feedback) return
                      setPlanFeedback('')
                      onRevisePlan(feedback)
                    }}
                  >
                    <RotateCcwIcon size={11} />
                    重新生成
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="gap-1 px-2"
                    disabled={running}
                    onClick={() => setPlanEditOpen(true)}
                  >
                    <PencilIcon size={11} />
                    编辑计划
                  </Button>
                  <Button type="button" size="sm" disabled={running} onClick={onApprovePlan}>
                    <PlayIcon size={11} />
                    批准并开始
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" size="sm" variant="destructive" className="gap-1 px-2" disabled={running}>
                        <SquareIcon size={11} />
                        结束任务
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>确认结束任务？</AlertDialogTitle>
                        <AlertDialogDescription>
                          任务将被取消并关闭，已生成的计划与改动会保留在任务记录中。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction
                          className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
                          onClick={onCancelTask}
                        >
                          确认结束
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              }
            />
          </div>
        </div>
      )}
      <EditPlanDialog
        open={planEditOpen}
        taskId={task.id}
        initialContent={task.planContent ?? ''}
        onOpenChange={setPlanEditOpen}
        onSaved={onPlanEdited}
      />
      {canChat && activeTab === 'activity' && (
        <div className="shrink-0 border-t bg-background/95 px-3 pt-1.5 pb-2">
          {/* 缺项提示条：命中才亮，而且不自动发言（§2.4 第 5 条）。有待采纳建议时收起来：
              那句「可以让 Agent 补」已经被回答了一次，再亮就是噪音。 */}
          {isDraft && intakeGaps.length > 0 && !pendingSuggestion ? (
            <div className="mb-1.5 flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {intakeGaps.map((gap) => DRAFT_GAP_LABELS[gap]).join(' · ')}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={sending}
                onClick={() => onSendIntake(intakeOpeningLine(intakeGaps))}
              >
                让 Agent 补全
              </Button>
            </div>
          ) : null}
          <TaskComposer
            value={prompt}
            onChange={onPrompt}
            onSend={isDraft ? (value: string) => onSendIntake(value) : onSend}
            onStop={isDraft ? undefined : onAbort}
            streaming={running}
            submitting={sending}
            // 澄清阶段不接流式通道，那条 IPC 挂到整轮跑完才回：`sending` 就是它的 busy。
            placeholder={isDraft ? (sending ? '澄清助手正在思考…' : '让 Agent 帮你补全任务定义') : undefined}
            // 澄清会话的工具面是固定的（只读查询 + 提建议），挂 MCP / Skill 选择器就是让人选一个不会生效的东西。
            showHitlMode={!isDraft}
            disabled={
              sending ||
              running ||
              starting ||
              (!running &&
                task.state !== 'failed' &&
                task.state !== 'validation_failed' &&
                task.state !== 'implementing' &&
                task.state !== 'awaiting_input' &&
                task.state !== 'draft' &&
                !inReviewStates.has(task.state))
            }
            hitlContextType="task"
            hitlContextId={task.id}
            leftSlot={
              isDraft ? undefined : (
                <>
                  <ChatMcpSelector selected={mcpService} onChange={onMcpServiceChange} disabled={running || sending} />
                  <ChatSkillSelector selected={skills} onChange={onSkillsChange} disabled={running || sending} />
                </>
              )
            }
          />
        </div>
      )}
    </section>
  )
}
