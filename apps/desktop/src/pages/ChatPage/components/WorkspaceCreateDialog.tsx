import { useCallback, useState } from 'react'
import { FolderIcon, PlusIcon, XIcon } from 'lucide-react'
import { api } from '@/api'
import type { ChatGroup } from '@/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useFeedback } from '@/hooks/useGlobalFeedback'

function baseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

export function WorkspaceCreateDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onCreated(group: ChatGroup): void
}) {
  const { showError } = useFeedback()
  const [name, setName] = useState('')
  const [directories, setDirectories] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  const handleAddDirectories = useCallback(async () => {
    try {
      const dirs = await api.chooseDirectories()
      if (dirs.length > 0) {
        setDirectories((prev) => {
          const existing = new Set(prev)
          return [...prev, ...dirs.filter((d) => !existing.has(d))]
        })
      }
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [showError])

  const handleRemoveDirectory = (dir: string) => {
    setDirectories((prev) => prev.filter((d) => d !== dir))
  }

  const handleCreate = async () => {
    if (!name.trim()) {
      showError('请输入工作区名称')
      return
    }
    if (directories.length < 2) {
      showError('请至少选择 2 个目录')
      return
    }
    setCreating(true)
    try {
      const group = await api.createChatWorkspace(name.trim(), directories)
      onCreated(group)
      // 重置表单
      setName('')
      setDirectories([])
      onOpenChange(false)
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCreating(false)
    }
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      // 关闭时重置表单
      setName('')
      setDirectories([])
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>创建工作区</DialogTitle>
          <DialogDescription>将多个项目目录组合为一个工作区，用于跨项目对话。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* 工作区名称 */}
          <div className="flex flex-col space-y-2">
            <label htmlFor="workspace-name" className="text-xs font-medium">
              工作区名称
            </label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：前端项目、后端服务"
              className="h-8 text-xs!"
            />
          </div>

          {/* 目录列表 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="workspace-dirs" className="text-xs font-medium">
                项目目录
              </label>
              <span className="text-[10px] text-muted-foreground">至少 2 个目录</span>
            </div>
            {/* 已添加文件夹区域 */}
            <div id="workspace-dirs" className="min-h-[80px] space-y-1 rounded-md border bg-muted/30 p-2">
              {directories.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  点击下方按钮添加文件夹
                </div>
              ) : (
                directories.map((dir) => (
                  <div key={dir} className="group flex items-center gap-2 rounded-md bg-background px-2 text-xs">
                    <FolderIcon size={12} className="shrink-0 text-amber-400/80" />
                    <span className="min-w-0 flex-1 truncate" title={dir}>
                      {baseName(dir)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-4 w-4 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={() => handleRemoveDirectory(dir)}
                    >
                      <XIcon size={10} />
                    </Button>
                  </div>
                ))
              )}
            </div>
            {/* 添加文件夹按钮 */}
            <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs" onClick={handleAddDirectories}>
              <PlusIcon size={12} />
              添加文件夹
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={creating || !name.trim() || directories.length < 2}>
            {creating ? '创建中...' : '创建工作区'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
