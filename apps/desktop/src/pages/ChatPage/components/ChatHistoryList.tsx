import { Plus } from "lucide-react";
import type { ChatConversationMeta } from "../../../api";
import { ChatHistoryItem } from "./ChatHistoryItem";

export function ChatHistoryList({ metas, activeId, onSelect, onCreate, onDelete }: { metas: ChatConversationMeta[]; activeId?: string; onSelect(id: string): void; onCreate(): void; onDelete(id: string): void }) {
  return (
    <aside className="chat-history">
      <div className="chat-history-header">
        <h2>对话历史</h2>
      </div>
      <button className="primary chat-history-new" onClick={onCreate}><Plus size={14} />新建对话</button>
      <div className="chat-history-list">
        {metas.length === 0 && <div className="chat-empty-history">还没有对话，点击上方按钮开始</div>}
        {metas.map((meta) => (
          <ChatHistoryItem
            key={meta.id}
            meta={meta}
            active={meta.id === activeId}
            onClick={() => onSelect(meta.id)}
            onDelete={() => onDelete(meta.id)}
          />
        ))}
      </div>
    </aside>
  );
}
