import { FolderIcon, FolderOpenIcon, FoldersIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { ChatHistoryItem } from './ChatHistoryItem'
import type { ChatConversationMeta, ChatGroup } from '@/api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

/** 目录名取路径最后一段。 */
function baseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

type Group = {
  /** 关联的 ChatGroup 实体;无值 = 普通对话组。 */
  chatGroup?: ChatGroup
  lastActiveAt: string
  items: ChatConversationMeta[]
}

/**
 * 按 ChatGroup 把会话分组:
 *  - workspace group: 组内 directories 包含会话的 workingDirectory → 归入该组
 *  - directory group: 会话的 workingDirectory 匹配 group.directories[0] → 归入该组
 *  - 不属于任何 group 的会话 → 普通对话组
 * 组间按 updatedAt 倒序,组内按 updatedAt 倒序。
 */
function groupMetas(metas: ChatConversationMeta[], groups: ChatGroup[]): Group[] {
  const byRecent = (a: ChatConversationMeta, b: ChatConversationMeta) => b.updatedAt.localeCompare(a.updatedAt)

  // 收集已被 group 匹配的会话 id
  const claimed = new Set<string>()
  const groupList: Group[] = []

  for (const group of groups) {
    const items: ChatConversationMeta[] = []
    for (const meta of metas) {
      if (!meta.workingDirectory) continue
      if (group.directories.includes(meta.workingDirectory)) {
        items.push(meta)
        claimed.add(meta.id)
      }
    }
    items.sort(byRecent)
    const lastActiveAt = items[0]?.updatedAt ?? group.updatedAt
    groupList.push({ chatGroup: group, lastActiveAt, items })
  }

  // 未归组的会话 → 普通对话
  const plain = metas.filter((m) => !claimed.has(m.id))
  const result = groupList.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))

  if (plain.length) {
    const sorted = [...plain].sort(byRecent)
    result.push({ lastActiveAt: sorted[0]!.updatedAt, items: sorted })
  }
  return result
}

