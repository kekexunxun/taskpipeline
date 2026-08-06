/**
 * ToolSource — 任务创建后端以通用形态向 chat driver 暴露工具。
 *
 * 背景：
 *  旧实现里每个 chat driver 都要单独写一份"任务创建工具包装":
 *  - OpenAI driver: `openAITaskTools` 把 Jira 工具转成 `aiTool(...)`;
 *  - Qoder driver: `qoderTaskServer` 把 Jira 工具转成 `qoderTool(...)` + `createSdkMcpServer`。
 *  同一份 Jira 工具声明要写两遍,后端切换 (Jira → GitHub → Linear) 时
 *  还要去两个 driver 各改一次。
 *
 * 设计：
 *  - `ToolSource` 是 driver-agnostic 的工具描述:systemPrompt + 通用 ToolDeclaration 列表 + describeResult。
 *  - driver 在 streamChat 时接 `toolSource`,自己负责把 ToolDeclaration 翻译成自己 SDK 的 tool 协议。
 *  - 工具执行结果先经过 `ToolSource.describeResult(output)`,driver 拿到 `TaskCreatedResult` 后通过
 *    `StreamChatInput.onTaskCreated` 回调给 ChatService,后者写入消息元数据。
 */

import type { z } from "zod";
import type { ChatTaskCreationResult } from "../chat-types.js";

/**
 * driver-agnostic 工具声明。
 *
 * - `schema` 是一组 zod 字段(单层 record,不需要 z.object 包装,driver 自己组合);
 * - `annotations` 跨 SDK 通用(readOnlyHint / destructiveHint / openWorldHint);
 * - `execute` 由 driver 在自己的执行环境里调用(ai-sdk: 由 ai 决定调用;Qoder MCP: 在 CLI 子进程里调用)。
 */
export type ToolDeclaration = {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

/**
 * 工具集来源 — 通常由 `TaskCreationBackend.toToolSource()` 返回。
 *
 * - `systemPrompt()`: driver 直接拼到自己的 system prompt 后面;
 * - `tools()`: driver 翻译成自己 SDK 的 tool 协议;
 * - `describeResult(output)`: driver 把工具执行结果回传,ToolSource 决定这次调用是否创建了任务;
 *   返回 `undefined` 表示这个结果不是任务创建,driver 继续按普通 tool-result 走。
 */
export interface ToolSource {
  readonly id: "jira" | "github" | "linear";
  readonly displayName: string;
  systemPrompt(): string;
  tools(): ToolDeclaration[];
  /**
   * driver 在 tool 执行完后调用,后端判断这次执行是否产生了"任务已创建"事件。
   * 返回 `undefined` 表示没有任务创建(普通查询/读操作)。
   */
  describeResult(output: unknown): ChatTaskCreationResult | undefined;
  /** 释放后端资源(MCP client / HTTP pool)。 */
  close(): void;
}
