import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type FeedbackKind = "error" | "success";

export type FeedbackMessage = { kind: FeedbackKind; message: string };

export type FeedbackApi = {
  feedback?: FeedbackMessage;
  setFeedback(next: FeedbackMessage | undefined): void;
  showError(message: string): void;
  showSuccess(message: string): void;
};

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function useFeedbackProvider(): FeedbackApi {
  const [feedback, setFeedback] = useState<FeedbackMessage>();

  const showError = useCallback((message: string) => {
    setFeedback({ kind: "error", message });
  }, []);
  const showSuccess = useCallback((message: string) => {
    setFeedback({ kind: "success", message });
  }, []);

  return useMemo(
    () => ({ feedback, setFeedback, showError, showSuccess }),
    [feedback, setFeedback, showError, showSuccess]
  );
}

export const FeedbackProvider = FeedbackContext.Provider;

export function useFeedback(): FeedbackApi {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error("useFeedback must be used inside <FeedbackProvider>");
  return value;
}