export function ChatHistoryList({
  metas,
  groups,
  activeId,
  streamingChatIds,
  onSelect,
  onCreate,
  onCreateInDirectory,
  onShowWelcome,
  onDelete,
  onDeleteGroup
}: {
  metas: ChatConversationMeta[]
  /** 统一分组列表(目录 + 工作区)。 */
  groups: ChatGroup[]
  activeId?: string
  /** 正在生成的对话集合(并行流),用于侧边栏生成状态指示。 */
  streamingChatIds?: ReadonlySet<string>
  onSelect(id: string): void
  /** 新建普通对话。 */
  onCreate(): void
  /** 在指定工作目录下新建会话。 */
  onCreateInDirectory(directory: string): void
  /** 显示欢迎页(不创建对话记录)。 */
  onShowWelcome(): void
  onDelete(id: string): void
  onDeleteGroup(id: string): void
}) {
  const groupedItems = groupMetas(metas, groups)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [deletingGroup, setDeletingGroup] = useState<ChatGroup | null>(null)

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const groupName = deletingGroup
    ? deletingGroup.chatType === 'workspace'
      ? deletingGroup.name
      : baseName(deletingGroup.directories[0]!)
    : ''
  const groupItemCount = deletingGroup ? (groupMetas(metas, [deletingGroup])[0]?.items.length ?? 0) : 0

  return (
    <>
      <aside className="grid min-h-0 w-72 grid-rows-[auto_auto_minmax(0,1fr)] border-r bg-card/50">
        <div className="flex h-14 items-end justify-between gap-2 px-4 pt-3 pb-2">
          <div className="leading-tight">
            <h2 className="text-base font-semibold tracking-tight">对话</h2>
            <p className="text-xs text-muted-foreground">{metas.length} 个本地会话</p>
          </div>
        </div>
        <div className="px-3 pb-2">
          <Button
            variant="outline"
            className="flex h-8 w-full items-center justify-center gap-2 shadow-none"
            onClick={onShowWelcome}
          >
            <PlusIcon size={16} />
            <span className="text-sm">新建对话</span>
          </Button>
        </div>
        <ScrollArea className="min-h-0">
          <div className="w-0 min-w-full space-y-2 px-2 pb-4">
            {groupedItems.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs leading-5 text-muted-foreground">
                还没有对话
                <br />
                从一个具体问题开始
              </div>
            ) : (
              groupedItems.map((group) => {
                const groupKey = group.chatGroup?.id ?? '__plain__'
                const isCollapsed = collapsed.has(groupKey)
                const cg = group.chatGroup
                return (
                  <div key={groupKey} className={cn('min-w-0', !cg && 'border-t pt-2')}>
                    {/* 分组头 — 点击可折叠/展开 */}
                    <div
                      role="button"
                      tabIndex={0}
                      className="group/header flex w-full items-center gap-1.5 rounded px-2 py-1 text-left transition-colors hover:bg-accent/40"
                      onClick={() => toggleCollapse(groupKey)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleCollapse(groupKey)
                        }
                      }}
                    >
                      {cg ? (
                        <>
                          {cg.chatType === 'workspace' ? (
                            <>
                              {isCollapsed ? (
                                <FoldersIcon size={12} className="shrink-0 text-muted-foreground/60" />
                              ) : (
                                <FolderOpenIcon size={12} className="shrink-0 text-muted-foreground/60" />
                              )}
                              <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={cg.name}>
                                {cg.name}
                              </span>
                              {/* <span className="shrink-0 text-[10px] text-muted-foreground">{group.items.length}</span> */}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-5 w-5 text-muted-foreground/70 opacity-0 group-hover/header:opacity-100"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onCreateInDirectory(cg.directories[0]!)
                                }}
                                title="在此工作区新建对话"
                                aria-label="在此工作区新建对话"
                              >
                                <PlusIcon size={11} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-5 w-5 text-muted-foreground/70 opacity-0 group-hover/header:opacity-100 hover:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDeletingGroup(cg)
                                }}
                                title="删除此工作区"
                                aria-label="删除此工作区"
                              >
                                <Trash2Icon size={11} />
                              </Button>
                            </>
                          ) : (
                            <>
                              {isCollapsed ? (
                                <FolderIcon size={12} className="shrink-0 text-muted-foreground/60" />
                              ) : (
                                <FolderOpenIcon size={12} className="shrink-0 text-muted-foreground/60" />
                              )}
                              <span
                                className="min-w-0 flex-1 truncate text-xs font-semibold"
                                title={cg.directories[0]!}
                              >
                                {baseName(cg.directories[0]!)}
                              </span>
                              {/* <span className="shrink-0 text-[10px] text-muted-foreground">{group.items.length}</span> */}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-5 w-5 text-muted-foreground/70 opacity-0 group-hover/header:opacity-100"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onCreateInDirectory(cg.directories[0]!)
                                }}
                                title={`在此目录新建对话\n${cg.directories[0]!}`}
                                aria-label={`在 ${baseName(cg.directories[0]!)} 新建对话`}
                              >
                                <PlusIcon size={11} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-5 w-5 text-muted-foreground/70 opacity-0 group-hover/header:opacity-100 hover:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDeletingGroup(cg)
                                }}
                                title="删除此目录分组"
                                aria-label="删除此目录分组"
                              >
                                <Trash2Icon size={11} />
                              </Button>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-muted-foreground">
                            普通对话
                          </span>
                          {/* <span className="ml-auto text-[10px] text-muted-foreground/70">{group.items.length}</span> */}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-5 w-5 text-muted-foreground/70 opacity-0 group-hover/header:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation()
                              onCreate()
                            }}
                            title="新建普通对话"
                            aria-label="新建普通对话"
                          >
                            <PlusIcon size={11} />
                          </Button>
                        </>
                      )}
                    </div>
                    {/* 折叠时隐藏子项 */}
                    {!isCollapsed && group.items.length > 0 && (
                      <div className="mt-0.5 space-y-0.5">
                        {group.items.map((meta) => (
                          <ChatHistoryItem
                            key={meta.id}
                            meta={meta}
                            active={meta.id === activeId}
                            streaming={streamingChatIds?.has(meta.id)}
                            onClick={() => onSelect(meta.id)}
                            onDelete={() => onDelete(meta.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>
      </aside>

      <AlertDialog open={!!deletingGroup} onOpenChange={(open) => !open && setDeletingGroup(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除分组？</AlertDialogTitle>
            <AlertDialogDescription>
              {groupItemCount > 0
                ? `将删除「${groupName}」分组，其下 ${groupItemCount} 个对话不会被删除，将变为未分组状态。`
                : `将删除「${groupName}」分组，该分组下没有对话。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deletingGroup) onDeleteGroup(deletingGroup.id)
                setDeletingGroup(null)
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
