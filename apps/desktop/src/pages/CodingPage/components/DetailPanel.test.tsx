import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TaskCard } from '@task-pipeline/core'
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
vi.mock('./Timeline', () => ({ Timeline: () => <div>timeline</div> }))
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
  startMode: 'plan',
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
  onMcpServiceChange: vi.fn(),
  onOpenUrl: vi.fn()
}

describe('DetailPanel tabs', () => {
  it('only shows the AI composer while the activity tab is active', async () => {
    const user = userEvent.setup()
    render(
      <DetailPanel
        card={card}
        detail={detail}
        liveEvents={[]}
        prompt=""
        running={false}
        sending={false}
        starting={false}
        merging={false}
        focused={false}
        mcpService={[]}
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
        liveEvents={[]}
        prompt=""
        running={false}
        sending={false}
        starting={false}
        merging={false}
        focused={false}
        mcpService={[]}
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
        liveEvents={[]}
        prompt=""
        running={false}
        sending={false}
        starting={false}
        merging={false}
        focused={false}
        mcpService={[]}
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

describe('isPlanningEvent', () => {
  it('keeps plan lifecycle and revision events out of the execution timeline', () => {
    expect(
      isPlanningEvent({
        id: '1',
        taskId: 'task-1',
        kind: 'status',
        title: '状态更新为 planning',
        createdAt: '2026-08-04T00:00:00.000Z'
      })
    ).toBe(true)
    expect(
      isPlanningEvent({
        id: '2',
        taskId: 'task-1',
        kind: 'message',
        title: '计划调整意见',
        detail: '补充测试',
        createdAt: '2026-08-04T00:01:00.000Z'
      })
    ).toBe(true)
    expect(
      isPlanningEvent({
        id: '3',
        taskId: 'task-1',
        kind: 'status',
        title: '状态更新为 implementing',
        createdAt: '2026-08-04T00:02:00.000Z'
      })
    ).toBe(false)
  })
})
