import { Loader2Icon, MessageSquareIcon, Trash2Icon } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { formatRelative } from '@/utils/format'

export function ChatHistoryItem({
  meta,
  active,
  showDirectory = true,
  streaming,
  onClick,
  onDelete
}: {
  meta: ChatConversationMeta
  active: boolean
  /** 是否在条目内显示目录名(分组场景下组头已显示,传 false 避免重复)。 */
  showDirectory?: boolean
  /** 该对话正在生成中（并行流指示）。 */
  streaming?: boolean
  onClick(): void
  onDelete(): void
}) {
  return (
    <div
      className={cn(
        'group relative rounded-md border border-transparent px-2.5 py-2 transition-colors hover:bg-accent/60',
        active && 'border-border bg-accent'
      )}
    >
      <button className="flex w-full min-w-0 items-start gap-2 pr-6 text-left" onClick={onClick}>
        {streaming ? (
          <Loader2Icon
            className={cn('mt-0.5 size-3.5 shrink-0 animate-spin text-amber-400', active && 'text-amber-500')}
            size={14}
          />
        ) : (
          <MessageSquareIcon
            className={cn('mt-0.5 shrink-0 text-muted-foreground', active && 'text-foreground')}
            size={13}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block max-w-[16em] truncate text-xs font-medium">{meta.title || '新对话'}</span>
          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
            {meta.workingDirectory && showDirectory ? (
              <>
                <span className="text-amber-400/80">{meta.workingDirectory.split(/[\\/]/).filter(Boolean).pop()}</span>
                {' · '}
              </>
            ) : null}
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
            className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
            onClick={(event) => event.stopPropagation()}
          >
            <Trash2Icon size={12} />
          </Button>
        </AlertDialogTrigger>
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
