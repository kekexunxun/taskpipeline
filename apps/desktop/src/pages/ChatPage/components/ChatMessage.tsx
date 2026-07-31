import { Bot, User2 } from "lucide-react";
import type { ChatMessage as ChatMessageT } from "../../../api";
import { formatTime } from "../../../utils/format";

export function ChatMessageView({ message }: { message: ChatMessageT }) {
  const isUser = message.role === "user";
  const isError = message.status === "error";
  const isStreaming = message.status === "streaming";
  return (
    <article className={`chat-message ${isUser ? "user" : "assistant"} ${isError ? "error" : ""}`}>
      <div className="chat-message-avatar" aria-hidden="true">
        {isUser ? <User2 size={14} /> : <Bot size={14} />}
      </div>
      <div className="chat-message-body">
        <div className="chat-message-author">
          <strong>{isUser ? "你" : "Assistant"}</strong>
          <span className="chat-message-meta">
            <time>{formatTime(message.createdAt)}</time>
            {!isUser && message.model && <em>· {message.model}</em>}
          </span>
        </div>
        <div className={`chat-message-content ${isError ? "error" : ""}`}>
          {message.content ? <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.content}</span> : null}
          {isStreaming && <span className="chat-cursor" aria-hidden="true" />}
        </div>
      </div>
    </article>
  );
}