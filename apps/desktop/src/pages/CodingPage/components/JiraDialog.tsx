import { useState } from 'react'
import { Link2Icon, Loader2Icon } from 'lucide-react'
import { api } from '@/api'
import { useFeedback } from '@/hooks/useGlobalFeedback'
import { Button } from '@/components/ui/button'
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
  const { showError } = useFeedback()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>从 Jira 导入</DialogTitle>
          <DialogDescription>支持 Jira Key 或 Issue 浏览链接。</DialogDescription>
        </DialogHeader>
        <div className="px-1">
          <Field label="Jira Key / URL">
            <Input
              autoFocus
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="PAY-1842 或 https://..."
            />
          </Field>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              取消
            </Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={!key.trim() || busy}
            onClick={async () => {
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
              }
            }}
          >
            {busy ? <Loader2Icon className="animate-spin-slow" size={11} /> : <Link2Icon size={11} />}
            导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
