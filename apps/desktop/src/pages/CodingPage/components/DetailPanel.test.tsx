import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, TaskCard } from '@task-pipeline/core'
import { DetailPanel } from './DetailPanel'
import { isPlanningEvent } from './planningEvent'
import type { TaskDetail } from '@/api'

vi.mock('@/hooks/useChatModels', () => ({
  useChatModels: () => ({ modelGroups: [], loading: false, refresh: vi.fn() })
}))

vi.mock('./DetailHeader', () => ({ DetailHeader: () => null }))
vi.mock('./DetailActions', () => ({ DetailActions: () => null }))
vi.mock('./UsageSection', () => ({ UsageSection: () => <div>usage</div> }))
vi.mock('./ChangedFilesSection', () => ({ ChangedFilesSection: () => <div>files</div> }))
vi.mock('./MergeRequestsSection', () => ({ MergeRequestsSection: () => <div>delivery</div> }))
vi.mock('./TaskConversationView', () => ({ TaskConversationView: () => <div>conversation</div> }))
vi.mock('./PlanSection', () => ({ PlanSection: () => <div>plan content</div> }))
vi.mock('./Composer', () => ({
  TaskComposer: ({
    value,
    onChange,
    onSend,
    placeholder,
    rightSlot
  }: {
    value: string
    onChange(value: string): void
    onSend(value: string): void
    placeholder?: string
    rightSlot?: React.ReactNode
  }) => (
    <div>
      <span>AI 对话框</span>
      <input aria-label={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
      <button type="button" onClick={() => onSend(value)}>
        发送
      </button>
      {rightSlot}
    </div>
  )
}))

const card: TaskCard = {
  id: 'task-1',
  source: 'local',
  title: 'Task with plan',
  description: 'test',
  keywords: [],
  acceptanceCriteria: [],
  state: 'implementing',
  planContent: 'Implementation plan',
  planRevision: 1,
  reviewStatus: 'pending',
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
  boardColumn: 'in_progress',
  repositories: []
}

const detail: TaskDetail = {
  task: card,
  repositories: [],
  events: [],
  openAiEvents: [],
  approvals: [],
  changedFiles: []
}

const callbacks = {
  onFocusedChange: vi.fn(),
  onClose: vi.fn(),
  onOpenVSCode: vi.fn(),
  onOpenQoder: vi.fn(),
  onRevealWorkspace: vi.fn(),
  onMergeBackToBase: vi.fn(),
  onChangeModel: vi.fn(),
  onStart: vi.fn(),
  onAbort: vi.fn(),
  onPause: vi.fn(),
  onResumePaused: vi.fn(),
  onReview: vi.fn(),
  onResetReview: vi.fn(),
  onResetDelivery: vi.fn(),
  onRetryValidation: vi.fn(),
  onApprovePlan: vi.fn(),
  onCancelTask: vi.fn(),
  onRevisePlan: vi.fn(),
  onPlanEdited: vi.fn(),
  onSubmitMR: vi.fn(),
  onManualComplete: vi.fn(),
  onReimplement: vi.fn(),
  onResume: vi.fn(),
  onPrompt: vi.fn(),
  onSend: vi.fn(),
  onSendIntake: vi.fn(),
  onResolveSuggestion: vi.fn(),
  onMcpServiceChange: vi.fn(),
  onSkillsChange: vi.fn(),
  onOpenUrl: vi.fn()
}

describe('DetailPanel tabs', () => {
  it('only shows the AI composer while the activity tab is active', async () => {
    const user = userEvent.setup()
    render(
      <DetailPanel
        card={card}
        detail={detail}
        parts={[]}
        prompt=""
        running={false}
        sending={false}
        starting={false}
        merging={false}
        focused={false}
        mcpService={[]}
        skills={[]}
        {...callbacks}
      />
    )

    const planTab = screen.getByRole('tab', { name: '计划' })
    await waitFor(() => expect(planTab).toHaveAttribute('data-state', 'active'))
    expect(screen.queryByText('AI 对话框')).not.toBeInTheDocument()

    const activityTab = screen.getByRole('tab', { name: '执行' })
    await user.click(activityTab)
    expect(activityTab).toHaveAttribute('data-state', 'active')
    expect(planTab).toHaveAttribute('data-state', 'inactive')
    expect(screen.getByText('AI 对话框')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '文件' }))
    expect(screen.queryByText('AI 对话框')).not.toBeInTheDocument()
  })

  it('shows detected files while a conflicting plan waits for approval', async () => {
    const user = userEvent.setup()
    const waitingCard: TaskCard = { ...card, state: 'awaiting_plan_approval' }
    render(
      <DetailPanel
        card={waitingCard}
        detail={{
          ...detail,
          task: waitingCard,
          changedFiles: [{ repositoryId: 'repo-1', repositoryName: 'repo', path: 'src/index.ts', status: 'M' }]
        }}
        parts={[]}
        prompt=""
        running={false}
        sending={false}
        starting={false}
        merging={false}
        focused={false}
        mcpService={[]}
        skills={[]}
        {...callbacks}
      />
    )

    await user.click(screen.getByRole('tab', { name: '文件 1' }))
    expect(screen.getByText('files')).toBeInTheDocument()
  })

  it('keeps plan feedback and approval actions fixed below the plan', async () => {
    const user = userEvent.setup()
    const onApprovePlan = vi.fn()
    const onRevisePlan = vi.fn()
    const waitingCard: TaskCard = { ...card, state: 'awaiting_plan_approval' }
    render(
      <DetailPanel
        card={waitingCard}
        detail={{ ...detail, task: waitingCard }}
        parts={[]}
        prompt=""
        running={false}
        sending={false}
        starting={false}
        merging={false}
        focused={false}
        mcpService={[]}
        skills={[]}
        {...callbacks}
        onApprovePlan={onApprovePlan}
        onRevisePlan={onRevisePlan}
      />
    )

    expect(screen.getByText('AI 对话框')).toBeInTheDocument()
    const feedback = screen.getByRole('textbox', { name: '输入计划调整意见，Enter 重新生成，Shift+Enter 换行' })
    await user.type(feedback, 'Add tests')
    await user.click(screen.getByRole('button', { name: '重新生成' }))
    expect(onRevisePlan).toHaveBeenCalledWith('Add tests')
    expect(feedback).toHaveValue('')

    await user.click(screen.getByRole('button', { name: '批准并开始' }))
    expect(onApprovePlan).toHaveBeenCalledOnce()
  })
})

