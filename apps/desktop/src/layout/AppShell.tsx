import { useEffect, useRef, useState } from 'react'
import { Navigate, Routes, Route } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { useQoderStatus } from '../hooks/useQoderStatus'
import { QoderStatusProvider, useQoderStatusContext } from '../hooks/useQoderStatusContext'
import { useFeedbackProvider, FeedbackProvider } from '../hooks/useGlobalFeedback'
import { GlobalFeedback } from '../components/GlobalFeedback'
import { CredentialCheckDialog } from '../components/CredentialCheckDialog'
import { api, type CredentialCheckResult } from '../api'
import { SettingsDialog } from '../pages/CodingPage/components/SettingsDialog'
import { TopBar } from './TopBar'
import { ActionBar } from './ActionBar'
import { StatusBar } from './StatusBar'
import { TooltipProvider } from '@/components/ui/tooltip'

const ChatPage = lazy(() => import('../pages/ChatPage/index'))
const CodingPage = lazy(() => import('../pages/CodingPage/index'))
const TracePage = lazy(() => import('../pages/TracePage/index'))

/** 失效项 → 设置弹窗 Tab 的定位映射：Jira / Confluence 在 Atlassian Tab，其余在通用 Tab。 */
function settingsTabForFailures(failures: CredentialCheckResult[]): string | undefined {
  const first = failures[0]
  if (!first) return undefined
  return first.key === 'jira' || first.key === 'confluence' ? 'atlassian' : 'general'
}

