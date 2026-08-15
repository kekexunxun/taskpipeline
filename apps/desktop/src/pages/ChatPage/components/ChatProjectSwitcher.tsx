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
  // 查找当前 value 所属 group
  const selectedGroup = groups.find((g) => g.directories.includes(value ?? ''))
  const selectedName = selectedGroup
    ? selectedGroup.chatType === 'workspace'
      ? selectedGroup.name
      : baseName(selectedGroup.directories[0]!)
    : value
      ? baseName(value)
      : undefined

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
      <DropdownMenuContent align="start" className="w-56">
        <div className="max-h-52 scrollbar-thin overflow-y-auto">
          {groups.map((group) => {
            const isWorkspace = group.chatType === 'workspace'
            const label = isWorkspace ? group.name : baseName(group.directories[0]!)
            const isActive = group.directories.includes(value ?? '')
            return (
              <DropdownMenuItem
                key={group.id}
                onClick={() => onChange(group.directories[0])}
                className={isActive ? 'bg-accent' : ''}
              >
                {isWorkspace ? (
                  <FoldersIcon size={12} className="mr-1.5 shrink-0 text-blue-400/80" />
                ) : (
                  <FolderIcon size={12} className="mr-1.5 shrink-0 text-amber-400/80" />
                )}
                <span className="truncate text-xs">{label}</span>
              </DropdownMenuItem>
            )
          })}
          {groups.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">暂无项目目录</div>
          )}
        </div>
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
          <span className="text-xs">不绑定项目</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
