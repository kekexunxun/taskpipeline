import { PlusIcon } from "lucide-react";
import type { ChatConversationMeta } from "@/api";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatHistoryItem } from "./ChatHistoryItem";

export function ChatHistoryList({
  metas,
  activeId,
  onSelect,
  onCreate,
  onDelete
}: {
  metas: ChatConversationMeta[];
  activeId?: string;
  onSelect(id: string): void;
  onCreate(): void;
  onDelete(id: string): void;
}) {
  return (
    <aside className="grid min-h-0 w-72 grid-rows-[auto_auto_minmax(0,1fr)] border-r bg-card/50">
      <div className="flex h-14 items-end justify-between gap-2 px-4 pb-2 pt-3">
        <div className="leading-tight">
          <h2 className="text-base font-semibold tracking-tight">对话</h2>
          <p className="text-xs text-muted-foreground">{metas.length} 个本地会话</p>
        </div>
      </div>
      <div className="px-3 pb-3">
        <Button size="sm" className="w-full gap-1 px-2.5 h-7" onClick={onCreate}>
          <PlusIcon size={12} strokeWidth={2} />
          新建对话
        </Button>
      </div>
      <ScrollArea className="min-h-0">
        <div className="space-y-1 px-2 pb-4">
          {metas.length === 0 ? (
            <div className="px-2 py-8 text-center text-xs leading-5 text-muted-foreground">
              还没有对话
              <br />
              从一个具体问题开始
            </div>
          ) : (
            metas.map((meta) => (
              <ChatHistoryItem
                key={meta.id}
                meta={meta}
                active={meta.id === activeId}
                onClick={() => onSelect(meta.id)}
                onDelete={() => onDelete(meta.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
