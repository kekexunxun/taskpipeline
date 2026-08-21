import { useState } from 'react'
import { Link2Icon, Loader2Icon } from 'lucide-react'
import { api } from '@/api'
import { useFeedback } from '@/hooks/useGlobalFeedback'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export function JiraDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onImported(): void
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const { showError } = useFeedback()

  const doImport = async () => {
    setBusy(true)
    try {
      await api.importJiraTask(key.trim())
      onImported()
      onOpenChange(false)
      setKey('')
    } catch (reason) {
      // 主进程拒绝（如 Token 失效）时弹 toast，避免静默失败。
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
      setConflict(false)
    }
  }

  const onImportClick = async () => {
    const trimmed = key.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      const { conflict: hasConflict } = await api.checkJiraTaskExists(trimmed)
      if (hasConflict) {
        setConflict(true)
        return
      }
      await doImport()
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      // 仅在冲突弹窗显示时保留 busy；否则复位。
      if (!conflict) setBusy(false)
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (busy) return
          onOpenChange(v)
          if (!v) {
            setKey('')
            setConflict(false)
          }
        }}
      >
        <DialogContent
          onPointerDownOutside={(e) => busy && e.preventDefault()}
          onEscapeKeyDown={(e) => busy && e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>从 Jira 导入</DialogTitle>
            <DialogDescription>支持 Jira Key 或 Issue 浏览链接。</DialogDescription>
          </DialogHeader>
          <div className="px-1">
            <Field label="Jira Key / URL">
              <Input
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={key}
                onChange={(event) => {
                  setKey(event.target.value)
                  setConflict(false)
                }}
                placeholder="PAY-1842 或 https://..."
              />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" size="sm" disabled={busy}>
                取消
              </Button>
            </DialogClose>
            <Button size="sm" disabled={!key.trim() || busy} onClick={() => void onImportClick()}>
              {busy ? <Loader2Icon className="animate-spin-slow" size={11} /> : <Link2Icon size={11} />}
              {busy ? '导入中…' : '导入'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={conflict}
        onOpenChange={(v) => {
          if (!v) {
            setConflict(false)
            setBusy(false)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              覆盖已存在的任务？
              <Badge variant="warning" className="ml-2 h-4 px-1 text-[10px]">
                已存在 · 导入将覆盖
              </Badge>
            </AlertDialogTitle>
            <AlertDialogDescription>
              该任务已存在于系统中且不在待办列表，导入将用 Jira 的最新内容覆盖其标题、描述与关键词。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80 dark:bg-input dark:text-foreground dark:hover:bg-input/80"
              onClick={() => {
                setConflict(false)
                void doImport()
              }}
            >
              确认覆盖
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
