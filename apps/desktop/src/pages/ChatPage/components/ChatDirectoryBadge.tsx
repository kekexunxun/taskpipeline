import { FolderIcon } from 'lucide-react'

/**
 * 当前会话的工作目录展示(只读)。
 *
 * 仅展示归属目录信息,不提供绑定/更换/解绑操作 —— 会话归属在会话列表的
 * 项目分组中管理,这里只是让用户知道当前会话在哪个目录下执行。
 */
export function ChatDirectoryBadge({ workingDirectory }: { workingDirectory: string }) {
  const name = workingDirectory.split(/[\\/]/).filter(Boolean).pop() ?? workingDirectory
  return (
    <span
      className="inline-flex max-w-48 items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
      title={`工作目录: ${workingDirectory}`}
      aria-label={`工作目录: ${workingDirectory}`}
    >
      <FolderIcon size={10} className="shrink-0 opacity-70" />
      <span className="truncate">{name}</span>
    </span>
  )
}
