import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChatHistoryList } from './components/ChatHistoryList'
import { ChatConversation } from './components/ChatConversation'
import { ChatComposer } from './components/ChatComposer'
import { ChatModelSelector } from './components/ChatModelSelector'
import { ChatMcpSelector } from './components/ChatMcpSelector'
import { ChatSkillSelector } from './components/ChatSkillSelector'
import { ChatAgentSelector } from './components/ChatAgentSelector'
import { ChatDirectoryBadge } from './components/ChatDirectoryBadge'
import { TaskCreationTool } from './components/TaskCreationTool'
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

  // 工具调用 HITL：Qoder 等 driver 的 can_use_tool 确认请求由主进程以
  // extension_ui_request 广播（task:event 通道），这里转发给 UiRequestDialog 弹窗。
  // 与 CodingPage/useTasks.ts 的处理保持一致，缺了它会卡在等用户决策。
  useEffect(() => {
    const off = api.onTaskEvent((event: { type?: string; method?: string }) => {
      if (
        event?.type === 'extension_ui_request' &&
        ['confirm', 'select', 'input', 'editor'].includes(event.method ?? '')
      ) {
        window.dispatchEvent(new CustomEvent('task:ui-request', { detail: event }))
      }
    })
    return off
  }, [])

  // 会话结束/中止时清空残留的确认弹窗队列（主进程已按取消处理）。
  // 对齐 CodingPage/useTasks.ts 的 task:ui-clear 广播，否则旧弹窗滞留 UI 并阻塞后续请求。
  useEffect(() => {
    const clear = () => window.dispatchEvent(new CustomEvent('task:ui-clear'))
    if (!chat.streaming) clear()
    return () => undefined
  }, [chat.streaming])

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

  const create = async () => {
    if (chat.activeId && chat.conversation?.messages.length === 0) {
      document.querySelector<HTMLTextAreaElement>('[data-testid=chat-composer]')?.focus()
      return
    }
    const id = await chat.create()
    if (id) navigate(`/chat/${id}`)
  }

  /**
   * 项目对话入口:选目录(或直接传入已有目录)→ 在该目录下新建会话。
   * Codex 式:一个目录可挂多个会话。
   */
  const createProject = async (directory?: string) => {
    let dir = directory
    if (!dir) {
      try {
        dir = await api.chooseDirectory()
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason))
        return
      }
    }
    if (!dir) return
    const id = await chat.create(dir)
    if (id) navigate(`/chat/${id}`)
  }

  const handleSend = async (value: string) => {
    const wasEmpty = !chat.activeId
    const newId = await chat.send(value)
    if (newId && wasEmpty) navigate(`/chat/${newId}`)
  }

  const hasModel = chat.modelGroups.some((group) => group.models.length)
  const isEmpty = !chat.activeId
  const headerSubtitle = isEmpty
    ? '输入消息即可自动创建新对话'
    : `${chat.messages.length} 条消息 · ${hasModel ? `${chat.modelGroups.length} 个 Provider` : '未配置模型'}`

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[288px_minmax(0,1fr)] bg-background">
      <ChatHistoryList
        metas={chat.metas}
        projects={chat.projects}
        activeId={chat.activeId}
        onSelect={(id) => navigate(`/chat/${id}`)}
        onCreate={() => void create()}
        onCreateInDirectory={(dir) => void createProject(dir)}
        onDelete={(id) => void chat.remove(id)}
      />
      <section className="grid min-w-0 grid-rows-[52px_minmax(0,1fr)_auto] overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b px-5">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight">{chat.conversation?.title ?? '新建对话'}</h1>
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
                  : isEmpty
                    ? '输入消息，Enter 发送，将自动创建新对话'
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
        </div>
      </section>
      {/* 工具调用 HITL 确认框：can_use_tool 请求的 UI（任务板块同款组件） */}
      <UiRequestDialog />
    </div>
  )
}
