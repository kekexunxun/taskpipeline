/**
 * 系统设置 → 代码索引 Tab
 *
 * 管理 dataDir/codeindex 下的源码符号索引（codebase_search 工具的数据源）：
 * - 卡片列表展示每个索引的目录、状态、统计数据；
 * - 支持单个重建/删除，以及全部重建/全部清除批量操作；
 * - 索引由 codebase_search 自动触发创建，此处提供可见性和管理能力。
 */

import { useCallback, useEffect, useState } from 'react'
import { DatabaseIcon, FolderOpenIcon, Loader2Icon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { api, type CodeIndexSummary } from '@/api'
import { useFeedback } from '@/hooks/useGlobalFeedback'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

export function CodeIndexSettingsTab() {
  const { showError, showSuccess } = useFeedback()
  const [indexes, setIndexes] = useState<CodeIndexSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [operating, setOperating] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<CodeIndexSummary | undefined>(undefined)
  const [clearAllOpen, setClearAllOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setIndexes(await api.listCodeIndexes())
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  const markOperating = (key: string) => setOperating((prev) => new Set(prev).add(key))
  const unmarkOperating = (key: string) =>
    setOperating((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })

  const rebuildIndex = async (item: CodeIndexSummary) => {
    markOperating(item.key)
    try {
      await api.rebuildCodeIndex(item.dir)
      showSuccess(`已触发重建「${basename(item.dir)}」`)
      // 等一下再刷新，让首扫有时间推进
      setTimeout(() => void load(), 800)
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      unmarkOperating(item.key)
    }
  }

  const deleteIndex = async () => {
    if (!deleteTarget) return
    markOperating(deleteTarget.key)
    try {
      await api.deleteCodeIndex(deleteTarget.dir)
      showSuccess(`已删除「${basename(deleteTarget.dir)}」`)
      await load()
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      unmarkOperating(deleteTarget.key)
      setDeleteTarget(undefined)
    }
  }

  const rebuildAll = async () => {
    for (const item of indexes) {
      markOperating(item.key)
      try {
        await api.rebuildCodeIndex(item.dir)
      } catch {
        /* 单个失败不阻断 */
      }
    }
    showSuccess('已触发全部重建')
    setTimeout(() => void load(), 800)
    setOperating(new Set())
  }

  const clearAll = async () => {
    for (const item of indexes) {
      markOperating(item.key)
      try {
        await api.deleteCodeIndex(item.dir)
      } catch {
        /* 单个失败不阻断 */
      }
    }
    showSuccess('已清除全部索引')
    await load()
    setOperating(new Set())
    setClearAllOpen(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-foreground">代码索引</h3>
          <p className="text-[11px] leading-5 text-muted-foreground">
            源码符号索引是 codebase_search 工具的数据源，在对话或任务中自动创建；此处可查看、重建或删除。
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={indexes.length === 0 || operating.size > 0}
            onClick={() => void rebuildAll()}
          >
            {operating.size > 0 ? <Loader2Icon className="animate-spin-slow" size={11} /> : <RefreshCwIcon size={11} />}
            全部重建
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={indexes.length === 0 || operating.size > 0}
            onClick={() => setClearAllOpen(true)}
          >
            <Trash2Icon size={11} />
            全部清除
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid place-items-center py-10 text-xs text-muted-foreground">
          <Loader2Icon className="animate-spin-slow" size={14} />
        </div>
      ) : indexes.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          还没有索引数据。在对话中使用 codebase_search 或开始任务时会自动创建索引。
        </div>
      ) : (
        <div className="space-y-2">
          {indexes.map((item) => (
            <IndexCard
              key={item.key}
              item={item}
              operating={operating.has(item.key)}
              onRebuild={() => void rebuildIndex(item)}
              onDelete={() => setDeleteTarget(item)}
            />
          ))}
        </div>
      )}

      {/* 删除确认 */}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除索引？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleteTarget ? basename(deleteTarget.dir) : ''}」的索引数据库（{deleteTarget?.dbPath}），
              删除后不影响源码，下次使用时会自动重建。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void deleteIndex()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 全部清除确认 */}
      <AlertDialog open={clearAllOpen} onOpenChange={setClearAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清除全部索引？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除所有 {indexes.length} 个索引数据库，不影响源码文件。下次使用时会自动重建。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void clearAll()}>全部清除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function IndexCard({
  item,
  operating,
  onRebuild,
  onDelete
}: {
  item: CodeIndexSummary
  operating: boolean
  onRebuild: () => void
  onDelete: () => void
}) {
  const name = basename(item.dir)
  const statusBadge = item.indexing ? (
    <Badge variant="secondary" style={{ fontSize: '10px' }}>
      <Loader2Icon className="animate-spin-slow" size={9} />
      索引中
    </Badge>
  ) : (
    <Badge variant="success" style={{ fontSize: '10px' }}>
      正常
    </Badge>
  )

  return (
    <article className="group flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <FolderOpenIcon size={14} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <h4 className="max-w-[280px] truncate text-xs font-semibold text-foreground">{name}</h4>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[480px] text-[11px]">
                {item.dir}
              </TooltipContent>
            </Tooltip>
            {statusBadge}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{formatNumber(item.nodeCount)} 符号</span>
            <span>·</span>
            <span>{formatNumber(item.fileCount)} 文件</span>
            <span>·</span>
            <span>{formatBytes(item.dbSizeBytes)}</span>
            {item.languages.length > 0 && (
              <>
                <span>·</span>
                <span>{item.languages.join(', ')}</span>
              </>
            )}
            {item.createdAt && (
              <>
                <span>·</span>
                <DatabaseIcon size={9} className="shrink-0" />
                <span>{new Date(item.createdAt).toLocaleDateString()}</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`重建索引 ${name}`}
          disabled={operating}
          className="shrink-0"
          onClick={onRebuild}
        >
          {operating ? <Loader2Icon className="animate-spin-slow" size={11} /> : <RefreshCwIcon size={11} />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`删除索引 ${name}`}
          disabled={operating}
          className="shrink-0 text-destructive opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
          onClick={onDelete}
        >
          <Trash2Icon size={11} />
        </Button>
      </div>
    </article>
  )
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}
