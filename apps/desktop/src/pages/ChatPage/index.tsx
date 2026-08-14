import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChatHistoryList } from './components/ChatHistoryList'
import { ChatConversation } from './components/ChatConversation'
import { ChatComposer } from './components/ChatComposer'
import { ChatModelSelector } from './components/ChatModelSelector'
import { ChatMcpSelector } from './components/ChatMcpSelector'
import { ChatSkillSelector } from './components/ChatSkillSelector'
import { ChatAgentSelector } from './components/ChatAgentSelector'
import { ChatDirectoryBadge } from './components/ChatDirectoryBadge'
import { ChatWelcomeView } from './components/ChatWelcomeView'
import { TaskCreationTool } from './components/TaskCreationTool'
import type { ChatApprovalRequest } from './hooks/useChat'
import { useChat } from './hooks/useChat'
import { UiRequestDialog } from '@/pages/CodingPage/components/UiRequestDialog'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { api } from '@/api'
import { useFeedback } from '@/hooks/useGlobalFeedback'

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

  // 工具调用 HITL：Qoder 等 driver 的 can_use_tool 确认请求由主进程以
  // extension_ui_request 广播（task:event 通道）。
  // - confirm：内联到对话流（ChatToolApprovalCard），按 conversationId 归属，并行对话各自展示；
  // - select/input/editor：对话板块不会产生，保留 UiRequestDialog 作为兜底。
  useEffect(() => {
    const off = api.onTaskEvent(
      (event: { type?: string; method?: string; conversationId?: string } & ChatApprovalRequest) => {
        if (event?.type !== 'extension_ui_request') return
        if (event.method === 'confirm') {
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

  const handleSend = async (value: string) => {
    const wasEmpty = !chat.activeId
    const newId = await chat.send(value)
    if (newId && wasEmpty) navigate(`/chat/${newId}`)
  }

  // 欢迎页发送：若选择了项目目录，先创建带目录的对话再发送
  const welcomeHandleSend = async (value: string) => {
    setWelcomeDraft('') // 清空欢迎页草稿
    if (welcomeDirectory) {
      setIsTransitioning(true)
      try {
        // 1. 创建带目录的对话（会设置 activeId）
        const id = await chat.create(welcomeDirectory)
        if (id) {
          // 2. 发送消息（使用刚创建的对话）
          await chat.send(value)
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
        projects={chat.projects}
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
        onDelete={(id) => void chat.remove(id)}
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
            projects={chat.projects}
            projectValue={welcomeDirectory}
            onProjectChange={setWelcomeDirectory}
            onAddProject={() => void chooseProjectDirectory()}
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
                {chat.conversation?.workingDirectory && (
                  <ChatDirectoryBadge workingDirectory={chat.conversation.workingDirectory} />
                )}
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
              onRespondApproval={(id, confirmed) => void chat.respondApproval(id, confirmed)}
              onExecuteJira={async (taskKey) => {
                try {
                  const task = await api.importJiraTask(taskKey)
                  navigate(`/coding/${task.id}`)
                } catch (reason) {
                  showError(reason instanceof Error ? reason.message : String(reason))
                  throw reason
                }
              }}
            />

            <div className="shrink-0 border-t bg-background/95 px-4 pt-2 pb-2.5">
              <ChatComposer
                value={chat.draft}
                onChange={chat.setDraft}
                onSend={handleSend}
                onStop={() => void chat.stop()}
                disabled={!hasModel}
                placeholder={
                  !hasModel
                    ? '请先在设置中配置可用模型'
                    : chat.taskCreationEnabled
                      ? '描述准备创建的 Jira 任务，Agent 会补齐必要信息'
                      : undefined
                }
                streaming={chat.streaming}
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
      UiRequestDialog 仅兜底 select/input/editor（对话板块不产生）与任务板块共用。 */}
      <UiRequestDialog />
    </div>
  )
}
