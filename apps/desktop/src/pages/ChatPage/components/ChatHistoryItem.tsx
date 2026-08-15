import { Loader2Icon, MoreVerticalIcon, Trash2Icon } from 'lucide-react'
import type { ChatConversationMeta } from '@/api'
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
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { formatRelative } from '@/utils/format'

export function ChatHistoryItem({
  meta,
  active,
  streaming,
  onClick,
  onDelete
}: {
  meta: ChatConversationMeta
  active: boolean
  /** 该对话正在生成中（并行流指示）。 */
  streaming?: boolean
  onClick(): void
  onDelete(): void
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50',
        active && 'bg-accent'
      )}
    >
      <button className="flex min-w-0 flex-1 items-center gap-2" onClick={onClick}>
        {streaming && <Loader2Icon size={12} className="shrink-0 animate-spin text-amber-500" />}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left text-xs',
            !streaming && 'pl-[18px]',
            active ? 'font-medium' : 'text-foreground/80',
            streaming && 'text-amber-500'
          )}
        >
          {meta.title || '新对话'}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground/70">{formatRelative(meta.updatedAt)}</span>
      </button>
      <AlertDialog>
        <div className="shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-5 w-5 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                onClick={(event) => event.stopPropagation()}
                aria-label={`对话操作 ${meta.title}`}
              >
                <MoreVerticalIcon size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[6rem]">
              <AlertDialogTrigger asChild>
                <DropdownMenuItem className="text-xs! text-destructive focus:text-destructive">
                  <Trash2Icon size={11} />
                  删除
                </DropdownMenuItem>
              </AlertDialogTrigger>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除对话？</AlertDialogTitle>
            <AlertDialogDescription>"{meta.title}"及其中的消息将从本机删除，此操作无法撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
