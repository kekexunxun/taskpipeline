import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { LoaderIcon } from 'lucide-react'
import { ChatHistoryList } from './components/ChatHistoryList'
import { ChatConversation } from './components/ChatConversation'
import { ChatComposer } from './components/ChatComposer'
import { ChatModelSelector } from './components/ChatModelSelector'
import { ChatMcpSelector } from './components/ChatMcpSelector'
import { ChatSkillSelector } from './components/ChatSkillSelector'
import { ChatAgentSelector } from './components/ChatAgentSelector'
import { ChatWelcomeView } from './components/ChatWelcomeView'
import { WorkspaceCreateDialog } from './components/WorkspaceCreateDialog'
import { TaskCreationTool } from './components/TaskCreationTool'
import { ChatModeToggle } from './components/ChatModeToggle'
import type { ChatApprovalRequest } from './hooks/useChat'
import { useChat } from './hooks/useChat'
import { UiRequestDialog } from '@/pages/CodingPage/components/UiRequestDialog'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { api } from '@/api'
import { useFeedback } from '@/hooks/useGlobalFeedback'
import type { ChatPlan, UserFileAttachment } from '@/api'

export default function ChatPage() {
  return (
    <ErrorBoundary scope="对话面板加载失败">
      <ChatPageInner />
    </ErrorBoundary>
  )
}

