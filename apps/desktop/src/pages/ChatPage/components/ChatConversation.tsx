import { useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import type { ChatMessage as ChatMessageT } from "../../../api";
import { ChatMessageView } from "./ChatMessage";

export function ChatConversation({ messages }: { messages: ChatMessageT[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.length, messages[messages.length - 1]?.content]);
  if (messages.length === 0) {
    return (
      <div className="chat-conversation">
        <div className="chat-empty">
          <Sparkles size={28} />
          <strong>开始一次新对话</strong>
          <span>支持自由问答、代码解释、重构建议等</span>
        </div>
      </div>
    );
  }
  return (
    <div className="chat-conversation">
      {messages.map((m) => <ChatMessageView key={m.id} message={m} />)}
      <div ref={endRef} />
    </div>
  );
}
