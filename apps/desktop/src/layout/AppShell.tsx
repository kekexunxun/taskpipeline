import { useEffect, useRef, useState } from 'react'
import { Navigate, Routes, Route } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { useQoderStatus } from '../hooks/useQoderStatus'
import { QoderStatusProvider, useQoderStatusContext } from '../hooks/useQoderStatusContext'
import { useCredentialStatus } from '../hooks/useCredentialStatus'
import { CredentialStatusProvider } from '../hooks/useCredentialStatusContext'
import { useFeedbackProvider, FeedbackProvider } from '../hooks/useGlobalFeedback'
import { GlobalFeedback } from '../components/GlobalFeedback'
import { api, type CredentialState } from '../api'
import { SettingsDialog } from '../pages/CodingPage/components/SettingsDialog'
import { TopBar } from './TopBar'
import { ActionBar } from './ActionBar'
import { StatusBar } from './StatusBar'
import { TooltipProvider } from '@/components/ui/tooltip'

const ChatPage = lazy(() => import('../pages/ChatPage/index'))
const CodingPage = lazy(() => import('../pages/CodingPage/index'))
const TracePage = lazy(() => import('../pages/TracePage/index'))

/** 失效项 → 设置弹窗 Tab 的定位映射：Jira / Confluence 在 Atlassian Tab，GitLab 在 Gitlab Tab，Qoder 在模型 Tab，其余在通用 Tab。 */
function settingsTabForFailures(failures: CredentialState[]): string | undefined {
  const first = failures[0]
  if (!first) return undefined
  if (first.key === 'jira' || first.key === 'confluence') return 'atlassian'
  if (first.key === 'gitlab') return 'gitlab'
  if (first.key === 'qoder') return 'model'
  return 'general'
}

function ShellInner({
  onOpenSettings,
  onOpenCredentialSettings
}: {
  onOpenSettings(): void
  onOpenCredentialSettings(failures: CredentialState[]): void
}) {
  const qoder = useQoderStatusContext()
  return (
    <main
      className={`grid h-screen min-h-0 grid-rows-[44px_minmax(0,1fr)] bg-background ${qoder.status?.enabled ? 'grid-rows-[44px_minmax(0,1fr)_26px]' : ''}`}
    >
      <TopBar onOpenSettings={onOpenSettings} onOpenCredentialSettings={onOpenCredentialSettings} />
      <div className="flex min-h-0">
        <ActionBar />
        <div className="min-w-0 flex-1">
          <Suspense
            fallback={<div className="grid h-full place-items-center text-xs text-muted-foreground">加载中…</div>}
          >
            <Routes>
              <Route path="/" element={<Navigate to="/chat" replace />} />
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
  const credentials = useCredentialStatus()
  const feedback = useFeedbackProvider()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined)
  // dev StrictMode 下 effect 双挂载，ref 保证启动检查只触发一次；
  // 保存设置后的重检由 SettingsDialog onSaved 显式触发。
  const startupCheckStartedRef = useRef(false)
  // 进入系统时统一触发一轮凭据探测：结果写入主进程全局状态并广播，
  // 顶栏指示灯常驻展示，不再弹窗后消失。
  useEffect(() => {
    if (!startupCheckStartedRef.current) {
      startupCheckStartedRef.current = true
      void api.checkCredentials().catch(() => undefined)
    }
  }, [])
  const openCredentialSettings = (failures: CredentialState[]) => {
    setSettingsInitialTab(settingsTabForFailures(failures))
    setSettingsOpen(true)
  }
  // 对话区选择器「立即新增」→ 打开设置并定位到对应 Tab（MCP / Skill / Agent）。
  useEffect(() => {
    const onOpenSettings = (event: Event) => {
      const tab = (event as CustomEvent<string>).detail
      if (typeof tab === 'string' && tab) {
        setSettingsInitialTab(tab)
        setSettingsOpen(true)
      }
    }
    window.addEventListener('app:open-settings', onOpenSettings)
    return () => window.removeEventListener('app:open-settings', onOpenSettings)
  }, [])
  return (
    <FeedbackProvider value={feedback}>
      <QoderStatusProvider value={qoder}>
        <CredentialStatusProvider value={credentials}>
          <TooltipProvider delayDuration={350}>
            <GlobalFeedback />
            <ShellInner
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenCredentialSettings={openCredentialSettings}
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
        </CredentialStatusProvider>
      </QoderStatusProvider>
    </FeedbackProvider>
  )
}
