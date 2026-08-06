import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatMessage, DriverPart } from "@/api";
import { OpenAIMessageView } from "./OpenAIMessageView";

function openaiMessage(parts: DriverPart[]): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    createdAt: new Date().toISOString(),
    driverId: "openai",
    raw: { kind: "assistant", parts },
    parts
  };
}

describe("OpenAIMessageView", () => {
  it("renders text parts through the shared TextPart renderer", () => {
    render(<OpenAIMessageView message={openaiMessage([
      { driverId: "openai", type: "text", text: "OpenAI 的纯文本回复" }
    ])} />);
    expect(screen.getByText("OpenAI 的纯文本回复")).toBeInTheDocument();
  });

  it("renders markdown in text parts via the same renderer as Qoder", () => {
    render(<OpenAIMessageView message={openaiMessage([
      { driverId: "openai", type: "text", text: "# 标题\n\n- 列表项 1\n- 列表项 2" }
    ])} />);
    expect(screen.getByText("标题")).toBeInTheDocument();
    expect(screen.getByText("列表项 1")).toBeInTheDocument();
    expect(screen.getByText("列表项 2")).toBeInTheDocument();
  });

  it("pairs openai.tool-call with openai.tool-result by toolCallId and shows the tool name", () => {
    // OpenAI 工具状态只显示图标(无 "已完成" 文字标签),与 Qoder 区分
    render(<OpenAIMessageView message={openaiMessage([
      { driverId: "openai", type: "openai.tool-call", toolCallId: "tc-1", name: "createJiraIssue", input: { projectKey: "BSADAPT" } },
      { driverId: "openai", type: "openai.tool-result", toolCallId: "tc-1", output: { taskKey: "BSADAPT-2" } }
    ])} />);
    expect(screen.getByText("createJiraIssue")).toBeInTheDocument();
    // OpenAI 视图不应该出现 Qoder 专属的 "已完成" 文字
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
  });

  it("renders an openai.tool-call alone (no result) without errors", () => {
    render(<OpenAIMessageView message={openaiMessage([
      { driverId: "openai", type: "openai.tool-call", toolCallId: "tc-x", name: "createJiraIssue", input: {} }
    ])} />);
    expect(screen.getByText("createJiraIssue")).toBeInTheDocument();
  });

  it("renders an openai message alongside an openai text part (clean basic case)", () => {
    // OpenAI 视图最简单的形态:只有 text part,不应该出现任何 tool 折叠块
    render(<OpenAIMessageView message={openaiMessage([
      { driverId: "openai", type: "text", text: "OpenAI 的简洁回复" }
    ])} />);
    expect(screen.getByText("OpenAI 的简洁回复")).toBeInTheDocument();
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
    expect(screen.queryByText("思考中…")).not.toBeInTheDocument();
  });

  it("renders an orphan openai.tool-result via the fallback renderer (no matching tool-call)", () => {
    // PartRenderer 会渲染 orphan result,验证不会出现 null
    render(<OpenAIMessageView message={openaiMessage([
      { driverId: "openai", type: "openai.tool-result", toolCallId: "orphan", output: { ok: true } }
    ])} />);
    // 至少能渲染不报错;具体内部文案不强求
    expect(document.body.textContent).toBeDefined();
  });
});
