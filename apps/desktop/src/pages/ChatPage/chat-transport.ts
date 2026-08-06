import { api, type ChatStreamEvent } from "@/api";

/**
 * 单次 chat 流的回调订阅。
 *
 * 设计:`ElectronChatTransport` 不再依赖 `@ai-sdk/react` 的 ChatTransport / UIMessageChunk。
 * 上层 (useChat) 直接拿到按 streamId 过滤的 ChatStreamChunk 列表,由 useChat 自己拼 parts。
 * 这里只负责:
 *  - 调 `api.startChatStream` 启动流;
 *  - 把 `api.onChatStreamEvent` 的事件按 `streamId` 过滤后投递给 onEvent 回调;
 *  - 暴露 `abort()` 用于主动停止。
 */
export class ElectronChatTransport {
  /**
   * 启动一次流式对话。返回:
   *  - `abort()`: 取消本次流;
   *  - `closed`: Promise,流结束( done / error )后 resolve。
   *
   * 调用方需要把 onEvent 的回调妥善转发到自己的 state。
   */
  start(input: {
    streamId: string;
    chatId: string;
    driverId: "qoder" | "openai";
    model: string;
    message: { id: string; text: string; createdAt: string };
    mode?: "chat" | "task-create";
    onEvent(event: ChatStreamEvent): void;
    onError?(error: Error): void;
  }): { abort(): void; closed: Promise<void> } {
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const close = () => { if (closed) return; closed = true; unsubscribe?.(); };
    const closedPromise = new Promise<void>((resolve) => {
      unsubscribe = api.onChatStreamEvent((event) => {
        if (event.streamId !== input.streamId || event.chatId !== input.chatId) return;
        if (event.error) {
          input.onError?.(new Error(event.error));
          close();
          resolve();
          return;
        }
        input.onEvent(event);
        if (event.done) {
          close();
          resolve();
        }
      });
    });
    void api.startChatStream({
      streamId: input.streamId,
      chatId: input.chatId,
      driverId: input.driverId,
      model: input.model,
      message: input.message,
      mode: input.mode
    }).catch((reason) => {
      if (closed) return;
      const error = reason instanceof Error ? reason : new Error(String(reason));
      input.onError?.(error);
      close();
      closedPromise.then(() => undefined);
    });
    return {
      abort() {
        if (closed) return;
        void api.abortChat({ streamId: input.streamId, chatId: input.chatId });
      },
      closed: closedPromise
    };
  }
}
