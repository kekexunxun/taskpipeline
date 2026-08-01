import { MessageSquareIcon, Trash2Icon } from "lucide-react";
import type { ChatConversationMeta } from "@/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/utils/format";

export function ChatHistoryItem({
  meta,
  active,
  onClick,
  onDelete
}: {
  meta: ChatConversationMeta;
  active: boolean;
  onClick(): void;
  onDelete(): void;
}) {
  return (
    <div
      className={cn(
        "group relative rounded-md border border-transparent px-2.5 py-2 transition-colors hover:bg-accent/60",
        active && "border-border bg-accent"
      )}
    >
      <button
        className="flex w-full min-w-0 items-start gap-2 pr-6 text-left"
        onClick={onClick}
      >
        <MessageSquareIcon
          className={cn(
            "mt-0.5 shrink-0 text-muted-foreground",
            active && "text-foreground"
          )}
          size={13}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {meta.title || "新对话"}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {formatRelative(meta.updatedAt)} · {meta.messageCount} 条
          </span>
        </span>
      </button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`删除对话 ${meta.title}`}
            className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
            onClick={(event) => event.stopPropagation()}
          >
            <Trash2Icon size={12} />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除对话？</AlertDialogTitle>
            <AlertDialogDescription>
              "{meta.title}"及其中的消息将从本机删除，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
