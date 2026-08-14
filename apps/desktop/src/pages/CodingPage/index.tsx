import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import type { McpServiceId } from '../ChatPage/components/ChatMcpSelector'
import { useFeedback } from '../../hooks/useGlobalFeedback'
import { api, type TaskRemovalMode } from '../../api'
import { BoardPanel } from './components/BoardPanel'
import { useTasks } from './hooks/useTasks'
import { DetailPanel } from './components/DetailPanel'
import { TaskEditorDialog } from './components/TaskEditorDialog'
import { JiraDialog } from './components/JiraDialog'
import { JiraSyncDialog } from './components/JiraSyncDialog'
import { UiRequestDialog } from './components/UiRequestDialog'

export default function CodingPage() {
  const navigate = useNavigate()
  const { taskId } = useParams()
  const { showError, showSuccess } = useFeedback()
  const tasks = useTasks()
  const [editingTask, setEditingTask] = useState<string | 'new'>()
  const [jiraOpen, setJiraOpen] = useState(false)
  const [jiraSyncOpen, setJiraSyncOpen] = useState(false)
  const [merging, setMerging] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const [reimplementing, setReimplementing] = useState(false)
  const [detailFocused, setDetailFocused] = useState(false)
  const [startingTaskId, setStartingTaskId] = useState<string>()
  const [removingTaskIds, setRemovingTaskIds] = useState<Set<string>>(() => new Set())
  /** 任务详情 Composer 选中的 MCP 服务列表（会话内有效，不持久化）。 */
  const [detailMcpService, setDetailMcpService] = useState<McpServiceId[]>([])
  /** 任务详情 Composer 选中的 Skill 名列表（会话内有效，不持久化）。 */
  const [detailSkills, setDetailSkills] = useState<string[]>([])

  // URL ↔ state 同步
  useEffect(() => {
    if (taskId && taskId !== tasks.selectedId) tasks.setSelectedId(taskId)
    if (!taskId && tasks.selectedId) tasks.setSelectedId(undefined)
  }, [taskId, tasks.selectedId, tasks.setSelectedId])

  // 监听全局仓库变更事件
  useEffect(() => {
    const onChanged = () => {
      void tasks.refresh()
      if (tasks.selectedId) void tasks.loadDetail(tasks.selectedId)
    }
    window.addEventListener('app:repositories-changed', onChanged)
    return () => window.removeEventListener('app:repositories-changed', onChanged)
  }, [tasks.refresh, tasks.loadDetail, tasks.selectedId])

  const onOpenTask = useCallback(
    (id: string) => {
      setDetailFocused(false)
      tasks.setSelectedId(id)
      navigate(`/coding/${id}`)
    },
    [navigate, tasks]
  )

  const onCloseDetail = useCallback(() => {
    setDetailFocused(false)
    navigate('/coding')
  }, [navigate])

  const onRemove = useCallback(
    async (id: string, mode: TaskRemovalMode) => {
      setRemovingTaskIds((current) => new Set(current).add(id))
      if (mode === 'all' && tasks.selectedId === id) {
        tasks.setSelectedId(undefined)
        navigate('/coding')
      }
      try {
        await api.deleteTask(id, mode)
        await tasks.refresh()
        if (mode === 'workspace' && tasks.selectedId === id) await tasks.loadDetail(id)
        showSuccess(mode === 'workspace' ? '工作区已清理，任务记录已保留' : '任务已删除')
        return true
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason))
        return false
      } finally {
        setRemovingTaskIds((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
      }
    },
    [navigate, showError, showSuccess, tasks]
  )

  const runAction = useCallback(
    (action: () => Promise<unknown>) => {
      return tasks.run(action).catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)))
    },
    [showError, tasks]
  )

  const editing = editingTask === 'new' ? undefined : tasks.tasks.find((task) => task.id === editingTask)
  const showDetail = Boolean(tasks.selectedId && tasks.detail)

  return (
    <>
      <div
        className={`grid h-full min-h-0 min-w-0 ${showDetail && !detailFocused ? 'grid-cols-[minmax(0,1fr)_clamp(400px,34vw,520px)] max-[1199px]:grid-cols-1' : 'grid-cols-1'}`}
      >
        {(!showDetail || !detailFocused) && (
          <div className={`h-full min-h-0 min-w-0 ${showDetail ? 'max-[1199px]:hidden' : ''}`}>
            <BoardPanel
              tasks={tasks.tasks}
              search={tasks.search}
              onSearch={tasks.setSearch}
              selectedId={tasks.selectedId}
              removingTaskIds={removingTaskIds}
              onOpen={onOpenTask}
              onEdit={(id) => setEditingTask(id)}
              onRemove={onRemove}
              onCreate={() => setEditingTask('new')}
              onFromJira={() => setJiraOpen(true)}
              onSyncJira={() => setJiraSyncOpen(true)}
            />
          </div>
        )}
        {showDetail && (
          <DetailPanel
            card={tasks.tasks.find((t) => t.id === tasks.selectedId)}
            detail={tasks.detail}
            liveEvents={tasks.liveEvents}
            approvals={tasks.approvals}
            onRespondApproval={(id, confirmed) => void tasks.respondApproval(id, confirmed)}
            prompt={tasks.prompt}
            running={tasks.running}
            sending={tasks.sending}
            starting={startingTaskId === tasks.selectedId && !tasks.running}
            merging={merging}
            focused={detailFocused}
            mcpService={detailMcpService}
            onMcpServiceChange={setDetailMcpService}
            skills={detailSkills}
            onSkillsChange={setDetailSkills}
            onFocusedChange={setDetailFocused}
            onClose={onCloseDetail}
            onOpenVSCode={() => {
              if (tasks.selectedId)
                api
                  .openTaskEditor(tasks.selectedId, 'vscode')
                  .catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)))
            }}
            onOpenQoder={() => {
              if (tasks.selectedId)
                api
                  .openTaskEditor(tasks.selectedId, 'qoder')
                  .catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)))
            }}
            onRevealWorkspace={() => {
              if (tasks.selectedId)
                api
                  .revealTaskWorkspace(tasks.selectedId)
                  .catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)))
            }}
            onMergeBackToBase={() => {
              if (!tasks.selectedId) return
              const confirmed = window.confirm(
                '将当前任务的 feature 分支合并到本地 base 分支。\n该操作不会推送到远端，也不会创建 Merge Request。\n\n工作区若有未提交改动会失败并提示。\n\n确定继续吗？'
              )
              if (!confirmed) return
              api
                .mergeBackToBase(tasks.selectedId)
                .catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)))
            }}
            onChangeModel={(value) => {
              if (!tasks.selectedId) return
              api
                .updateTask(tasks.selectedId, { qoderModel: value })
                .then(async () => {
                  await tasks.refresh()
                  if (tasks.selectedId) await tasks.loadDetail(tasks.selectedId)
                })
                .catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)))
            }}
            onStart={() => {
              setStartOpen(true)
            }}
            onAbort={() => runAction(() => api.abortTask())}
            onPause={() => {
              if (tasks.selectedId) runAction(() => api.pauseTask(tasks.selectedId!))
            }}
            onResumePaused={() => {
              if (tasks.selectedId) runAction(() => api.resumePausedTask(tasks.selectedId!))
            }}
            onReview={() => {
              if (tasks.selectedId) runAction(() => api.runReview(tasks.selectedId!))
            }}
            onResetReview={() => {
              if (tasks.selectedId) runAction(() => api.resetReview(tasks.selectedId!))
            }}
            onResetDelivery={() => {
              if (tasks.selectedId) runAction(() => api.resetDelivery(tasks.selectedId!))
            }}
            onRetryValidation={() => {
              if (tasks.selectedId) runAction(() => api.retryTaskValidation(tasks.selectedId!))
            }}
            onApprovePlan={() => {
              if (tasks.selectedId) runAction(() => api.approveTaskPlan(tasks.selectedId!))
            }}
            onRevisePlan={(feedback) => {
              if (tasks.selectedId) runAction(() => api.reviseTaskPlan(tasks.selectedId!, feedback))
            }}
            onPlanEdited={() => {
              if (tasks.selectedId) {
                void tasks.refresh()
                void tasks.loadDetail(tasks.selectedId)
              }
            }}
            onSubmitMR={() => {
              if (!tasks.selectedId) return
              setMerging(true)
              api
                .submitMergeRequests(tasks.selectedId)
                .then(() => {
                  showSuccess('MR 提交完成')
                  return tasks.refresh()
                })
                .then(() => api.refreshMergeStatus())
                .then((summaries) => {
                  for (const summary of summaries) {
                    if (summary.taskId === tasks.selectedId) {
                      for (const repo of summary.repos) {
                        if (repo.state === 'error') showError(`${repo.repoName} 提交失败：${repo.error ?? '未知错误'}`)
                        else if (repo.state === 'merged') showSuccess(`${repo.repoName} 已合并`)
                        else if (repo.state === 'closed') showError(`${repo.repoName} MR 已关闭`)
                      }
                    }
                  }
                })
                .catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)))
                .finally(() => setMerging(false))
            }}
            onManualComplete={() => {
              if (tasks.selectedId) runAction(() => api.manualComplete(tasks.selectedId!))
            }}
            onCancelTask={() => {
              if (tasks.selectedId) runAction(() => api.cancelTask(tasks.selectedId!))
            }}
            onReimplement={() => {
              setReimplementing(true)
              setStartOpen(true)
            }}
            onResume={() => {
              if (tasks.selectedId) runAction(() => api.resumeTask(tasks.selectedId!))
            }}
            onPrompt={tasks.setPrompt}
            onSend={() => tasks.send()}
            onOpenUrl={(url) =>
              api
                .openExternal(url)
                .catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)))
            }
          />
        )}
      </div>
      <TaskEditorDialog
        mode="edit"
        open={Boolean(editingTask)}
        task={editing}
        onOpenChange={(open) => {
          if (!open) setEditingTask(undefined)
        }}
        onSaved={async (saved) => {
          await tasks.refresh()
          await tasks.loadDetail(saved.id)
          if (editingTask === 'new') onOpenTask(saved.id)
        }}
      />
      <JiraDialog open={jiraOpen} onOpenChange={setJiraOpen} onImported={tasks.refresh} />
      <JiraSyncDialog open={jiraSyncOpen} onOpenChange={setJiraSyncOpen} onImported={tasks.refresh} />
      <UiRequestDialog />
      <TaskEditorDialog
        mode="start"
        open={startOpen}
        taskId={tasks.selectedId}
        reimplement={reimplementing}
        onOpenChange={(open) => {
          setStartOpen(open)
          if (!open) setReimplementing(false)
        }}
        onStarting={setStartingTaskId}
        onStarted={async () => {
          setStartingTaskId(undefined)
          setReimplementing(false)
          await tasks.refresh()
          if (tasks.selectedId) await tasks.loadDetail(tasks.selectedId)
        }}
        onSaved={async () => {
          /* start 模式不调用 onSaved */
        }}
      />
    </>
  )
}
