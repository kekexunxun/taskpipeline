import { useState } from "react";
import { Navigate, Routes, Route } from "react-router-dom";
import { lazy, Suspense } from "react";
import { TopBar } from "./TopBar";
import { ActionBar } from "./ActionBar";
import { StatusBar } from "./StatusBar";
import { useQoderStatus } from "../hooks/useQoderStatus";
import { QoderStatusProvider, useQoderStatusContext } from "../hooks/useQoderStatusContext";
import { useFeedbackProvider, FeedbackProvider } from "../hooks/useGlobalFeedback";
import { GlobalFeedback } from "../components/GlobalFeedback";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsDialog } from "../pages/CodingPage/components/SettingsDialog";

const ChatPage = lazy(() => import("../pages/ChatPage/index"));
const CodingPage = lazy(() => import("../pages/CodingPage/index"));

function ShellInner({ onOpenSettings }: { onOpenSettings(): void }) {
  const qoder = useQoderStatusContext();
  return (
    <main className={`grid h-screen min-h-0 grid-rows-[44px_minmax(0,1fr)] bg-background ${qoder.status?.enabled ? "grid-rows-[44px_minmax(0,1fr)_26px]" : ""}`}>
      <TopBar onOpenSettings={onOpenSettings} />
      <div className="flex min-h-0">
        <ActionBar />
        <div className="min-w-0 flex-1">
          <Suspense fallback={<div className="grid h-full place-items-center text-xs text-muted-foreground">加载中…</div>}>
            <Routes>
              <Route path="/" element={<Navigate to="/coding" replace />} />
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
  return (
    <FeedbackProvider value={feedback}>
      <QoderStatusProvider value={qoder}>
        <TooltipProvider delayDuration={350}>
          <GlobalFeedback />
          <ShellInner onOpenSettings={() => setSettingsOpen(true)} />
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} qoder={qoder.status} onQoderRefresh={() => void qoder.refresh()} />
        </TooltipProvider>
      </QoderStatusProvider>
    </FeedbackProvider>
  );
}
