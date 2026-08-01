import type { ChatTransport, UIMessageChunk } from "ai";
import { api, type ChatMessage, type ChatStreamEvent } from "@/api";

export class ElectronChatTransport implements ChatTransport<ChatMessage> {
  async sendMessages({ chatId, messages, abortSignal, body }: Parameters<ChatTransport<ChatMessage>["sendMessages"]>[0]): Promise<ReadableStream<UIMessageChunk>> {
    const requestBody = body as Record<string, unknown> | undefined;
    const model = typeof requestBody?.model === "string" ? requestBody.model : undefined;
    const message = messages[messages.length - 1];
    if (!model || !message || message.role !== "user") throw new Error("缺少聊天模型或用户消息");
    const streamId = crypto.randomUUID();
    let cleanup: () => void = () => undefined;
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        let closed = false;
        let off: () => void = () => undefined;
        cleanup = () => { if (closed) return; closed = true; off(); abortSignal?.removeEventListener("abort", onAbort); };
        const close = () => { if (!closed) { cleanup(); controller.close(); } };
        const onAbort = () => { void api.abortChat({ streamId, chatId }); close(); };
        off = api.onChatStreamEvent((event: ChatStreamEvent) => {
          if (event.streamId !== streamId || event.chatId !== chatId || closed) return;
          if (event.error) { cleanup(); controller.error(new Error(event.error)); return; }
          if (event.chunk) controller.enqueue(event.chunk);
          if (event.done) close();
        });
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (abortSignal?.aborted) { onAbort(); return; }
        void api.startChatStream({ streamId, chatId, model, message }).catch((reason) => { if (!closed) { cleanup(); controller.error(reason); } });
      },
      cancel() { cleanup(); void api.abortChat({ streamId, chatId }); }
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> { return null; }
}
