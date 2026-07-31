import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { useChat } from "./hooks/useChat";
import { ChatHistoryList } from "./components/ChatHistoryList";
import { ChatConversation } from "./components/ChatConversation";
import { ChatComposer } from "./components/ChatComposer";
import { ChatModelSelector } from "./components/ChatModelSelector";

export default function ChatPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const chat = useChat();

  // URL → state
  useEffect(() => {
    if (conversationId && conversationId !== chat.activeId) void chat.select(conversationId);
    if (!conversationId && chat.activeId) navigate(`/chat/${chat.activeId}`, { replace: true });
  }, [conversationId, chat, navigate]);

  const handleCreate = async () => {
    // 当前若已是一个尚未发送任何消息的"新对话",不要重复创建,聚焦到输入框即可。
    if (chat.activeId && chat.conversation && chat.conversation.messages.length === 0) {
      const textarea = document.querySelector<HTMLTextAreaElement>(".chat-composer-input");
      textarea?.focus();
      return;
    }
    // 否则真的创建新对话,并跳转到它。
    const newId = await chat.create();
    if (newId) navigate(`/chat/${newId}`);
  };

  const handleSelect = (id: string) => {
    navigate(`/chat/${id}`);
  };

  const hasModel = chat.modelGroups.length > 0;

  return (
    <div className="chat-shell">
      <ChatHistoryList
        metas={chat.metas}
        activeId={chat.activeId}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onDelete={(id) => void chat.remove(id)}
      />
      <section className="chat-main">
        <header className="chat-header">
          <div>
            <h3>{chat.conversation?.title ?? "选择一个对话"}</h3>
            <small>{chat.conversation?.messageCount ?? 0} 条消息 · {hasModel ? `${chat.modelGroups.length} 个 Provider` : "未配置模型"}</small>
          </div>
        </header>
        <ChatConversation messages={chat.conversation?.messages ?? []} />
        <div className="chat-composer-wrap">
          {!hasModel && (
            <div className="chat-config-hint">
              <Sparkles size={14} /> 请先在「编码 → 顶栏设置 → 模型」中配置 Qoder 或 OpenAI-Compatible 模型。
            </div>
          )}
          <ChatComposer
            value={chat.draft}
            onChange={chat.setDraft}
            onSend={() => void chat.send()}
            onStop={() => void chat.stop()}
            disabled={!hasModel}
            streaming={chat.streaming}
            leftSlot={<ChatModelSelector groups={chat.modelGroups} value={chat.model} onChange={chat.setModel} disabled={chat.streaming} />}
          />
        </div>
      </section>
    </div>
  );
}
