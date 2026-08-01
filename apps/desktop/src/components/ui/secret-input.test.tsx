import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecretInput } from "./secret-input";

describe("SecretInput", () => {
  it("reveals a newly entered value without revealing the configured sentinel", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SecretInput aria-label="API Key" value="__configured__" onChange={onChange} />);
    expect(screen.getByPlaceholderText("已配置，输入新值覆盖")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示API Key" })).toBeDisabled();

    rerender(<SecretInput aria-label="API Key" value="secret-value" onChange={onChange} />);
    const toggle = screen.getByRole("button", { name: "显示API Key" });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(screen.getByDisplayValue("secret-value")).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "隐藏API Key" })).toBeInTheDocument();
  });
});
