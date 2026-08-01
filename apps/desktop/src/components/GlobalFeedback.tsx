import { useEffect, useState } from "react";
import { AlertTriangleIcon, CheckCircle2Icon, XIcon } from "lucide-react";
import { useFeedback, type FeedbackMessage } from "@/hooks/useGlobalFeedback";
import { cn } from "@/lib/utils";

const AUTO_DISMISS_MS = 2000;

const ICONS: Record<FeedbackMessage["kind"], typeof AlertTriangleIcon> = {
  error: AlertTriangleIcon,
  success: CheckCircle2Icon
};

const TONE: Record<FeedbackMessage["kind"], string> = {
  error: "border-red-500/40 bg-red-500/10 text-red-200",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
};

/**
 * 浮层式全局反馈，位于 TopBar 下方水平居中，不会挤压页面布局。
 * 默认约 2 秒自动消失，鼠标悬停时暂停倒计时并可手动关闭。
 */
export function GlobalFeedback() {
  const { feedback, setFeedback } = useFeedback();
  const [hovered, setHovered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    setLeaving(false);
    setHovered(false);
  }, [feedback]);

  // 2s 自动消失（悬停时暂停）
  useEffect(() => {
    if (!feedback) return;
    if (hovered) return;
    const timer = window.setTimeout(() => setLeaving(true), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [feedback, hovered]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setFeedback(undefined);
      setLeaving(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [leaving, setFeedback]);

  if (!feedback) return null;
  const Icon = ICONS[feedback.kind] ?? AlertTriangleIcon;
  const close = () => setLeaving(true);

  return (
    <div
      role={feedback.kind === "error" ? "alert" : "status"}
      aria-live={feedback.kind === "error" ? "assertive" : "polite"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "global-feedback-slot pointer-events-auto fixed left-1/2 top-[48px] z-[100] flex max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-start gap-2.5 rounded-md border px-3 py-2 text-xs shadow-2xl backdrop-blur",
        "transition-all duration-200 ease-out",
        leaving
          ? "-translate-y-2 scale-[0.98] opacity-0"
          : "translate-y-0 scale-100 opacity-100 animate-[global-feedback-in_220ms_ease-out]",
        TONE[feedback.kind]
      )}
    >
      <Icon size={15} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-5">
        {feedback.message}
      </span>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={close}
        className="-m-1 rounded p-1 text-current/70 transition-colors hover:bg-white/10 hover:text-current"
      >
        <XIcon size={13} />
      </button>
    </div>
  );
}
