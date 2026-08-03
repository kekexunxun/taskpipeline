import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaskCreationTool } from "./TaskCreationTool";

describe("TaskCreationTool", () => {
  it("exposes a pressed state and toggles task creation mode", () => {
    const onChange = vi.fn();
    render(<TooltipProvider><TaskCreationTool selected onChange={onChange} /></TooltipProvider>);
    const button = screen.getByRole("button", { name: "任务创建" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
