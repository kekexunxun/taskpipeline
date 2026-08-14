import { FolderIcon, FolderOpenIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { ChatHistoryItem } from './ChatHistoryItem'
import type { ChatConversationMeta, ChatProject } from '@/api'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

/** 目录名取路径最后一段。 */
function baseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

type Group = {
  /** 有值 = 项目组(该工作目录下的会话);无值 = 普通对话组。 */
  directory?: string
  /** 项目组排序/展示用的最近活动时间(会话或项目自身的 lastActiveAt)。 */
  lastActiveAt: string
  items: ChatConversationMeta[]
}

/**
 * 按工作目录把会话分组:一个目录(项目)下可挂多个会话,普通对话归入末尾一组。
 * 项目实体与具体会话解耦 —— 目录下所有会话被删除后,项目组仍保留(items 为空),
 * 显示「没有对话」,方便原地新建对话。
 * 组间按最近活动排序(项目组取会话最新活动或项目 lastActiveAt),组内按更新时间倒序。
 */
function groupMetas(metas: ChatConversationMeta[], projects: ChatProject[]): Group[] {
  const byDir = new Map<string, ChatConversationMeta[]>()
  const plain: ChatConversationMeta[] = []
  for (const meta of metas) {
    if (meta.workingDirectory) {
      const list = byDir.get(meta.workingDirectory) ?? []
      list.push(meta)
      byDir.set(meta.workingDirectory, list)
    } else {
      plain.push(meta)
    }
  }
  const byRecent = (a: ChatConversationMeta, b: ChatConversationMeta) => b.updatedAt.localeCompare(a.updatedAt)
  const groups: Group[] = projects
    .map((project) => {
      const items = (byDir.get(project.directory) ?? []).sort(byRecent)
      // 有会话的项目组用会话最新活动排序;空项目组用项目自身的 lastActiveAt。
      const lastActiveAt = items[0]?.updatedAt ?? project.lastActiveAt
      return { directory: project.directory, lastActiveAt, items }
    })
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  if (plain.length) {
    const sorted = [...plain].sort(byRecent)
    groups.push({ lastActiveAt: sorted[0]!.updatedAt, items: sorted })
  }
  return groups
}

export function ChatHistoryList({
  metas,
  projects,
  activeId,
  streamingChatIds,
  onSelect,
  onCreate,
  onCreateInDirectory,
  onDelete,
  onDeleteDirectory
}: {
  metas: ChatConversationMeta[]
  /** 项目(工作目录)实体列表,与具体会话解耦。 */
  projects: ChatProject[]
  activeId?: string
  /** 正在生成的对话集合(并行流),用于侧边栏生成状态指示。 */
  streamingChatIds?: ReadonlySet<string>
  onSelect(id: string): void
  /** 新建普通对话。 */
  onCreate(): void
  /** 在指定工作目录下新建会话。 */
  onCreateInDirectory(directory: string): void
  onDelete(id: string): void
  /** 删除整个文件夹(目录下所有会话)。 */
  onDeleteDirectory(directory: string): void
}) {
  const groups = groupMetas(metas, projects)
  /** 记录已收起(折叠)的分组 key,默认全部展开。 */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

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

  return (
    <aside className="grid min-h-0 w-72 grid-rows-[auto_minmax(0,1fr)] border-r bg-card/50">
      <div className="flex h-14 items-end justify-between gap-2 px-4 pt-3 pb-2">
        <div className="leading-tight">
          <h2 className="text-base font-semibold tracking-tight">对话</h2>
          <p className="text-xs text-muted-foreground">{metas.length} 个本地会话</p>
        </div>
      </div>
      <ScrollArea className="min-h-0">
        <div className="w-0 min-w-full space-y-2 px-2 pb-4">
          {groups.length === 0 ? (
            <div className="px-2 py-8 text-center text-xs leading-5 text-muted-foreground">
              还没有对话
              <br />
              从一个具体问题开始
            </div>
          ) : (
            groups.map((group) => {
              const groupKey = group.directory ?? '__plain__'
              const isCollapsed = collapsed.has(groupKey)
              return (
                <div key={groupKey} className={cn('min-w-0', !group.directory && 'border-t pt-2')}>
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
                    {isCollapsed ? (
                      <FolderIcon size={12} className="shrink-0 text-muted-foreground/60" />
                    ) : (
                      <FolderOpenIcon size={12} className="shrink-0 text-muted-foreground/60" />
                    )}
                    {group.directory ? (
                      <>
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={group.directory}>
                          {baseName(group.directory)}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{group.items.length}</span>
                        <AlertDialog>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-5 w-5 text-muted-foreground/70 opacity-0 group-hover/header:opacity-100"
                            onClick={(e) => e.stopPropagation()}
                            title={`删除此目录及其下所有对话\n${group.directory}`}
                            aria-label={`删除 ${baseName(group.directory)}`}
                            asChild
                          >
                            <AlertDialogTrigger>
                              <Trash2Icon size={11} />
                            </AlertDialogTrigger>
                          </Button>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>删除文件夹？</AlertDialogTitle>
                              <AlertDialogDescription>
                                「{baseName(group.directory)}」下的 {group.items.length}{' '}
                                个对话及其消息将从本机删除，此操作无法撤销。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction onClick={() => onDeleteDirectory(group.directory!)}>
                                删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="h-5 w-5 text-muted-foreground/70 opacity-0 group-hover/header:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation()
                            onCreateInDirectory(group.directory!)
                          }}
                          title={`在此目录新建对话\n${group.directory}`}
                          aria-label={`在 ${baseName(group.directory)} 新建对话`}
                        >
                          <PlusIcon size={11} />
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="text-xs font-semibold text-muted-foreground">普通对话</span>
                        <span className="ml-auto text-[10px] text-muted-foreground/70">{group.items.length}</span>
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
  )
}