describe('DetailPanel draft intake', () => {
  const draftCard: TaskCard = {
    ...card,
    state: 'draft',
    description: '',
    acceptanceCriteria: [],
    planContent: undefined,
    planRevision: undefined
  }

  const draftEvent = (id: string, payload: unknown): AgentEvent =>
    ({
      id,
      taskId: 'task-1',
      kind: 'status',
      title: '',
      detail: '',
      createdAt: '2026-09-10T00:00:00.000Z',
      payload
    }) as AgentEvent

  function renderDraft(draftEvents: AgentEvent[] = [], sending = false) {
    render(
      <DetailPanel
        card={draftCard}
        detail={{ ...detail, task: draftCard, draftEvents }}
        parts={[]}
        prompt=""
        running={false}
        sending={sending}
        starting={false}
        merging={false}
        focused={false}
        mcpService={[]}
        skills={[]}
        {...callbacks}
      />
    )
  }

  it('shows the intake log instead of the execution stream, and sends through intake', async () => {
    const user = userEvent.setup()
    vi.clearAllMocks()
    renderDraft()

    expect(screen.getByText('还没有澄清记录')).toBeInTheDocument()
    expect(screen.queryByText('conversation')).not.toBeInTheDocument()

    // 输入框是受控的，这个 mock 不持草稿：能验的是「发送走哪条通道」，文本本身归 sendIntake 管。
    expect(screen.getByRole('textbox', { name: '让 Agent 帮你补全任务定义' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(callbacks.onSendIntake).toHaveBeenCalledOnce()
    expect(callbacks.onSend).not.toHaveBeenCalled()
  })

  it('names the missing fields in the hint so the user does not have to type them', async () => {
    const user = userEvent.setup()
    vi.clearAllMocks()
    renderDraft()

    await user.click(screen.getByRole('button', { name: '让 Agent 补全' }))
    expect(callbacks.onSendIntake).toHaveBeenCalledWith(
      '这个任务还缺：描述还没讲清背景与期望；还没有可判定的验收标准；还没关联仓库。请先看下代码现状，给出你的建议。'
    )
  })

  it('puts the suggestion card in place of the hint, and writes back only the checked fields', async () => {
    const user = userEvent.setup()
    vi.clearAllMocks()
    renderDraft([draftEvent('evt-1', { type: 'draft-suggestion', fields: { title: '新标题', description: '新描述' } })])

    expect(screen.queryByRole('button', { name: '让 Agent 补全' })).not.toBeInTheDocument()
    // 默认全勾；取消描述那一勾就是告诉主进程「这项我自己填」。
    await user.click(screen.getByRole('checkbox', { name: '采纳描述' }))
    await user.click(screen.getByRole('button', { name: '采纳勾选项' }))
    expect(callbacks.onResolveSuggestion).toHaveBeenCalledWith('evt-1', 'apply', ['title'])

    await user.click(screen.getByRole('button', { name: '全部忽略' }))
    expect(callbacks.onResolveSuggestion).toHaveBeenLastCalledWith('evt-1', 'discard')
  })

  it('keeps the suggestion read-only while a clarification turn is in flight', () => {
    vi.clearAllMocks()
    renderDraft([draftEvent('evt-1', { type: 'draft-suggestion', fields: { title: '新标题' } })], true)

    expect(screen.getByRole('button', { name: '采纳勾选项' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: '采纳标题' })).toBeDisabled()
    expect(screen.getByText('澄清助手正在思考…')).toBeInTheDocument()
  })
})

describe('isPlanningEvent', () => {
  it('keeps plan lifecycle and revision events out of the execution timeline', () => {
    expect(isPlanningEvent({ title: '状态更新为 planning' })).toBe(true)
    expect(isPlanningEvent({ title: '计划调整意见' })).toBe(true)
    expect(isPlanningEvent({ title: '状态更新为 implementing' })).toBe(false)
  })
})
