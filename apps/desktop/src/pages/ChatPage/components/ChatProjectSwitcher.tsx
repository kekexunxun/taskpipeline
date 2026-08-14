import { ChevronDownIcon, FolderIcon, PlusIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ChatProject } from '@/api'

function baseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

export function ChatProjectSwitcher({
  projects,
  value,
  onChange,
  onAdd,
  disabled
}: {
  projects: ChatProject[]
  /** 当前选中的目录，undefined 表示未选择 */
  value?: string
  onChange(directory: string | undefined): void
  onAdd(): void
  disabled?: boolean
}) {
  const selected = projects.find((p) => p.directory === value)
  // 选中的目录可能不在 projects 列表中（刚通过文件选择器选择的）
  const selectedName = selected ? baseName(selected.directory) : value ? baseName(value) : undefined

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground" disabled={disabled}>
          <FolderIcon size={12} className="shrink-0" />
          <span className="max-w-64 truncate">{selectedName ?? '选择项目目录'}</span>
          <ChevronDownIcon size={12} className="shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {value && (
          <>
            <DropdownMenuItem onClick={() => onChange(undefined)}>
              <XIcon size={12} className="mr-1.5" />
              <span className="text-xs text-muted-foreground">清除选择</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {projects.length === 0 && !value ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">暂无项目目录</div>
        ) : (
          projects.map((project) => (
            <DropdownMenuItem
              key={project.directory}
              onClick={() => onChange(project.directory)}
              className={value === project.directory ? 'bg-accent' : ''}
            >
              <FolderIcon size={12} className="mr-1.5 shrink-0 text-amber-400/80" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs">{baseName(project.directory)}</div>
                <div className="truncate text-[10px] text-muted-foreground" title={project.directory}>
                  {project.directory}
                </div>
              </div>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onAdd}>
          <PlusIcon size={12} className="mr-1.5" />
          <span className="text-xs">添加项目目录…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
