import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ChatHistoryList } from "./components/ChatHistoryList";
import { ChatConversation } from "./components/ChatConversation";
import { ChatComposer } from "./components/ChatComposer";
import { ChatModelSelector } from "./components/ChatModelSelector";
import { useChat } from "./hooks/useChat";

export default function ChatPage() {
  return (
    <ErrorBoundary scope="对话面板加载失败">
      <ChatPageInner />
    </ErrorBoundary>
  );
}

function ChatPageInner() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const chat = useChat();

  // URL ↔ state 同步
  useEffect(() => {
    if (conversationId && conversationId !== chat.activeId) {
      void chat.select(conversationId);
    } else if (!conversationId && chat.activeId) {
      // 离开 /chat/:id 时清理当前对话
      void chat.select(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const create = async () => {
    if (chat.activeId && chat.conversation?.messages.length === 0) {
      document.querySelector<HTMLTextAreaElement>("[data-testid=chat-composer]")?.focus();
      return;
    }
    const id = await chat.create();
    if (id) navigate(`/chat/${id}`);
  };

  const handleSend = async (value: string) => {
    const wasEmpty = !chat.activeId;
    const newId = await chat.send(value);
    if (newId && wasEmpty) navigate(`/chat/${newId}`);
  };

  const hasModel = chat.modelGroups.some((group) => group.models.length);
  const isEmpty = !chat.activeId;
  const headerSubtitle = isEmpty
    ? "输入消息即可自动创建新对话"
    : `${chat.messages.length} 条消息 · ${hasModel ? `${chat.modelGroups.length} 个 Provider` : "未配置模型"}`;

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[288px_minmax(0,1fr)] bg-background">
      <ChatHistoryList
        metas={chat.metas}
        activeId={chat.activeId}
        onSelect={(id) => navigate(`/chat/${id}`)}
        onCreate={() => void create()}
        onDelete={(id) => void chat.remove(id)}
      />
      <section className="grid min-w-0 grid-rows-[52px_minmax(0,1fr)_auto] overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b px-5">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight">
              {chat.conversation?.title ?? "新建对话"}
            </h1>
            <p className="truncate text-xs text-muted-foreground mt-1">
              {headerSubtitle}
            </p>
          </div>
          {chat.streaming && (
            <span className="inline-flex items-center gap-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">
              <span className="inline-block size-1.5 animate-caret-blink rounded-full bg-current" />
              生成中
            </span>
          )}
        </header>

        <ChatConversation messages={chat.messages} streaming={chat.streaming} />

        <div className="shrink-0 border-t bg-background/95 px-4 pb-2.5 pt-2">
          <ChatComposer
            value={chat.draft}
            onChange={chat.setDraft}
            onSend={handleSend}
            onStop={() => void chat.stop()}
            disabled={!hasModel}
            placeholder={
              !hasModel
                ? "请先在设置中配置可用模型"
                : isEmpty
                ? "输入消息，Enter 发送，将自动创建新对话"
                : undefined
            }
            streaming={chat.streaming}
            leftSlot={
              <ChatModelSelector
                groups={chat.modelGroups}
                value={chat.model}
                onChange={chat.setModel}
                disabled={chat.streaming}
              />
            }
          />
        </div>
      </section>
    </div>
  );
}
