import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatComposer } from "./ChatComposer";

function renderComposer(value = "你好", disabled = false) {
  const onSend = vi.fn();
  const onChange = vi.fn();
  render(<TooltipProvider><ChatComposer value={value} disabled={disabled} onChange={onChange} onSend={onSend} onStop={vi.fn()} /></TooltipProvider>);
  return { field: screen.getByTestId("chat-composer"), onSend, onChange };
}

describe("ChatComposer", () => {
  it("sends with Enter but keeps Shift+Enter for a newline", () => {
    const { field, onSend } = renderComposer();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("does not send while an IME composition is active", () => {
    const { field, onSend } = renderComposer();
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables sending for blank content", () => {
    renderComposer("   ");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("disables input while the task is executing", () => {
    const { field, onSend } = renderComposer("你好", true);
    expect(field).toBeDisabled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});
