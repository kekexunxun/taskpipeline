import { useEffect, type ReactNode } from "react";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";

type Props = {
  value: string;
  onChange(value: string): void;
  onSend(value?: string): void;
  onStop?(): void;
  disabled?: boolean;
  streaming?: boolean;
  placeholder?: string;
  leftSlot?: ReactNode;
  className?: string;
};

function Controlled({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  streaming,
  placeholder,
  leftSlot,
  className
}: Props) {
  const controller = usePromptInputController();

  // 外部受控 value 变化时同步到内部状态
  useEffect(() => {
    if (controller.textInput.value !== value) controller.textInput.setInput(value);
  }, [controller, value]);

  const trimmed = value.trim();
  const canSend = !disabled && !streaming && trimmed.length > 0;
  const showStop = streaming && onStop;
  const defaultPlaceholder = disabled
    ? "等待执行器就绪"
    : streaming
    ? "正在生成回复…"
    : "输入消息，Enter 发送，Shift+Enter 换行";

  return (
    <PromptInput
      className={cn(
        "w-full rounded-lg border border-border/60 bg-card/60 transition-colors focus-within:border-border/60",
        (disabled || streaming) && "opacity-90",
        className
      )}
      onSubmit={({ text }) => {
        const payload = text.trim();
        if (!payload || disabled || streaming) return;
        onChange("");
        onSend(payload);
      }}
    >
      <PromptInputTextarea
        data-testid="chat-composer"
        className="min-h-10 max-h-52 px-3 py-2 text-xs! leading-5 placeholder:text-muted-foreground"
        disabled={disabled || streaming}
        placeholder={placeholder ?? defaultPlaceholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            if (canSend) {
              onChange("");
              onSend(value);
            }
          }
        }}
      />
      <PromptInputFooter className="min-h-7 gap-2 px-2 pb-1.5 pt-1">
        <PromptInputTools className="min-w-0 gap-1 overflow-visible">
          {leftSlot}
        </PromptInputTools>
        <PromptInputSubmit
          aria-label={showStop ? "停止生成" : "发送"}
          disabled={showStop ? false : !canSend}
          status={showStop ? "streaming" : undefined}
          onStop={onStop}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}

/**
 * 统一 Prompt 组件：被 ChatPage 与 CodingPage 复用。
 * - leftSlot: 工具栏左侧的额外控件（如模型选择器）。
 * - disabled: 禁止输入与发送。
 * - streaming: 流式生成中（显示「停止」按钮）。
 *
 * 实现：直接基于 ai-elements 的 `<PromptInput>` / `<PromptInputTextarea>` 等原子组件，
 * 通过 `<PromptInputProvider>` 暴露受控 value，统一由 Composer 内部承担 Enter 发送 / Shift+Enter 换行。
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  streaming,
  placeholder,
  leftSlot,
  className
}: Props) {
  return (
    <PromptInputProvider initialInput={value}>
      <Controlled
        value={value}
        onChange={onChange}
        onSend={onSend}
        onStop={onStop}
        disabled={disabled}
        streaming={streaming}
        placeholder={placeholder}
        leftSlot={leftSlot}
        className={className}
      />
    </PromptInputProvider>
  );
}
