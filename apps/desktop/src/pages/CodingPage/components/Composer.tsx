import { useRef } from "react";
import { Send } from "lucide-react";

export function Composer({ value, onChange, onSend, disabled }: { value: string; onChange(value: string): void; onSend(): void; disabled?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); }
        }}
        placeholder={disabled ? "等待执行器就绪" : "向 AI 提问或补充需求 · Enter 发送，Shift+Enter 换行"}
        rows={3}
      />
      <button className="primary send-button" title="发送" disabled={disabled || !value.trim()} onClick={onSend}><Send size={14} /></button>
    </div>
  );
}
