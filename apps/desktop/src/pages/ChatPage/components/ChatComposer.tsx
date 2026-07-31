import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";

type Props = {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  onStop(): void;
  disabled?: boolean;
  streaming?: boolean;
  /** 底部工具栏左侧的额外节点（一般用于放置模型选择器等）。 */
  leftSlot?: ReactNode;
  /** 底部工具栏左侧在 leftSlot 之后追加的工具按钮。 */
  children?: ReactNode;
};

// 标准 AI 输入框：多行自适应高度、圆角容器、底部工具栏，Enter 发送 / Shift+Enter 换行。
// 视觉上对齐 ChatGPT / Claude 的 prompt-input 体验，但样式仍走项目既有 CSS 体系，
// 避免引入 Tailwind / shadcn-ai 带来的全局改造。
export function ChatComposer({ value, onChange, onSend, onStop, disabled, streaming, leftSlot, children }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // 根据内容自适应高度，限制在 1 ~ 8 行之间。
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lineHeight = 22; // 与 CSS .chat-composer-input 的 line-height 对齐
    const maxHeight = lineHeight * 8;
    const next = Math.max(lineHeight, Math.min(ta.scrollHeight, maxHeight));
    ta.style.height = `${next}px`;
  }, [value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    // 中文输入法选词时按 Enter 不应触发发送。
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (disabled || streaming) return;
    if (!value.trim()) return;
    onSend();
  };

  const canSend = !disabled && !streaming && value.trim().length > 0;

  return (
    <div className={`chat-composer ${disabled ? "disabled" : ""} ${streaming ? "streaming" : ""}`}>
      <textarea
        ref={ref}
        className="chat-composer-input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? "请先在「编码 → 设置 → 模型」中配置 Qoder 或 OpenAI-Compatible 模型" : "发送消息给 AI…  Enter 发送，Shift+Enter 换行"}
        rows={1}
      />
      <div className="chat-composer-footer">
        <div className="chat-composer-tools">
          {leftSlot}
          {children}
        </div>
        <div className="chat-composer-actions">
          {streaming ? (
            <button className="chat-composer-stop" type="button" title="停止生成" onClick={onStop}>
              <Square size={12} />
            </button>
          ) : (
            <button className={`chat-composer-send ${canSend ? "ready" : ""}`} type="button" title="发送" disabled={!canSend} onClick={onSend}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
