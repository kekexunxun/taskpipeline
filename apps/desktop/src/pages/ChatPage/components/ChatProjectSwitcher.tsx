import { ChevronDownIcon, FolderIcon, FoldersIcon, PlusIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ChatGroup } from '@/api'

function baseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

export function ChatProjectSwitcher({
  groups,
  value,
  onChange,
  onAdd,
  onSetupWorkspace,
  disabled
}: {
  groups: ChatGroup[]
  /** 当前选中的目录，undefined 表示未选择 */
  value?: string
  onChange(directory: string | undefined): void
  onAdd(): void
  onSetupWorkspace(): void
  disabled?: boolean
}) {
  // 查找当前 value 属于哪个 group
  const selectedGroup = groups.find((g) => g.directories.includes(value ?? ''))
  const selectedName = selectedGroup
    ? selectedGroup.chatType === 'workspace'
      ? selectedGroup.name
      : baseName(selectedGroup.directories[0]!)
    : value
      ? baseName(value)
      : undefined

  const workspaceGroups = groups.filter((g) => g.chatType === 'workspace')
  const directoryGroups = groups.filter((g) => g.chatType === 'directory')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground" disabled={disabled}>
          {selectedGroup?.chatType === 'workspace' ? (
            <FoldersIcon size={12} className="shrink-0 text-blue-400/80" />
          ) : (
            <FolderIcon size={12} className="shrink-0" />
          )}
          <span className="max-w-64 truncate">{selectedName ?? '选择项目目录'}</span>
          <ChevronDownIcon size={12} className="shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {/* 工作区列表 */}
        {workspaceGroups.length > 0 && (
          <>
            {workspaceGroups.map((group) => (
              <DropdownMenuItem
                key={group.id}
                onClick={() => onChange(group.directories[0])}
                className={group.directories.includes(value ?? '') ? 'bg-accent' : ''}
              >
                <FoldersIcon size={12} className="mr-1.5 shrink-0 text-blue-400/80" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">{group.name}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{group.directories.length} 个目录</div>
                </div>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {/* 目录分组列表 */}
        {directoryGroups.length === 0 && !value ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">暂无项目目录</div>
        ) : (
          directoryGroups.map((group) => {
            const dir = group.directories[0]!
            return (
              <DropdownMenuItem
                key={group.id}
                onClick={() => onChange(dir)}
                className={value === dir ? 'bg-accent' : ''}
              >
                <FolderIcon size={12} className="mr-1.5 shrink-0 text-amber-400/80" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">{baseName(dir)}</div>
                  <div className="truncate text-[10px] text-muted-foreground" title={dir}>
                    {dir}
                  </div>
                </div>
              </DropdownMenuItem>
            )
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onAdd}>
          <PlusIcon size={12} className="mr-1.5" />
          <span className="text-xs">添加项目目录…</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onSetupWorkspace}>
          <FoldersIcon size={12} className="mr-1.5" />
          <span className="text-xs">设置工作区…</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onChange(undefined)}>
          <XIcon size={12} className="mr-1.5" />
          <span className="text-xs text-muted-foreground">不绑定项目</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
