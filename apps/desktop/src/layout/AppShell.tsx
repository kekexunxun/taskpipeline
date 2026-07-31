import { useState } from "react";
import { Routes, Route } from "react-router-dom";
import { lazy, Suspense } from "react";
import { TopBar } from "./TopBar";
import { ActionBar } from "./ActionBar";
import { StatusBar } from "./StatusBar";
import { useQoderStatus } from "../hooks/useQoderStatus";
import { QoderStatusProvider, useQoderStatusContext } from "../hooks/useQoderStatusContext";
import { useFeedbackProvider, FeedbackProvider } from "../hooks/useGlobalFeedback";
import { GlobalFeedback } from "../components/GlobalFeedback";
import { SettingsDialog } from "../pages/CodingPage/components/SettingsDialog";
import { RepositoryDialog } from "../pages/CodingPage/components/RepositoryDialog";

const ChatPage = lazy(() => import("../pages/ChatPage/index"));
const CodingPage = lazy(() => import("../pages/CodingPage/index"));

function ShellInner({ onOpenSettings }: { onOpenSettings(): void }) {
  const qoder = useQoderStatusContext();
  return (
    <main className={`app-shell ${qoder.status?.enabled ? "with-status" : ""}`}>
      <TopBar onOpenSettings={onOpenSettings} />
      <div className="app-body">
        <ActionBar />
        <div className="app-content">
          <Suspense fallback={<div className="app-loading">加载中…</div>}>
            <Routes>
              <Route path="/" element={<ChatPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/chat/:conversationId" element={<ChatPage />} />
              <Route path="/coding" element={<CodingPage />} />
              <Route path="/coding/:taskId" element={<CodingPage />} />
            </Routes>
          </Suspense>
        </div>
      </div>
      <StatusBar />
    </main>
  );
}

export function AppShell() {
  const qoder = useQoderStatus();
  const feedback = useFeedbackProvider();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  return (
    <FeedbackProvider value={feedback}>
      <QoderStatusProvider value={qoder}>
        <GlobalFeedback />
        <ShellInner onOpenSettings={() => setSettingsOpen(true)} />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} qoder={qoder.status} onRepositoriesChanged={() => setRepoDialogOpen(true)} />
        <RepositoryDialog open={repoDialogOpen} onOpenChange={setRepoDialogOpen} onSaved={() => { setRepoDialogOpen(false); window.dispatchEvent(new CustomEvent("app:repositories-changed")); }} />
      </QoderStatusProvider>
    </FeedbackProvider>
  );
}