function ShellInner({
  onOpenSettings,
  credentialIssueCount,
  onOpenCredentials
}: {
  onOpenSettings(): void
  credentialIssueCount: number
  onOpenCredentials(): void
}) {
  const qoder = useQoderStatusContext()
  return (
    <main
      className={`grid h-screen min-h-0 grid-rows-[44px_minmax(0,1fr)] bg-background ${qoder.status?.enabled ? 'grid-rows-[44px_minmax(0,1fr)_26px]' : ''}`}
    >
      <TopBar
        onOpenSettings={onOpenSettings}
        credentialIssueCount={credentialIssueCount}
        onOpenCredentials={onOpenCredentials}
      />
      <div className="flex min-h-0">
        <ActionBar />
        <div className="min-w-0 flex-1">
          <Suspense
            fallback={<div className="grid h-full place-items-center text-xs text-muted-foreground">加载中…</div>}
          >
            <Routes>
              <Route path="/" element={<Navigate to="/coding" replace />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/chat/:conversationId" element={<ChatPage />} />
              <Route path="/coding" element={<CodingPage />} />
              <Route path="/coding/:taskId" element={<CodingPage />} />
              <Route path="/trace" element={<TracePage />} />
              <Route path="/trace/:kind/:traceId" element={<TracePage />} />
            </Routes>
          </Suspense>
        </div>
      </div>
      <StatusBar />
    </main>
  )
}

export function AppShell() {
  const qoder = useQoderStatus()
  const feedback = useFeedbackProvider()
  // 检查回调用 ref 读最新 feedback：避免 effect 依赖 feedback 身份，
  // 保存设置等场景的 toast 会改变 feedback 导致 effect 重跑、凭据检查被重复触发。
  const feedbackRef = useRef(feedback)
  feedbackRef.current = feedback
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined)
  const [credentialFailures, setCredentialFailures] = useState<CredentialCheckResult[]>([])
  const [credentialPending, setCredentialPending] = useState<Array<Pick<CredentialCheckResult, 'key' | 'label'>>>([])
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false)
  // 弹窗已被用户主动关闭：之后迟到的失败项（如慢的探测）不再重新弹开，
  // 改为 toast 提示 + 顶栏常驻角标，避免打扰。
  const credentialDismissedRef = useRef(false)
  // dev StrictMode 下 effect 双挂载，ref 保证启动检查只触发一次；
  // 保存设置后的重检由 SettingsDialog onSaved 显式触发。
  const startupCheckStartedRef = useRef(false)
  // 进入系统时统一检查各配置 Token（Qoder / GitLab / Jira / Confluence）是否已过期。
  // 收到 start 清单立即弹框（含「检查中」行），用户无需干等慢结果；
  // 各项完成后流式上报，失败项实时追加进已打开的弹窗。
  useEffect(() => {
    let cancelled = false
    const unsubscribeStart = api.onCredentialCheckStart((items) => {
      if (cancelled) return
      setCredentialPending(items)
      // 新一轮开始：先清掉本轮重检 key 的旧失败记录，由本轮结果覆盖，
      // 避免「修复 Token 重检后旧错误仍残留」。
      const rechecking = new Set(items.map((item) => item.key))
      setCredentialFailures((prev) => prev.filter((item) => !rechecking.has(item.key)))
      if (items.length > 0) {
        credentialDismissedRef.current = false
        setCredentialDialogOpen(true)
      }
    })
    const unsubscribeItem = api.onCredentialCheckItem((result) => {
      if (cancelled) return
      setCredentialPending((prev) => prev.filter((item) => item.key !== result.key))
      // 以最新一轮结果覆盖同 key 旧记录：通过/跳过时移除旧失败项。
      setCredentialFailures((prev) => {
        const rest = prev.filter((item) => item.key !== result.key)
        return result.status === 'failed' ? [...rest, result] : rest
      })
      if (result.status !== 'failed') return
      if (credentialDismissedRef.current) {
        // 弹窗已关闭：迟到结果用 toast 告知，顶栏角标计数自动更新。
        feedbackRef.current.showError(`${result.label} 检查未通过：${result.message ?? '凭据可能已过期'}`)
      } else {
        setCredentialDialogOpen(true)
      }
    })
    if (!startupCheckStartedRef.current) {
      startupCheckStartedRef.current = true
      void api.checkCredentials().catch(() => undefined)
    }
    return () => {
      cancelled = true
      unsubscribeStart()
      unsubscribeItem()
    }
  }, [])
  // 全部检查完成且无失效项：自动收起弹窗，不打扰用户。
  useEffect(() => {
    if (credentialDialogOpen && credentialPending.length === 0 && credentialFailures.length === 0) {
      credentialDismissedRef.current = true
      setCredentialDialogOpen(false)
    }
  }, [credentialDialogOpen, credentialPending, credentialFailures])
  const handleCredentialDialogOpenChange = (open: boolean) => {
    if (!open) credentialDismissedRef.current = true
    setCredentialDialogOpen(open)
  }
  const openSettingsFromCredentialCheck = (failures: CredentialCheckResult[]) => {
    credentialDismissedRef.current = true
    setCredentialDialogOpen(false)
    setSettingsInitialTab(settingsTabForFailures(failures))
    setSettingsOpen(true)
  }
  const reopenCredentialDialog = () => {
    credentialDismissedRef.current = false
    setCredentialDialogOpen(true)
  }
  return (
    <FeedbackProvider value={feedback}>
      <QoderStatusProvider value={qoder}>
        <TooltipProvider delayDuration={350}>
          <GlobalFeedback />
          <ShellInner
            onOpenSettings={() => setSettingsOpen(true)}
            credentialIssueCount={credentialFailures.length}
            onOpenCredentials={reopenCredentialDialog}
          />
          <CredentialCheckDialog
            failures={credentialFailures}
            pending={credentialPending}
            open={credentialDialogOpen}
            onOpenChange={handleCredentialDialogOpenChange}
            onOpenSettings={openSettingsFromCredentialCheck}
          />
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            qoder={qoder.status}
            onQoderRefresh={() => void qoder.refresh()}
            onSaved={() => void api.checkCredentials().catch(() => undefined)}
            initialTab={settingsInitialTab}
          />
        </TooltipProvider>
      </QoderStatusProvider>
    </FeedbackProvider>
  )
}
