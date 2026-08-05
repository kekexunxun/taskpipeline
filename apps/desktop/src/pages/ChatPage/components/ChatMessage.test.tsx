import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/api";
import { ChatMessageView } from "./ChatMessage";

describe("ChatMessageView task creation action", () => {
  it("executes the structured Jira key instead of parsing assistant text", async () => {
    const onExecuteJira = vi.fn(async () => undefined);
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      metadata: {
        createdAt: new Date().toISOString(),
        status: "done",
        taskCreation: { backend: "jira", externalKey: "BSADAPT344-42", summary: "Agent", projectKey: "BSADAPT344", issueType: "任务" }
      },
      parts: [{ type: "text", text: "回复中没有 Jira Key" }]
    };
    render(<ChatMessageView message={message} onExecuteJira={onExecuteJira} />);
    fireEvent.click(screen.getByRole("button", { name: "立即执行" }));
    await waitFor(() => expect(onExecuteJira).toHaveBeenCalledWith("BSADAPT344-42"));
  });

  it("supports task creation metadata persisted with the legacy Jira field", async () => {
    const onExecuteJira = vi.fn(async () => undefined);
    const message: ChatMessage = {
      id: "assistant-legacy",
      role: "assistant",
      metadata: {
        createdAt: new Date().toISOString(),
        status: "done",
        taskCreation: { backend: "jira", externalKey: "LEGACY-7", summary: "Legacy", projectKey: "LEGACY", issueType: "任务" }
      },
      parts: [{ type: "text", text: "历史消息" }]
    };
    render(<ChatMessageView message={message} onExecuteJira={onExecuteJira} />);
    fireEvent.click(screen.getByRole("button", { name: "立即执行" }));
    await waitFor(() => expect(onExecuteJira).toHaveBeenCalledWith("LEGACY-7"));
  });
});
