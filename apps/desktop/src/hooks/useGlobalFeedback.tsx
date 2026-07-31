import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type FeedbackKind = "error" | "success";

export type FeedbackMessage = { kind: FeedbackKind; message: string };

export type FeedbackApi = {
  feedback?: FeedbackMessage;
  setFeedback(next: FeedbackMessage | undefined): void;
  showError(message: string): void;
  showSuccess(message: string): void;
};

// 顶部 toast 自动消失时长（毫秒）。
const FEEDBACK_DURATION_MS = 2000;

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function useFeedbackProvider(): FeedbackApi {
  const [feedback, setFeedback] = useState<FeedbackMessage>();

  const showError = useCallback((message: string) => setFeedback({ kind: "error", message }), []);
  const showSuccess = useCallback((message: string) => setFeedback({ kind: "success", message }), []);

  // 顶部 toast 显示 FEEDBACK_DURATION_MS 毫秒后自动消失；
  // feedback 变化（被关闭或被新消息替换）时自动重置定时器。
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(undefined), FEEDBACK_DURATION_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  return useMemo(() => ({ feedback, setFeedback, showError, showSuccess }), [feedback, showError, showSuccess]);
}

export const FeedbackProvider = FeedbackContext.Provider;

export function useFeedback(): FeedbackApi {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error("useFeedback must be used inside <FeedbackProvider>");
  return value;
}
