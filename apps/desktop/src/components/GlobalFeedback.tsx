import { CheckCircle2, X, XCircle } from "lucide-react";
import { useFeedback } from "../hooks/useGlobalFeedback";

// 顶部居中的 toast 浮层：脱离文档流，不再挤压主框架；带图标 + 关闭按钮。
export function GlobalFeedback() {
  const { feedback, setFeedback } = useFeedback();
  return (
    <div className="global-feedback-slot" aria-live="polite">
      {feedback && (
        <div className={`global-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>
          {feedback.kind === "error" ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
          <span>{feedback.message}</span>
          <button className="global-feedback-close" title="关闭" onClick={() => setFeedback(undefined)}>
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
