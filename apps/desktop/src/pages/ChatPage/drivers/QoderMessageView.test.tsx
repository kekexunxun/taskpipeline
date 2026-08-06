import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatMessage, DriverPart } from "@/api";
import { QoderMessageView } from "./QoderMessageView";

function qoderMessage(parts: DriverPart[]): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    createdAt: new Date().toISOString(),
    driverId: "qoder",
    raw: { kind: "assistant", parts },
    parts
  };
}

describe("QoderMessageView", () => {
  it("renders text parts through the shared TextPart renderer", () => {
    render(<QoderMessageView message={qoderMessage([
      { driverId: "qoder", type: "text", text: "你好,这是 Qoder 回复" }
    ])} />);
    expect(screen.getByText("你好,这是 Qoder 回复")).toBeInTheDocument();
  });

  it("renders a thinking part as a collapsible with 思考中… trigger label", () => {
    render(<QoderMessageView message={qoderMessage([
      { driverId: "qoder", type: "qoder.thinking", text: "推理过程", signature: "sig-1" }
    ])} />);
    // 折叠 trigger 包含 "思考中…"
    expect(screen.getByText("思考中…")).toBeInTheDocument();
  });

  it("renders a qoder.session part with a 12-char truncated session id", () => {
    const longId = "abcdefghijklmnopqrstuvwxyz-1234567890";
    render(<QoderMessageView message={qoderMessage([
      { driverId: "qoder", type: "qoder.session", sessionId: longId }
    ])} />);
    // 只取前 12 个字符
    expect(screen.getByText(`session ${longId.slice(0, 12)}`)).toBeInTheDocument();
  });

  it("pairs qoder.tool-use with qoder.tool-result by toolCallId and shows the tool name + 已完成", () => {
    render(<QoderMessageView message={qoderMessage([
      { driverId: "qoder", type: "qoder.tool-use", toolCallId: "tc-1", name: "createJiraIssue", input: { projectKey: "BSADAPT" } },
      { driverId: "qoder", type: "qoder.tool-result", toolCallId: "tc-1", output: { key: "BSADAPT-1" } }
    ])} />);
    expect(screen.getByText("createJiraIssue")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("marks tool-use as 执行中 when no result is paired", () => {
    render(<QoderMessageView message={qoderMessage([
      { driverId: "qoder", type: "qoder.tool-use", toolCallId: "tc-2", name: "searchConfluence", input: { query: "jira" } }
    ])} isAnimating />);
    expect(screen.getByText("searchConfluence")).toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();
  });

  it("marks tool-use as 执行失败 when result is paired and isError", () => {
    render(<QoderMessageView message={qoderMessage([
      { driverId: "qoder", type: "qoder.tool-use", toolCallId: "tc-3", name: "createJiraIssue", input: {} },
      { driverId: "qoder", type: "qoder.tool-result", toolCallId: "tc-3", output: { error: "rate limit" }, isError: true }
    ])} />);
    expect(screen.getByText("执行失败")).toBeInTheDocument();
  });

  it("renders multiple parts in order, including session badge and text", () => {
    render(<QoderMessageView message={qoderMessage([
      { driverId: "qoder", type: "qoder.session", sessionId: "sess-abcdef123456" },
      { driverId: "qoder", type: "qoder.thinking", text: "分析中" },
      { driverId: "qoder", type: "text", text: "已为你创建任务" }
    ])} />);
    // session badge 在多 part 列表里被识别(用 function matcher 兼容可能的文本节点拆分)
    expect(screen.getByText((content) => content.includes("sess-abcdef"))).toBeInTheDocument();
    // thinking 折叠 trigger
    expect(screen.getByText("思考中…")).toBeInTheDocument();
    expect(screen.getByText("已为你创建任务")).toBeInTheDocument();
  });
});
