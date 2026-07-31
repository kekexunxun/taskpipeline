import { Trash2 } from "lucide-react";
import type { ChatConversationMeta } from "../../../api";
import { formatRelative } from "../../../utils/format";

export function ChatHistoryItem({ meta, active, onClick, onDelete }: { meta: ChatConversationMeta; active: boolean; onClick(): void; onDelete(): void }) {
  return (
    <div className={`chat-history-item ${active ? "active" : ""}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } }}>
      <div className="chat-history-item-title">{meta.title || "新对话"}</div>
      <div className="chat-history-item-meta">
        <span>{formatRelative(meta.updatedAt)}</span>
        <button className="chat-history-item-delete" title="删除" onClick={(event) => { event.stopPropagation(); onDelete(); }}><Trash2 size={12} /></button>
      </div>
    </div>
  );
}