function ChatPageInner() {
  const { conversationId } = useParams()
  const navigate = useNavigate()
  const { showError } = useFeedback()
  const chat = useChat()
  const { pushApproval } = chat

  // 欢迎页项目目录选择
  const [welcomeDirectory, setWelcomeDirectory] = useState<string | undefined>()
  // 欢迎页正在执行创建+发送流程（保持欢迎页显示直到导航完成）
  const [isTransitioning, setIsTransitioning] = useState(false)
  // 欢迎页的输入草稿（独立于 chat.draft，因为欢迎页没有 activeId）
  const [welcomeDraft, setWelcomeDraft] = useState('')
  // 工作区创建弹窗
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)

  // 执行计划回调：切换 chatMode 为 normal 并发送执行指令
  const handleExecutePlan = useCallback(
    (plan: ChatPlan) => {
      // 切换到 normal 模式，然后发送执行指令
      if (chat.activeId) {
        chat.setChatMode(chat.activeId, 'normal')
      }
      const executeMessage = `请按照计划文件执行：\`${plan.filePath}\`\n\n请先读取该文件，然后按照计划逐步执行。`
      void chat.send(executeMessage)
    },
    [chat]
  )

  // 工具调用 HITL：Qoder 等 driver 的 can_use_tool 确认请求由主进程以
  // extension_ui_request 广播（task:event 通道）。
  // - confirm：内联到对话流（ChatToolApprovalCard），按 conversationId 归属，并行对话各自展示；
  // - ask-user：AskUserQuestion 内联卡片（选项按钮），同样走 pushApproval 内联路径；
  // - select/input/editor：对话板块不会产生，保留 UiRequestDialog 作为兜底。
  useEffect(() => {
    const off = api.onTaskEvent(
      (event: { type?: string; method?: string; conversationId?: string } & ChatApprovalRequest) => {
        if (event?.type !== 'extension_ui_request') return
        if (event.method === 'confirm' || event.method === 'ask-user') {
          pushApproval(event.conversationId, event)
        } else if (['select', 'input', 'editor'].includes(event.method ?? '')) {
          window.dispatchEvent(new CustomEvent('task:ui-request', { detail: event }))
        }
      }
    )
    return off
  }, [pushApproval])

  // URL ↔ state 同步
  useEffect(() => {
    if (conversationId && conversationId !== chat.activeId) {
      void chat.select(conversationId)
    } else if (!conversationId && chat.activeId) {
      // 离开 /chat/:id 时清理当前对话
      void chat.select(undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  // 欢迎页：仅选择目录（不创建对话），用于添加到 welcomeDirectory
  const chooseProjectDirectory = async () => {
    try {
      const dir = await api.chooseDirectory()
      if (dir) {
        setWelcomeDirectory(dir)
      }
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const handleSend = async (value: string, files?: UserFileAttachment[]) => {
    // 对话进行中，将消息加入待发送队列（本轮结束后自动发送）
    if (chat.streaming && chat.activeId) {
      chat.enqueuePending(chat.activeId, value, files)
      return
    }
    const wasEmpty = !chat.activeId
    const newId = await chat.send(value, files)
    if (newId && wasEmpty) navigate(`/chat/${newId}`)
  }

  /** 将 pending 消息的文本作为对话引导注入当前轮次 */
  const handleGuidance = async (text: string) => {
    if (!chat.activeId) return
    try {
      await api.injectChatGuidance(chat.activeId, text)
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  // 欢迎页发送：若选择了项目目录，先创建带目录的对话再发送
  const welcomeHandleSend = async (value: string, files?: UserFileAttachment[]) => {
    setWelcomeDraft('') // 清空欢迎页草稿
    if (welcomeDirectory) {
      setIsTransitioning(true)
      try {
        // 1. 创建带目录的对话（会设置 activeId）
        const id = await chat.create(welcomeDirectory)
        if (id) {
          // 2. 发送消息（使用刚创建的对话）
          await chat.send(value, files)
          // 3. 导航到对话页面
          navigate(`/chat/${id}`)
        }
      } finally {
        setIsTransitioning(false)
      }
    } else {
      await handleSend(value)
    }
  }

  const hasModel = chat.modelGroups.some((group) => group.models.length)
  // 欢迎页显示条件：没有活跃对话，或者正在从欢迎页过渡
  const isEmpty = !chat.activeId || isTransitioning
  const headerSubtitle = isEmpty
    ? '输入消息即可自动创建新对话'
    : `${chat.messages.length} 条消息 · ${hasModel ? `${chat.modelGroups.length} 个 Provider` : '未配置模型'}`

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[288px_minmax(0,1fr)] bg-background">
      <ChatHistoryList
        metas={chat.metas}
        groups={chat.groups}
        activeId={chat.activeId}
        streamingChatIds={chat.streamingChatIds}
        onSelect={(id) => navigate(`/chat/${id}`)}
        onCreate={() =>
          void (async () => {
            const id = await chat.create()
            if (id) navigate(`/chat/${id}`)
          })()
        }
        onCreateInDirectory={(directory) =>
          void (async () => {
            const id = await chat.create(directory)
            if (id) navigate(`/chat/${id}`)
          })()
        }
        onShowWelcome={() => {
          // 已经在欢迎页则不重复跳转
          if (chat.activeId) {
            chat.select(undefined)
            navigate('/chat')
          }
        }}
        onDelete={(id) => void chat.remove(id)}
        onDeleteGroup={(id) => void chat.removeGroup(id)}
      />
      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {isEmpty ? (
          <ChatWelcomeView
            composerValue={welcomeDraft}
            onComposerChange={setWelcomeDraft}
            onSend={(value) => void welcomeHandleSend(value)}
            onStop={() => void chat.stop()}
            disabled={!hasModel}
            streaming={chat.streaming}
            groups={chat.groups}
            projectValue={welcomeDirectory}
            onProjectChange={setWelcomeDirectory}
            onAddProject={() => void chooseProjectDirectory()}
            onSetupWorkspace={() => setWorkspaceDialogOpen(true)}
            leftSlot={
              <>
                <ChatModelSelector
                  groups={chat.modelGroups}
                  value={chat.model}
                  onChange={chat.setModelAndDriver}
                  modelParams={chat.modelParams}
                  onChangeParams={chat.setModelParams}
                  disabled={chat.streaming}
                />
                <ChatMcpSelector selected={chat.mcpService} onChange={chat.setMcpService} disabled={chat.streaming} />
                <ChatSkillSelector selected={chat.skills} onChange={chat.setSkills} disabled={chat.streaming} />
                <ChatAgentSelector selected={chat.agentId} onChange={chat.setAgentId} disabled={chat.streaming} />
                <ChatModeToggle
                  mode={chat.chatMode}
                  disabled={chat.streaming}
                  onChange={(mode) => chat.setChatMode(chat.activeId, mode)}
                />
                <TaskCreationTool
                  selected={chat.taskCreationEnabled}
                  disabled={chat.streaming}
                  onChange={chat.setTaskCreationEnabled}
                  backendLabel={chat.taskBackend?.displayName}
                />
              </>
            }
          />
        ) : (
          <>
            <header className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3">
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold tracking-tight">
                  {chat.conversation?.title ?? '新建对话'}
                </h1>
                <p className="mt-1 truncate text-xs text-muted-foreground">{headerSubtitle}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {chat.streaming && (
                  <span className="inline-flex items-center gap-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">
                    <span className="animate-caret-blink inline-block size-1.5 rounded-full bg-current" />
                    生成中
                  </span>
                )}
              </div>
            </header>

            <ChatConversation
              messages={chat.messages}
              streaming={chat.streaming}
              hint={chat.hint}
              approvals={chat.approvals}
              answered={chat.answered}
              onRespondApproval={(id, response) => void chat.respondApproval(id, response)}
              onExecuteJira={async (taskKey) => {
                try {
                  const task = await api.importJiraTask(taskKey)
                  navigate(`/coding/${task.id}`)
                } catch (reason) {
                  showError(reason instanceof Error ? reason.message : String(reason))
                  throw reason
                }
              }}
              onExecutePlan={handleExecutePlan}
            />

            <div className="shrink-0 border-t bg-background/95 px-4 pt-2 pb-2.5">
              {chat.pendingMessages.length > 0 && chat.activeId && (
                <div className="mb-2 space-y-1.5">
                  {chat.pendingMessages.length > 1 && (
                    <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                      <svg
                        className="size-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      <span>{chat.pendingMessages.length} 条消息将在当前对话结束后依次发送</span>
                    </div>
                  )}
                  {chat.pendingMessages.map((msg, index) => (
                    <div
                      key={msg.id}
                      className="group flex items-center gap-2 rounded-md border border-dashed border-border/60 bg-muted/30 px-2.5 py-1.5"
                    >
                      {chat.pendingMessages.length > 1 && (
                        <span className="shrink-0 text-[10px] text-muted-foreground/60">{index + 1}</span>
                      )}
                      {/* 旋转 loader 图标 */}
                      <LoaderIcon className="size-3 shrink-0 animate-spin text-primary/60" />
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{msg.text}</span>
                      {/* 附件指示器 */}
                      {msg.files && msg.files.length > 0 && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          📎 {msg.files.length}
                        </span>
                      )}
                      {/* 引导按钮 */}
                      <button
                        type="button"
                        onClick={() => void handleGuidance(msg.text)}
                        className="shrink-0 rounded px-1 py-0.5 text-[9px] text-primary/60 hover:bg-primary/10 hover:text-primary"
                        title="对话引导"
                      >
                        引导
                      </button>
                      <button
                        type="button"
                        onClick={() => chat.activeId && chat.removePendingMessage(chat.activeId, msg.id)}
                        className="shrink-0 rounded p-0.5 text-muted-foreground/40 hover:bg-destructive/10 hover:text-destructive"
                        title="删除"
                      >
                        <svg
                          className="size-3"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <ChatComposer
                value={chat.draft}
                onChange={chat.setDraft}
                onSend={handleSend}
                onStop={() => void chat.stop()}
                disabled={!hasModel}
                placeholder={
                  !hasModel
                    ? '请先在设置中配置可用模型'
                    : chat.streaming
                      ? chat.pendingMessages.length > 0
                        ? '继续输入，排队等待发送'
                        : '输入消息，将在当前对话结束后自动发送'
                      : chat.taskCreationEnabled
                        ? '描述准备创建的 Jira 任务，Agent 会补齐必要信息'
                        : undefined
                }
                streaming={chat.streaming}
                hitlContextType="conversation"
                hitlContextId={chat.activeId}
                modelSupportsVision={chat.modelSupportsVision}
                chatId={chat.activeId}
                leftSlot={
                  <>
                    <ChatModelSelector
                      groups={chat.modelGroups}
                      value={chat.model}
                      onChange={chat.setModelAndDriver}
                      modelParams={chat.modelParams}
                      onChangeParams={chat.setModelParams}
                      disabled={chat.streaming}
                    />
                    <ChatMcpSelector
                      selected={chat.mcpService}
                      onChange={chat.setMcpService}
                      disabled={chat.streaming}
                    />
                    <ChatSkillSelector selected={chat.skills} onChange={chat.setSkills} disabled={chat.streaming} />
                    <ChatAgentSelector selected={chat.agentId} onChange={chat.setAgentId} disabled={chat.streaming} />
                    <ChatModeToggle
                      mode={chat.chatMode}
                      disabled={chat.streaming}
                      onChange={(mode) => chat.setChatMode(chat.activeId, mode)}
                    />
                    <TaskCreationTool
                      selected={chat.taskCreationEnabled}
                      disabled={chat.streaming}
                      onChange={chat.setTaskCreationEnabled}
                      backendLabel={chat.taskBackend?.displayName}
                    />
                  </>
                }
              />
            </div>
          </>
        )}
      </section>
      {/* 工具调用 HITL：confirm 已内联到对话流（ChatConversation 卡片），
      UiRequestDialog 仅兆底 select/input/editor（对话板块不产生）与任务板块共用。 */}
      <UiRequestDialog />
      {/* 工作区创建弹窗 */}
      <WorkspaceCreateDialog
        open={workspaceDialogOpen}
        onOpenChange={setWorkspaceDialogOpen}
        onCreated={(group) => {
          // 创建后刷新 groups 并自动选中新工作区的第一个目录
          void chat.refreshMetas()
          setWelcomeDirectory(group.directories[0])
        }}
      />
    </div>
  )
}
