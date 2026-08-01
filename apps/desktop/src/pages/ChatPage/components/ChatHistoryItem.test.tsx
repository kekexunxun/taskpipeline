import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatHistoryItem } from "./ChatHistoryItem";

describe("ChatHistoryItem", () => {
  it("requires confirmation before deleting a conversation", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<ChatHistoryItem active={false} onClick={vi.fn()} onDelete={onDelete} meta={{ id: "chat-a", title: "发布检查", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 2 }} />);
    await user.click(screen.getByRole("button", { name: "删除对话 发布检查" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
