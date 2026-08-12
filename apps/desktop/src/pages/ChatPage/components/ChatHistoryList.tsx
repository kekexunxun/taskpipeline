import { FolderIcon, FolderPlusIcon, MessagesSquareIcon, PlusIcon } from 'lucide-react'
import { ChatHistoryItem } from './ChatHistoryItem'
import type { ChatConversationMeta, ChatProject } from '@/api'
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
  onSelect,
  onCreate,
  onCreateInDirectory,
  onDelete
}: {
  metas: ChatConversationMeta[]
  /** 项目(工作目录)实体列表,与具体会话解耦。 */
  projects: ChatProject[]
  activeId?: string
  onSelect(id: string): void
  /** 新建普通对话。 */
  onCreate(): void
  /** 在指定工作目录(项目)下新建会话;undefined = 弹目录选择器。 */
  onCreateInDirectory(directory?: string): void
  onDelete(id: string): void
}) {
  const groups = groupMetas(metas, projects)

  return (
    <aside className="grid min-h-0 w-72 grid-rows-[auto_auto_minmax(0,1fr)] border-r bg-card/50">
      <div className="flex h-14 items-end justify-between gap-2 px-4 pt-3 pb-2">
        <div className="leading-tight">
          <h2 className="text-base font-semibold tracking-tight">对话</h2>
          <p className="text-xs text-muted-foreground">{metas.length} 个本地会话</p>
        </div>
      </div>
      <div className="px-3 pb-3">
        <Button
          size="sm"
          variant="secondary"
          className="h-7 w-full gap-1 px-2"
          onClick={() => onCreateInDirectory(undefined)}
          title="选择一个本地目录作为项目,在该目录下新建对话"
        >
          <FolderPlusIcon size={12} strokeWidth={2} />
          项目对话
        </Button>
      </div>
      <ScrollArea className="min-h-0">
        <div className="space-y-3 px-2 pb-4">
          {groups.length === 0 ? (
            <div className="px-2 py-8 text-center text-xs leading-5 text-muted-foreground">
              还没有对话
              <br />
              从一个具体问题开始
            </div>
          ) : (
            groups.map((group) => {
              const header = group.directory ? (
                <div className="group flex w-full items-center gap-1.5 rounded px-2 py-1">
                  <FolderIcon size={11} className="shrink-0 text-amber-400/80" />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold" title={group.directory}>
                    {baseName(group.directory)}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{group.items.length}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-5 w-5 text-muted-foreground/70"
                    onClick={() => onCreateInDirectory(group.directory!)}
                    title={`在此目录新建对话\n${group.directory}`}
                    aria-label={`在 ${baseName(group.directory)} 新建对话`}
                  >
                    <PlusIcon size={11} />
                  </Button>
                </div>
              ) : (
                <div className="group flex w-full items-center gap-1.5 px-2 py-1">
                  <MessagesSquareIcon size={11} className="shrink-0 text-muted-foreground/70" />
                  <span className="text-[11px] font-semibold text-muted-foreground">普通对话</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/70">{group.items.length}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-5 w-5 text-muted-foreground/70"
                    onClick={onCreate}
                    title="新建普通对话"
                    aria-label="新建普通对话"
                  >
                    <PlusIcon size={11} />
                  </Button>
                </div>
              )
              return (
                <div
                  key={group.directory ?? '__plain__'}
                  className={cn('space-y-1', !group.directory && 'border-t pt-2')}
                >
                  {header}
                  {group.items.length === 0 ? (
                    <div className="px-2 py-1.5 text-[10px] leading-4 text-muted-foreground/70">
                      没有对话
                      <br />
                      点右侧 + 在此目录新建
                    </div>
                  ) : (
                    group.items.map((meta) => (
                      <ChatHistoryItem
                        key={meta.id}
                        meta={meta}
                        active={meta.id === activeId}
                        showDirectory={false}
                        onClick={() => onSelect(meta.id)}
                        onDelete={() => onDelete(meta.id)}
                      />
                    ))
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
