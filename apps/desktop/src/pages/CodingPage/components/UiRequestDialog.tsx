import { useEffect, useState } from 'react'
import { api } from '@/api'
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
type UiRequest = {
  id: string
  method: 'confirm' | 'select' | 'input' | 'editor'
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
}
/**
 * 执行器 UI 请求对话框。
 *
 * 主进程 pendingUi 是 Map（支持并发等待），渲染进程用队列逐个展示：
 * 并发到达的确认请求排队显示，避免新请求覆盖旧请求导致旧的只能等超时（默认拒绝）。
 * 协议字段以主进程 requestUi 为准：事件带 `id`（响应时回传）与 `title/message/options`。
 */
export function UiRequestDialog() {
  const [queue, setQueue] = useState<UiRequest[]>([])
  const [responding, setResponding] = useState(false)
  const request = queue[0]
  useEffect(() => {
    const ask = (event: Event) => {
      const detail = (event as CustomEvent<UiRequest>).detail
      if (!detail?.id) return
      setQueue((items) => [...items, detail])
    }
    // 任务中止 / 会话结束时清空残留的确认请求（主进程 stopPi 已全部按取消处理）。
    const clear = () => setQueue([])
    window.addEventListener('task:ui-request', ask)
    window.addEventListener('task:ui-clear', clear)
    return () => {
      window.removeEventListener('task:ui-request', ask)
      window.removeEventListener('task:ui-clear', clear)
    }
  }, [])
  const respond = async (response: Record<string, unknown>) => {
    if (!request || responding) return
    setResponding(true)
    try {
      await api.respondTaskUi({ id: request.id, ...response })
    } finally {
      setResponding(false)
      setQueue((items) => items.slice(1))
    }
  }
  if (!request) return null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void respond({ confirmed: false })
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request.title ?? '执行器请求'}</DialogTitle>
          <DialogDescription className="max-h-[40vh] overflow-auto break-all whitespace-pre-wrap">
            {request.message ?? '执行器需要你的选择才能继续。'}
          </DialogDescription>
        </DialogHeader>
        {request.method === 'select' && (
          <div className="flex flex-wrap gap-2 px-6 pb-6">
            {request.options?.map((option) => (
              <Button variant="secondary" key={option} onClick={() => void respond({ value: option })}>
                {option}
              </Button>
            ))}
          </div>
        )}
        {request.method === 'input' && (
          <div className="px-6 pb-6">
            <InputRequest
              key={request.id}
              placeholder={request.placeholder}
              onSubmit={(value) => void respond({ value })}
            />
          </div>
        )}
        {request.method === 'editor' && (
          <div className="px-6 pb-6">
            <EditorRequest key={request.id} prefill={request.prefill} onSubmit={(value) => void respond({ value })} />
          </div>
        )}
        {request.method === 'confirm' && (
          <DialogFooter>
            <Button variant="secondary" onClick={() => void respond({ confirmed: false })}>
              拒绝
            </Button>
            <Button onClick={() => void respond({ confirmed: true })}>允许</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
function InputRequest({ placeholder, onSubmit }: { placeholder?: string; onSubmit(value: string): void }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex w-full gap-2">
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit(value)
        }}
      />
      <Button disabled={!value.trim()} onClick={() => onSubmit(value)}>
        确认
      </Button>
    </div>
  )
}
function EditorRequest({ prefill, onSubmit }: { prefill?: string; onSubmit(value: string): void }) {
  const [value, setValue] = useState(prefill ?? '')
  return (
    <div className="flex w-full flex-col gap-2">
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={8}
        className="thin-scrollbar w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
        placeholder="在此编辑内容…"
      />
      <Button disabled={!value.trim()} onClick={() => onSubmit(value)}>
        保存
      </Button>
    </div>
  )
}
